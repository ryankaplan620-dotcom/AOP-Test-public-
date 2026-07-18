/**
 * routes/webhooks.js — the Webhook Receiver Engine (Shopify order-created).
 *
 * Role in the AOP data flow:
 *   [Shopify orders/create webhook] --> THIS ROUTE
 *     --> HMAC verify against RAW bytes (src/lib/shopify-hmac.js)
 *     --> extract aop_transaction_token from note_attributes/attributes
 *     --> resolve merchant (X-Shopify-Shop-Domain header)
 *     --> stitch to the latest matching agent_intent_logs row (attribution)
 *     --> INSERT reconciled_agent_orders (DB computes the 0.5% commission
 *         in its generated column; ON CONFLICT makes redelivery idempotent).
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
import { parseMoneyToCents } from '../lib/commission.js';
import { findMerchantByShopDomain, findLatestIntentByToken, insertReconciledOrder } from '../repositories.js';

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
 * Build the webhooks router.
 *
 * @param {{config: object, db: object, logger: object}} deps
 * @returns {express.Router}
 */
export function buildWebhooksRouter({ config, db, logger }) {
  const router = express.Router();

  router.post(
    '/shopify/orders-create',
    // Raw body capture — MUST run before any JSON parser (see header).
    // 1mb bound: real order payloads are tens of KB; anything bigger is not
    // a Shopify order. Content-Type-scoped to application/json exactly as
    // Shopify sends it; a caller with another content type simply gets no
    // parsed body and fails HMAC below (fail closed).
    express.raw({ type: 'application/json', limit: '1mb' }),
    async (req, res, next) => {
      try {
        // --- authenticity gate (the ONLY 401 path) ----------------------
        const hmacHeader = req.get('x-shopify-hmac-sha256');
        if (!verifyShopifyHmac(req.body, hmacHeader, config.shopifyWebhookSecret)) {
          logger.warn('shopify webhook rejected: HMAC verification failed', {
            has_header: typeof hmacHeader === 'string',
          });
          res.status(401).json({ error: 'invalid webhook signature' });
          return;
        }

        // --- parse (bytes are now authenticated) ------------------------
        let order;
        try {
          order = JSON.parse(req.body.toString('utf8'));
        } catch {
          // Authentic but unparseable — the same bytes will fail the same
          // way on every retry, so acknowledge and log loudly instead of
          // triggering Shopify's retry storm.
          logger.error('shopify webhook body failed JSON parse despite valid HMAC');
          res.status(200).json({ ok: true, action: 'ignored_unparseable_body' });
          return;
        }
        if (order === null || typeof order !== 'object' || Array.isArray(order)) {
          logger.error('shopify webhook payload is not an object; ignoring');
          res.status(200).json({ ok: true, action: 'ignored_malformed_payload' });
          return;
        }

        // Order identifier: numeric REST id preferred, GraphQL GID fallback.
        // Only string/number are honored (an object would stringify to
        // "[object Object]" and poison the idempotency key). Max 100 chars —
        // the reconciled_agent_orders.shopify_order_id column width.
        let shopifyOrderId = null;
        if (typeof order.id === 'number' && Number.isFinite(order.id)) {
          shopifyOrderId = String(order.id);
        } else if (typeof order.id === 'string' && order.id.trim() !== '') {
          shopifyOrderId = order.id.trim();
        } else if (typeof order.admin_graphql_api_id === 'string' && order.admin_graphql_api_id.trim() !== '') {
          shopifyOrderId = order.admin_graphql_api_id.trim();
        }
        if (shopifyOrderId === null || shopifyOrderId.length > 100) {
          logger.error('shopify webhook order missing/invalid id; ignoring');
          res.status(200).json({ ok: true, action: 'ignored_missing_order_id' });
          return;
        }

        // --- merchant resolution ----------------------------------------
        // The shop domain header is trustworthy at this point: it is part of
        // the signed request context of a webhook whose HMAC verified.
        const shopDomain = (req.get('x-shopify-shop-domain') ?? '').trim();
        if (shopDomain === '') {
          logger.warn('shopify webhook missing X-Shopify-Shop-Domain; cannot attribute', {
            shopify_order_id: shopifyOrderId,
          });
          res.status(200).json({ ok: true, action: 'ignored_missing_shop_domain' });
          return;
        }
        const merchant = await findMerchantByShopDomain(db, shopDomain);
        if (merchant === null) {
          // Not onboarded (or already offboarded). Retrying won't change it
          // on Shopify's timescale — acknowledge, keep a forensic trail.
          logger.warn('shopify webhook for unknown merchant; skipping', {
            shop_domain: shopDomain,
            shopify_order_id: shopifyOrderId,
          });
          res.status(200).json({ ok: true, action: 'skipped_unknown_merchant' });
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

  return router;
}
