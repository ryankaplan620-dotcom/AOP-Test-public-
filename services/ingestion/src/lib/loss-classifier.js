/**
 * lib/loss-classifier.js — heuristic drop-off classification for expired intents.
 *
 * Role in the AOP data flow:
 *   The sweep job (src/jobs/loss-sweep.js) finds agent_intent_logs rows whose
 *   60-second conversion window elapsed with no matching row in
 *   reconciled_agent_orders, hands each row to classifyLoss(), and writes the
 *   verdict into loss_diagnostics — the table behind the merchant dashboard's
 *   "why do AI agents look at my product and then not buy?" analytics.
 *
 * Input shape:
 *   A DB row from agent_intent_logs. The interesting field is inbound_payload
 *   (JSONB): the (redacted) agent request body captured at the edge, which the
 *   ingestion layer enriches with an `_edge` object carrying transport facts
 *   ({status, latency_ms, query, observed_at}) — see src/lib/validate-telemetry.js.
 *
 * Defensive contract:
 *   inbound_payload is ATTACKER-ADJACENT data (agents send arbitrary JSON and
 *   the edge forwards it nearly verbatim). Every accessor below therefore
 *   assumes any field can be missing, null, the wrong type, or hostile
 *   (Proxy traps, absurd nesting). classifyLoss() NEVER throws and always
 *   returns a complete verdict — a classification failure must cost at most
 *   one UNKNOWN_DROPOFF row, never a sweep crash.
 *
 * Classification priority (first match wins; documented so dashboards can
 * explain multi-signal rows):
 *   1. PROTOCOL_ERROR   — the edge logged a non-2xx origin status: the agent
 *                         never got a usable answer, so any in-payload signal
 *                         (price, stock...) was moot.
 *   2. STOCK_OUTAGE     — the requested variant/size/SKU was unavailable: an
 *                         absolute blocker, outranks price/shipping signals.
 *   3. PRICE_DISCREPANCY— a competitor/benchmark price in the payload undercuts
 *                         ours: the classic agent-comparison loss.
 *   4. SHIPPING_LATENCY — quoted delivery slower than the 3-day agent-commerce
 *                         expectation, or a shipping_quote flagged slow.
 *   5. POLICY_AMBIGUITY — payload flags returns/policy ambiguity; agents abort
 *                         rather than accept unclear terms.
 *   6. UNKNOWN_DROPOFF  — fallback; still recorded (an unexplained loss is a
 *                         data point, not a non-event).
 *
 * PURE module: no express/pg imports, no I/O — unit-tested pre-`npm install`
 * by test/loss-classifier.test.mjs.
 */

import { parseMoneyToCents } from './commission.js';

/** Delivery-days ceiling agents tolerate before abandoning (product heuristic). */
export const SHIPPING_LATENCY_THRESHOLD_DAYS = 3;

/** Closed vocabulary — mirrors the CHECK constraint on loss_diagnostics. */
export const LOSS_REASONS = Object.freeze({
  PRICE_DISCREPANCY: 'PRICE_DISCREPANCY',
  SHIPPING_LATENCY: 'SHIPPING_LATENCY',
  STOCK_OUTAGE: 'STOCK_OUTAGE',
  POLICY_AMBIGUITY: 'POLICY_AMBIGUITY',
  PROTOCOL_ERROR: 'PROTOCOL_ERROR',
  UNKNOWN_DROPOFF: 'UNKNOWN_DROPOFF',
});

/* ------------------------------------------------------------------------- *
 * Defensive accessors                                                       *
 * ------------------------------------------------------------------------- */

/** True for a plain-ish object we can safely read keys from. */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Property read that survives hostile getters/Proxies. */
function safeGet(obj, key) {
  try {
    if (!isObject(obj)) return undefined;
    return obj[key];
  } catch {
    return undefined;
  }
}

/** Lower-cased trimmed string, or null. */
function asLowerString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().toLowerCase() : null;
}

/**
 * Money field -> integer cents via the shared exact parser (accepts decimal
 * strings and finite numbers; null for anything else).
 */
function asCents(value) {
  return parseMoneyToCents(value);
}

/** Finite non-negative number, or null. Strings like "5" are accepted. */
function asNonNegativeNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

/**
 * First parseable cents value among a list of keys on an object.
 * Returns {cents, field} so evidence payloads can cite their source.
 */
function firstCentsField(obj, keys) {
  for (const key of keys) {
    const cents = asCents(safeGet(obj, key));
    if (cents !== null) return { cents, field: key };
  }
  return null;
}

/* ------------------------------------------------------------------------- *
 * Signal extraction                                                          *
 * ------------------------------------------------------------------------- */

/**
 * The HTTP status the edge proxy observed from the origin, if the enriched
 * payload carries one. A bare `payload.status` is trusted only when it looks
 * like an actual HTTP status code — agents also use "status" for strings like
 * "out_of_stock", which must not be mistaken for transport data.
 */
function extractEdgeStatus(payload) {
  const candidates = [
    safeGet(safeGet(payload, '_edge'), 'status'), // canonical (validate-telemetry.js)
    safeGet(safeGet(payload, 'edge'), 'status'), // legacy/foreign producers
    safeGet(payload, 'status'),
  ];
  for (const candidate of candidates) {
    if (Number.isInteger(candidate) && candidate >= 100 && candidate <= 599) return candidate;
  }
  return null;
}

/** Field-name conventions for OUR product's price across ACP/AP2 payloads. */
const OUR_PRICE_KEYS = ['our_price', 'price', 'unit_price', 'total_price', 'total', 'amount', 'quoted_price'];

/** Field-name conventions for competitor/benchmark prices. */
const COMPETITOR_PRICE_KEYS = [
  'competitor_price',
  'benchmark_price',
  'market_price',
  'best_competitor_price',
  'lowest_competitor_price',
];

/**
 * Our price in cents, searching the payload root, then items[0], then a
 * nested product object. Also the source of estimatedRevenueLost.
 */
function extractOurPriceCents(payload) {
  const root = firstCentsField(payload, OUR_PRICE_KEYS);
  if (root) return root;

  const items = safeGet(payload, 'items');
  if (Array.isArray(items) && items.length > 0) {
    const item = firstCentsField(items[0], OUR_PRICE_KEYS);
    if (item) return { cents: item.cents, field: `items[0].${item.field}` };
  }

  const product = firstCentsField(safeGet(payload, 'product'), OUR_PRICE_KEYS);
  if (product) return { cents: product.cents, field: `product.${product.field}` };

  return null;
}

/** Competitor price in cents: flat keys, nested competitor object, or the cheapest entry of a competitors[] array. */
function extractCompetitorPriceCents(payload) {
  const flat = firstCentsField(payload, COMPETITOR_PRICE_KEYS);
  if (flat) return flat;

  const nested = firstCentsField(safeGet(payload, 'competitor'), ['price', 'total', 'amount']);
  if (nested) return { cents: nested.cents, field: `competitor.${nested.field}` };

  const list = safeGet(payload, 'competitors');
  if (Array.isArray(list)) {
    let best = null;
    // Bounded scan: a hostile 10M-entry array must not stall the sweep.
    for (const entry of list.slice(0, 25)) {
      const price = firstCentsField(entry, ['price', 'total', 'amount']);
      if (price && (best === null || price.cents < best.cents)) best = price;
    }
    if (best) return { cents: best.cents, field: 'competitors[].price' };
  }
  return null;
}

/** Keys that carry quoted delivery estimates in days. */
const DELIVERY_DAYS_KEYS = [
  'delivery_days',
  'estimated_delivery_days',
  'delivery_estimate_days',
  'shipping_days',
  'transit_days',
  'min_delivery_days',
];

/**
 * The FASTEST delivery estimate visible in the payload, in days. Fastest
 * (not slowest) is correct for loss analysis: an agent abandons only when
 * even the best available option is too slow.
 */
function extractFastestDeliveryDays(payload) {
  let fastest = null;
  const consider = (value) => {
    const days = asNonNegativeNumber(value);
    if (days !== null && (fastest === null || days < fastest)) fastest = days;
  };

  for (const key of DELIVERY_DAYS_KEYS) consider(safeGet(payload, key));

  const shipping = safeGet(payload, 'shipping');
  for (const key of DELIVERY_DAYS_KEYS) consider(safeGet(shipping, key));

  const shippingQuote = safeGet(payload, 'shipping_quote');
  for (const key of DELIVERY_DAYS_KEYS) consider(safeGet(shippingQuote, key));

  // quotes[]: rate arrays from shipping_quote responses.
  const quotes = safeGet(payload, 'quotes');
  if (Array.isArray(quotes)) {
    for (const quote of quotes.slice(0, 25)) {
      for (const key of DELIVERY_DAYS_KEYS) consider(safeGet(quote, key));
      consider(safeGet(quote, 'days'));
    }
  }
  return fastest;
}

/** Strings that mean "not available" wherever an availability field carries them. */
const OUT_OF_STOCK_STRINGS = new Set(['out_of_stock', 'outofstock', 'oos', 'unavailable', 'sold_out', 'soldout', 'none_available']);

/** Does this object (product/variant/item level) say the thing cannot be bought? */
function objectSaysOutOfStock(obj) {
  if (!isObject(obj)) return false;

  // Boolean conventions. Strict === false: absent/None must not count.
  if (safeGet(obj, 'available') === false) return true;
  if (safeGet(obj, 'in_stock') === false) return true;
  if (safeGet(obj, 'is_available') === false) return true;
  if (safeGet(obj, 'variant_available') === false) return true;
  if (safeGet(obj, 'size_available') === false) return true;

  // Zero-quantity conventions. Strict === 0 (or "0"): a missing quantity is
  // unknown, not empty.
  for (const key of ['stock', 'stock_quantity', 'inventory', 'inventory_quantity', 'quantity_available', 'available_quantity']) {
    const quantity = safeGet(obj, key);
    if (quantity === 0 || quantity === '0') return true;
  }

  // String-status conventions.
  for (const key of ['availability', 'stock_status', 'inventory_status', 'status']) {
    const status = asLowerString(safeGet(obj, key));
    if (status !== null && OUT_OF_STOCK_STRINGS.has(status)) return true;
  }
  return false;
}

/** Stock outage anywhere the edge could have seen it: root, variant, product, items[]. */
function detectStockOutage(payload) {
  if (objectSaysOutOfStock(payload)) return true;
  if (objectSaysOutOfStock(safeGet(payload, 'variant'))) return true;
  if (objectSaysOutOfStock(safeGet(payload, 'product'))) return true;
  if (objectSaysOutOfStock(safeGet(payload, 'requested_variant'))) return true;
  const items = Array.isArray(safeGet(payload, 'items')) ? safeGet(payload, 'items') : [];
  for (const item of items.slice(0, 25)) {
    if (objectSaysOutOfStock(item)) return true;
  }
  return false;
}

/** Strings that flag unclear/conflicting policy terms. */
const AMBIGUOUS_POLICY_STRINGS = new Set(['ambiguous', 'unclear', 'unknown', 'conflicting', 'contradictory', 'not_specified', 'unspecified']);

/** Payload flags policy/returns ambiguity (agents abort on unclear terms). */
function detectPolicyAmbiguity(payload) {
  if (!isObject(payload)) return false;

  for (const key of ['policy_ambiguous', 'policy_ambiguity', 'return_policy_unclear', 'policy_conflict', 'terms_unclear']) {
    if (safeGet(payload, key) === true) return true;
  }
  for (const key of ['return_policy', 'returns_policy', 'policy_status', 'refund_policy']) {
    const status = asLowerString(safeGet(payload, key));
    if (status !== null && AMBIGUOUS_POLICY_STRINGS.has(status)) return true;
  }
  const policy = safeGet(payload, 'policy');
  if (isObject(policy)) {
    if (safeGet(policy, 'ambiguous') === true || safeGet(policy, 'unclear') === true) return true;
    const status = asLowerString(safeGet(policy, 'status'));
    if (status !== null && AMBIGUOUS_POLICY_STRINGS.has(status)) return true;
  }
  // flags: ["policy_ambiguity", ...] convention from edge-side annotators.
  const flags = safeGet(payload, 'flags');
  if (Array.isArray(flags)) {
    for (const flag of flags.slice(0, 50)) {
      const value = asLowerString(flag);
      if (value !== null && (value.includes('policy') || value.includes('return_terms'))) return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------------- *
 * Classifier                                                                 *
 * ------------------------------------------------------------------------- */

/**
 * Classify why an expired intent failed to convert.
 *
 * @param {unknown} intentRow  agent_intent_logs row ({inbound_payload,
 *   endpoint_path, target_sku, ...}). Any shape tolerated.
 * @returns {{
 *   reason: string,                 // one of LOSS_REASONS (DB CHECK-safe)
 *   estimatedRevenueLost: number,   // integer CENTS, >= 0; 0 when unknown
 *   competitorDelta: object|null,   // JSONB-ready evidence, shape varies by reason
 * }} Never throws.
 */
export function classifyLoss(intentRow) {
  try {
    const row = isObject(intentRow) ? intentRow : {};
    const payload = isObject(safeGet(row, 'inbound_payload')) ? safeGet(row, 'inbound_payload') : null;
    const endpointPath = asLowerString(safeGet(row, 'endpoint_path')) ?? '';

    // Revenue estimate is computed once, independent of reason: whatever made
    // the agent walk away, the walked-away basket is worth our listed price.
    const ourPrice = payload ? extractOurPriceCents(payload) : null;
    const estimatedRevenueLost = ourPrice ? ourPrice.cents : 0;

    // (1) PROTOCOL_ERROR — see priority rationale in the header comment.
    const edgeStatus = payload ? extractEdgeStatus(payload) : null;
    if (edgeStatus !== null && (edgeStatus < 200 || edgeStatus >= 300)) {
      return {
        reason: LOSS_REASONS.PROTOCOL_ERROR,
        estimatedRevenueLost,
        competitorDelta: { observed_status: edgeStatus, endpoint_path: endpointPath || null },
      };
    }

    // (2) STOCK_OUTAGE
    if (payload && detectStockOutage(payload)) {
      const sku = asLowerString(safeGet(row, 'target_sku'));
      return {
        reason: LOSS_REASONS.STOCK_OUTAGE,
        estimatedRevenueLost,
        competitorDelta: {
          requested_sku: sku !== null && sku !== 'unspecified' ? safeGet(row, 'target_sku') : null,
        },
      };
    }

    // (3) PRICE_DISCREPANCY — needs BOTH sides of the comparison; a lone
    // competitor price with no own-price context proves nothing.
    const competitorPrice = payload ? extractCompetitorPriceCents(payload) : null;
    if (ourPrice && competitorPrice && competitorPrice.cents < ourPrice.cents) {
      return {
        reason: LOSS_REASONS.PRICE_DISCREPANCY,
        estimatedRevenueLost,
        competitorDelta: {
          our_price_cents: ourPrice.cents,
          competitor_price_cents: competitorPrice.cents,
          delta_cents: ourPrice.cents - competitorPrice.cents,
          our_price_field: ourPrice.field,
          competitor_price_field: competitorPrice.field,
        },
      };
    }

    // (4) SHIPPING_LATENCY — fastest quoted option still beyond the agent
    // tolerance threshold, or a shipping_quote explicitly flagged slow.
    const fastestDays = payload ? extractFastestDeliveryDays(payload) : null;
    const slowFlag =
      payload !== null &&
      endpointPath.includes('shipping_quote') &&
      (safeGet(payload, 'slow_quote') === true || safeGet(payload, 'expedited_available') === false);
    if ((fastestDays !== null && fastestDays > SHIPPING_LATENCY_THRESHOLD_DAYS) || slowFlag) {
      return {
        reason: LOSS_REASONS.SHIPPING_LATENCY,
        estimatedRevenueLost,
        competitorDelta: {
          quoted_delivery_days: fastestDays,
          threshold_days: SHIPPING_LATENCY_THRESHOLD_DAYS,
          slow_quote_flag: slowFlag || undefined,
        },
      };
    }

    // (5) POLICY_AMBIGUITY
    if (payload && detectPolicyAmbiguity(payload)) {
      return {
        reason: LOSS_REASONS.POLICY_AMBIGUITY,
        estimatedRevenueLost,
        competitorDelta: null,
      };
    }

    // (6) Fallback — the drop-off is real even when unexplained.
    return {
      reason: LOSS_REASONS.UNKNOWN_DROPOFF,
      estimatedRevenueLost,
      competitorDelta: null,
    };
  } catch {
    // Absolute backstop: a hostile payload must cost one UNKNOWN row at most.
    return {
      reason: LOSS_REASONS.UNKNOWN_DROPOFF,
      estimatedRevenueLost: 0,
      competitorDelta: null,
    };
  }
}
