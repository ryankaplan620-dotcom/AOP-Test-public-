/**
 * routes/webhooks.js — the Webhook Receiver Engine (Shopify).
 *
 * Role in the AOP data flow (three topics, one HMAC gate):
 *   [orders/create]    --> stitch to agent_intent_logs (attribution)
 *     --> INSERT reconciled_agent_orders (DB computes the 0.5% commission
 *         in its generated column; ON CONFLICT makes redelivery idempotent).
 *   [refunds/create]   --> INSERT order_adjustments crediting back the
 *         refunded GMV's commission share (migration 0008 ledger).
 *   [orders/cancelled] --> INSERT order_adjustments crediting everything
 *         still creditable on the order.
 *   The credit paths keep billing honest: a commission charged at
 *   reconciliation is reversed when the money goes back to the buyer —
 *   statements net the two ledgers (getBillingStatement).
 *
 * RAW-BODY INVARIANT (load-bearing): this router is mounted in src/app.js
 * BEFORE express.json(), and uses express.raw() itself, because Shopify's
 * HMAC signs the exact bytes it sent. Any JSON parse -> re-stringify cycle
 * (key reordering, unicode normalization, whitespace) breaks byte-exactness
 * and every webhook would fail verification.
 *
 * Response-code policy (Shopify retries non-2xx deliveries for ~48h and
 * penalizes chronically failing endpoints):
 *   - 401  ONLY for HMAC failures — an unauthenticated caller gets nothing
 *          else, and Shopify retrying a forged request is not our problem.
 *   - 200  for every business-level "can't attribute this" case (missing
 *          token, unknown merchant, unparseable-but-authentic payload):
 *          redelivering the SAME bytes can never change those outcomes, so
 *          asking for a retry would just generate retry-storm noise. Log and
 *          acknowledge.
 *   - 500  ONLY for genuinely transient faults (PostgreSQL down): here a
 *          retry CAN succeed, and losing a billable order to a DB blip is
 *          the one thing this engine must never do. Idempotency via
 *          ON CONFLICT (shopify_order_id) makes those retries safe.
 */

import express from 'express';
import { verifyShopifyHmac } from '../lib/shopify-hmac.js';
import { parseMoneyToCents, formatCentsAsDecimal } from '../lib/commission.js';
import {
  findMerchantByShopDomain,
  findLatestIntentByToken,
  insertReconciledOrder,
  insertOrderAdjustment,
} from '../repositories.js';

/** The note_attributes/attributes key agents echo the edge token under. */
export const TOKEN_ATTRIBUTE_NAME = 'aop_transaction_token';

/**
 * Pull the AOP transaction token out of a parsed Shopify order.
 *
 * Primary location: order.note_attributes — an ARRAY of {name, value} pairs
 * (Shopify's cart-attributes representation on orders). Fallback:
 * order.attributes, which some checkout integrations emit either as the same
 * pair-array or as a flat {key: value} map — both shapes are handled.
 * Returns null when absent; never throws on hostile shapes.
 *
 * @param {unknown} order
 * @returns {string|null}
 */
function extractTransactionToken(order) {
  try {
    if (order === null || typeof order !== 'object') return null;

    const fromPairArray = (list) => {
      if (!Array.isArray(list)) return null;
      // Bounded scan: note_attributes is small in practice; 100 is paranoia.
      for (const entry of list.slice(0, 100)) {
        if (entry !== null && typeof entry === 'object' && entry.name === TOKEN_ATTRIBUTE_NAME) {
          const value = typeof entry.value === 'string' ? entry.value.trim() : '';
          if (value !== '') return value;
        }
      }
      return null;
    };

    const fromNoteAttributes = fromPairArray(order.note_attributes);
    if (fromNoteAttributes !== null) return fromNoteAttributes;

    const attributes = order.attributes;
    const fromAttributesArray = fromPairArray(attributes);
    if (fromAttributesArray !== null) return fromAttributesArray;
    if (attributes !== null && typeof attributes === 'object' && !Array.isArray(attributes)) {
      const value = attributes[TOKEN_ATTRIBUTE_NAME];
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Coerce a Shopify identifier (numeric REST id or GraphQL GID string) to a
 * bounded string, or null. Only string/number are honored — an object would
 * stringify to "[object Object]" and poison idempotency keys.
 *
 * @param {unknown} value
 * @param {number} [maxLength]
 * @returns {string|null}
 */
function parseShopifyId(value, maxLength = 100) {
  let id = null;
  if (typeof value === 'number' && Number.isFinite(value)) id = String(value);
  else if (typeof value === 'string' && value.trim() !== '') id = value.trim();
  return id !== null && id.length <= maxLength ? id : null;
}

/**
 * ISO-4217-shaped currency code from a Shopify payload field, or null.
 * Shape check only (3 ASCII letters, uppercased) — a full currency table
 * would go stale; the DB CHECK enforces the same shape (migration 0010).
 */
function parseCurrency(value) {
  return typeof value === 'string' && /^[A-Za-z]{3}$/.test(value.trim())
    ? value.trim().toUpperCase()
    : null;
}

/**
 * The shared webhook gate: HMAC-verify the RAW bytes, parse JSON, resolve the
 * merchant from X-Shopify-Shop-Domain. Sends the response itself on every
 * failure path (per the response-code policy in the module header) and
 * returns null; returns {payload, shopDomain, merchant} when the caller
 * should proceed with topic-specific logic.
 */
async function gateShopifyWebhook(req, res, { config, db, logger }) {
  // --- authenticity gate (the ONLY 401 path) ------------------------------
  const hmacHeader = req.get('x-shopify-hmac-sha256');
  if (!verifyShopifyHmac(req.body, hmacHeader, config.shopifyWebhookSecret)) {
    logger.warn('shopify webhook rejected: HMAC verification failed', {
      has_header: typeof hmacHeader === 'string',
      path: req.path,
    });
    res.status(401).json({ error: 'invalid webhook signature' });
    return null;
  }

  // --- parse (bytes are now authenticated) --------------------------------
  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch {
    // Authentic but unparseable — the same bytes will fail the same way on
    // every retry, so acknowledge and log loudly instead of triggering
    // Shopify's retry storm.
    logger.error('shopify webhook body failed JSON parse despite valid HMAC', { path: req.path });
    res.status(200).json({ ok: true, action: 'ignored_unparseable_body' });
    return null;
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    logger.error('shopify webhook payload is not an object; ignoring', { path: req.path });
    res.status(200).json({ ok: true, action: 'ignored_malformed_payload' });
    return null;
  }

  // --- merchant resolution ------------------------------------------------
  // The shop domain header is trustworthy at this point: it is part of the
  // signed request context of a webhook whose HMAC verified.
  const shopDomain = (req.get('x-shopify-shop-domain') ?? '').trim();
  if (shopDomain === '') {
    logger.warn('shopify webhook missing X-Shopify-Shop-Domain; cannot attribute', { path: req.path });
    res.status(200).json({ ok: true, action: 'ignored_missing_shop_domain' });
    return null;
  }
  const merchant = await findMerchantByShopDomain(db, shopDomain);
  if (merchant === null) {
    // Not onboarded (or already offboarded). Retrying won't change it on
    // Shopify's timescale — acknowledge, keep a forensic trail.
    logger.warn('shopify webhook for unknown merchant; skipping', {
      shop_domain: shopDomain,
      path: req.path,
    });
    res.status(200).json({ ok: true, action: 'skipped_unknown_merchant' });
    return null;
  }

  return { payload, shopDomain, merchant };
}

/**
 * Total refunded amount of a refunds/create payload, in integer cents.
 *
 * Primary source: refund.transactions — the money actually moved back to the
 * buyer (kind 'refund'; status defaults to success when absent, and 'failure'
 * / 'error' rows are excluded so a failed refund attempt never credits).
 * Fallback: refund_line_items[].subtotal (older payloads / restock-only
 * shapes). Returns null when no parseable amount exists, 0 for an explicit
 * zero-money refund (restock without payment movement).
 */
function refundedCents(refund) {
  const transactions = Array.isArray(refund?.transactions) ? refund.transactions : [];
  let total = 0;
  let sawTransaction = false;
  for (const tx of transactions.slice(0, 100)) {
    if (tx === null || typeof tx !== 'object') continue;
    if (tx.kind !== 'refund') continue;
    const status = typeof tx.status === 'string' ? tx.status : 'success';
    if (status !== 'success') continue;
    const cents = parseMoneyToCents(tx.amount);
    if (cents === null) continue;
    sawTransaction = true;
    total += cents;
  }
  if (sawTransaction) return total;

  const lineItems = Array.isArray(refund?.refund_line_items) ? refund.refund_line_items : [];
  let lineTotal = 0;
  let sawLine = false;
  for (const line of lineItems.slice(0, 250)) {
    if (line === null || typeof line !== 'object') continue;
    const cents = parseMoneyToCents(line.subtotal);
    if (cents === null) continue;
    sawLine = true;
    lineTotal += cents;
  }
  return sawLine ? lineTotal : null;
}

/**
 * Build the webhooks router.
 *
 * @param {{config: object, db: object, logger: object}} deps
 * @returns {express.Router}
 */
export function buildWebhooksRouter({ config, db, logger }) {
  const router = express.Router();

  // Raw body capture — MUST run before any JSON parser (see header). 1mb
  // bound: real payloads are tens of KB; anything bigger is not Shopify.
  // Content-Type-scoped to application/json exactly as Shopify sends it; a
  // caller with another content type simply gets no parsed body and fails
  // HMAC in the gate (fail closed).
  const rawJson = express.raw({ type: 'application/json', limit: '1mb' });

  router.post(
    '/shopify/orders-create',
    rawJson,
    async (req, res, next) => {
      try {
        const gate = await gateShopifyWebhook(req, res, { config, db, logger });
        if (gate === null) return;
        const { payload: order, shopDomain, merchant } = gate;

        // Order identifier: numeric REST id preferred, GraphQL GID fallback.
        // Max 100 chars — the shopify_order_id column width.
        const shopifyOrderId =
          parseShopifyId(order.id) ?? parseShopifyId(order.admin_graphql_api_id);
        if (shopifyOrderId === null) {
          logger.error('shopify webhook order missing/invalid id; ignoring');
          res.status(200).json({ ok: true, action: 'ignored_missing_order_id' });
          return;
        }

        // --- attribution token ------------------------------------------
        const token = extractTransactionToken(order);
        if (token === null) {
          // A non-agent (human) order, or an agent that dropped the token:
          // by definition NOT attributable to agent traffic — no commission
          // row. Business-as-usual, not an error to Shopify.
          logger.info('shopify order carries no aop_transaction_token; not agent-attributed', {
            shop_domain: shopDomain,
            shopify_order_id: shopifyOrderId,
          });
          res.status(200).json({ ok: true, action: 'no_transaction_token' });
          return;
        }
        if (token.length > 255) {
          // Edge-minted tokens are far shorter; an oversized value would
          // overflow transaction_token VARCHAR(255) and can never match an
          // intent row anyway — treat as unattributable, not as an error.
          logger.warn('aop_transaction_token exceeds 255 chars; treating order as unattributed', {
            shopify_order_id: shopifyOrderId,
          });
          res.status(200).json({ ok: true, action: 'ignored_invalid_token' });
          return;
        }

        // --- GMV ---------------------------------------------------------
        // Validated through the exact money parser (never floats). Shopify
        // sends total_price as a decimal string; the DB column is
        // NUMERIC(12,2), so we forward a normalized decimal string.
        const gmvCents = parseMoneyToCents(order.total_price);
        if (gmvCents === null) {
          logger.error('shopify order total_price unparseable; order NOT reconciled', {
            shop_domain: shopDomain,
            shopify_order_id: shopifyOrderId,
            total_price_type: typeof order.total_price,
          });
          res.status(200).json({ ok: true, action: 'ignored_unparseable_total' });
          return;
        }
        const gmvDecimal = `${Math.floor(gmvCents / 100)}.${String(gmvCents % 100).padStart(2, '0')}`;

        // --- attribution stitch ------------------------------------------
        const intent = await findLatestIntentByToken(db, merchant.id, token);
        // No matching intent is NOT a drop-the-order case: the token itself
        // proves the edge minted it for agent traffic. This is the "late
        // webhook" edge case the schema explicitly supports — the order is
        // reconciled on the token alone with intent_log_id = NULL (see
        // db/migrations/0004 comments), and the row survives telemetry
        // retention pruning either way.
        if (intent === null) {
          logger.warn('no matching intent for transaction token; reconciling on token alone', {
            shop_domain: shopDomain,
            shopify_order_id: shopifyOrderId,
          });
        }

        const { inserted, row } = await insertReconciledOrder(db, {
          merchantId: merchant.id,
          intentLogId: intent === null ? null : intent.id,
          shopifyOrderId,
          transactionToken: token,
          gmv: gmvDecimal,
          // ISO-4217 code from the order payload (migration 0010); null when
          // Shopify ever omits/mangles it — visibly unknown beats wrong.
          currency: parseCurrency(order.currency),
        });

        if (!inserted) {
          // ON CONFLICT fired: Shopify redelivered a webhook we already
          // billed. The UNIQUE constraint is the idempotency backstop —
          // acknowledge so redelivery stops.
          logger.info('shopify order already reconciled (webhook redelivery)', {
            shopify_order_id: shopifyOrderId,
          });
          res.status(200).json({ ok: true, action: 'already_reconciled' });
          return;
        }

        logger.info('order reconciled to agent intent', {
          shop_domain: shopDomain,
          shopify_order_id: shopifyOrderId,
          attributed_intent: intent === null ? null : intent.id,
          gmv: gmvDecimal,
          // commission_fee comes back from the DB generated column —
          // reporting only; the column itself is the billing truth.
          commission_fee: row?.commission_fee ?? null,
        });
        res.status(200).json({ ok: true, action: 'reconciled' });
      } catch (err) {
        // Transient faults (DB down, pool timeout): 5xx so Shopify redelivers
        // once we recover — see response-code policy in the header comment.
        next(err);
      }
    }
  );

  /**
   * Shared tail for the two credit topics: run the ledger insert and map its
   * status onto the response-code policy (all business outcomes are 200; the
   * catch block upstream keeps 5xx for genuinely transient faults).
   */
  async function respondWithAdjustment(res, log, adjustment) {
    const { status, row } = await insertOrderAdjustment(db, adjustment);
    if (status === 'credited') {
      logger.info('billing credit recorded', {
        ...log,
        adjusted_gmv: row?.adjusted_gmv ?? null,
        commission_credit: row?.commission_credit ?? null,
      });
      res.status(200).json({ ok: true, action: 'credited' });
      return;
    }
    if (status === 'duplicate') {
      // Webhook redelivery — the UNIQUE(source_event_id) backstop fired.
      logger.info('billing credit already recorded (webhook redelivery)', log);
      res.status(200).json({ ok: true, action: 'already_credited' });
      return;
    }
    if (status === 'order_not_found') {
      // Refund/cancel of an order that was never agent-attributed: nothing
      // was billed, nothing to credit. Business-as-usual, not an error.
      logger.info('adjustment for non-attributed order; no commission to credit', log);
      res.status(200).json({ ok: true, action: 'order_not_attributed' });
      return;
    }
    // nothing_remaining: the order is already fully credited (e.g. cancelled
    // after a full refund) — the ledger clamp held the line.
    logger.info('adjustment skipped: order already fully credited', log);
    res.status(200).json({ ok: true, action: 'already_fully_credited' });
  }

  // ---- POST /shopify/refunds-create ---------------------------------------
  router.post(
    '/shopify/refunds-create',
    rawJson,
    async (req, res, next) => {
      try {
        const gate = await gateShopifyWebhook(req, res, { config, db, logger });
        if (gate === null) return;
        const { payload: refund, shopDomain, merchant } = gate;

        const refundId = parseShopifyId(refund.id);
        const orderId =
          parseShopifyId(refund.order_id) ?? parseShopifyId(refund.admin_graphql_api_id, 100);
        if (refundId === null || orderId === null) {
          logger.error('shopify refund webhook missing refund/order id; ignoring', {
            shop_domain: shopDomain,
          });
          res.status(200).json({ ok: true, action: 'ignored_missing_ids' });
          return;
        }

        const cents = refundedCents(refund);
        if (cents === null) {
          logger.error('shopify refund carries no parseable amount; NOT credited', {
            shop_domain: shopDomain,
            shopify_order_id: orderId,
          });
          res.status(200).json({ ok: true, action: 'ignored_unparseable_amount' });
          return;
        }
        if (cents === 0) {
          // Restock-only refund: no money moved, no commission to reverse.
          res.status(200).json({ ok: true, action: 'ignored_zero_amount' });
          return;
        }

        await respondWithAdjustment(
          res,
          { shop_domain: shopDomain, shopify_order_id: orderId, refund_id: refundId },
          {
            merchantId: merchant.id,
            shopifyOrderId: orderId,
            sourceEventId: `refund:${refundId}`,
            kind: 'REFUND',
            requestedGmv: formatCentsAsDecimal(cents) ?? '0.00',
          }
        );
      } catch (err) {
        next(err);
      }
    }
  );

  // ---- POST /shopify/orders-cancelled -------------------------------------
  router.post(
    '/shopify/orders-cancelled',
    rawJson,
    async (req, res, next) => {
      try {
        const gate = await gateShopifyWebhook(req, res, { config, db, logger });
        if (gate === null) return;
        const { payload: order, shopDomain, merchant } = gate;

        const shopifyOrderId =
          parseShopifyId(order.id) ?? parseShopifyId(order.admin_graphql_api_id);
        if (shopifyOrderId === null) {
          logger.error('shopify cancellation webhook missing order id; ignoring', {
            shop_domain: shopDomain,
          });
          res.status(200).json({ ok: true, action: 'ignored_missing_order_id' });
          return;
        }

        // requestedGmv null = credit everything still creditable: partial
        // refunds that preceded the cancellation stay counted exactly once
        // (the ledger clamp subtracts them from the remainder).
        await respondWithAdjustment(
          res,
          { shop_domain: shopDomain, shopify_order_id: shopifyOrderId },
          {
            merchantId: merchant.id,
            shopifyOrderId,
            sourceEventId: `cancel:${shopifyOrderId}`,
            kind: 'CANCELLATION',
            requestedGmv: null,
          }
        );
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
