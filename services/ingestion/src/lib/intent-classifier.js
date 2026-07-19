/**
 * lib/intent-classifier.js — Context Reconstruction: prompt classification.
 *
 * Role in the AOP data flow:
 *   [edge telemetry record] -> validate-telemetry.js enrichment -> THIS
 *   module -> `_edge.intent_category` on the stored JSONB -> the dashboard's
 *   Agent Traffic screen ("which prompt categories drive traffic").
 *
 * Product feature (spec, "Context Reconstruction"): agents often forward a
 * high-level shopping context in their probe payloads — a prompt excerpt, an
 * intent tag, an urgency flag. Classifying it answers a question merchants
 * can get nowhere else: WHAT KIND of buying moment is my catalog being
 * evaluated for, and which kinds convert?
 *
 * Sources scanned (in priority order):
 *   1. Explicit machine tags: payload.intent_category /
 *      payload.user_intent_category / payload.agent_identity.user_intent_category
 *      — passed through when they normalize onto our taxonomy.
 *   2. Free-text prompt fields: prompt, user_prompt, query, search_query,
 *      context, user_context, shopping_context — keyword heuristics.
 *
 * Taxonomy (closed set — analytics GROUP BYs need stable values):
 *   GIFT_URGENT, GIFT, PRICE_SENSITIVE, ECO_CONSCIOUS, QUALITY_FOCUSED,
 *   REPLENISHMENT, RESEARCH, UNCLASSIFIED
 *
 * Defensive contract: payload is attacker-adjacent JSON. Never throws;
 * bounded string scans; returns null (not UNCLASSIFIED) when there is no
 * context signal at all — absence of signal is not a classification.
 *
 * PURE module: no I/O — unit-tested pre-`npm install`.
 */

/** Closed taxonomy for analytics stability. */
export const INTENT_CATEGORIES = Object.freeze([
  'GIFT_URGENT',
  'GIFT',
  'PRICE_SENSITIVE',
  'ECO_CONSCIOUS',
  'QUALITY_FOCUSED',
  'REPLENISHMENT',
  'RESEARCH',
  'UNCLASSIFIED',
]);

const CATEGORY_SET = new Set(INTENT_CATEGORIES);

/** Cap scanned text; prompts are short, hostile payloads are not. */
const MAX_TEXT_LENGTH = 2000;

/** Explicit tag fields, checked before any free-text heuristics. */
const TAG_FIELDS = ['intent_category', 'user_intent_category', 'prompt_category'];

/** Free-text fields worth scanning for context keywords. */
const TEXT_FIELDS = [
  'prompt',
  'user_prompt',
  'query',
  'search_query',
  'context',
  'user_context',
  'shopping_context',
  'intent',
  'user_intent',
];

/**
 * Keyword rules, first match wins. Urgency+gift outranks plain gift;
 * urgency alone maps to GIFT_URGENT only when gifting is also present
 * (urgent replenishment is REPLENISHMENT, checked separately).
 */
const URGENT_RE = /\b(urgent|asap|today|tomorrow|last[- ]minute|overnight|same[- ]day|by (this )?(friday|saturday|sunday|monday|tuesday|wednesday|thursday|weekend))\b/i;
const GIFT_RE = /\b(gift|present|anniversary|birthday|wedding|valentine|mother'?s day|father'?s day|christmas|holiday)\b/i;
const PRICE_RE = /\b(cheap(est)?|lowest price|best (price|deal)|budget|affordable|discount|under \$?\d+|on sale|bargain)\b/i;
const ECO_RE = /\b(eco[- ]?friendly|sustainab\w*|organic|recycl\w*|biodegradable|carbon[- ]neutral|ethical(ly)?|fair[- ]trade|green)\b/i;
const QUALITY_RE = /\b(best quality|highest[- ]rated|top[- ]rated|premium|durable|long[- ]lasting|well[- ]made|luxury|high[- ]end)\b/i;
const REPLENISH_RE = /\b(re[- ]?order|reorder|refill|replenish|subscribe|again|restock|running (low|out)|same as last)\b/i;
const RESEARCH_RE = /\b(compar(e|ing|ison)|research|options|alternatives|reviews?|difference between|versus|vs\.?)\b/i;

/**
 * Normalize an explicit tag onto the taxonomy: exact (case/sep-insensitive)
 * matches pass through; anything else is treated as free text downstream.
 */
function normalizeTag(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const canonical = value.trim().toUpperCase().replace(/[\s-]+/g, '_').slice(0, 64);
  return CATEGORY_SET.has(canonical) ? canonical : null;
}

/** Classify one free-text string; null when nothing matches. */
function classifyText(text) {
  const bounded = text.slice(0, MAX_TEXT_LENGTH);
  const gift = GIFT_RE.test(bounded);
  if (gift && URGENT_RE.test(bounded)) return 'GIFT_URGENT';
  if (gift) return 'GIFT';
  if (REPLENISH_RE.test(bounded)) return 'REPLENISHMENT';
  if (PRICE_RE.test(bounded)) return 'PRICE_SENSITIVE';
  if (ECO_RE.test(bounded)) return 'ECO_CONSCIOUS';
  if (QUALITY_RE.test(bounded)) return 'QUALITY_FOCUSED';
  if (RESEARCH_RE.test(bounded)) return 'RESEARCH';
  return null;
}

/** Safe property read (hostile getters). */
function safeGet(obj, key) {
  try {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
    return obj[key];
  } catch {
    return undefined;
  }
}

/**
 * Classify the shopping context of one intent payload.
 *
 * @param {unknown} payload the (redacted) agent request body.
 * @returns {{category: string, source: string}|null}
 *   category — taxonomy value (UNCLASSIFIED when a context signal exists but
 *   matches no rule); source — which field the verdict came from (audit /
 *   debugging). null when the payload carries no context signal at all.
 */
export function classifyIntentContext(payload) {
  try {
    if (payload === null || typeof payload !== 'object') return null;

    // Nested agent_identity block (mock "holy grail" event shape from the
    // product docs) — checked alongside the root.
    const containers = [payload, safeGet(payload, 'agent_identity')];

    // 1. Explicit tags pass straight through when on-taxonomy.
    for (const container of containers) {
      for (const field of TAG_FIELDS) {
        const tagged = normalizeTag(safeGet(container, field));
        if (tagged !== null) return { category: tagged, source: field };
      }
    }

    // 2. Free-text heuristics — including off-taxonomy tag values, which are
    // still human text worth scanning ("gift_shopping_urgent").
    let sawContext = false;
    for (const container of containers) {
      for (const field of [...TAG_FIELDS, ...TEXT_FIELDS]) {
        const value = safeGet(container, field);
        if (typeof value !== 'string' || value.trim() === '') continue;
        sawContext = true;
        // Underscore/hyphen-joined tags read fine through the regexes once
        // separators become spaces ("gift_shopping_urgent" -> urgent + gift).
        const category = classifyText(value.replace(/[_-]+/g, ' '));
        if (category !== null) return { category, source: field };
      }
    }

    // Context present but nothing matched: a real "we saw it, couldn't place
    // it" bucket — distinct from no-context-at-all (null).
    return sawContext ? { category: 'UNCLASSIFIED', source: 'unmatched_context' } : null;
  } catch {
    return null;
  }
}
