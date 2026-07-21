/**
 * lib/validate-telemetry.js — pure validation/normalization of edge telemetry records.
 *
 * Role in the AOP data flow:
 *   [Cloudflare Worker edge proxy] -> env.EDGE_LOG_QUEUE -> [queue consumer]
 *     --HTTPS POST {records:[...]}--> POST /ingest/telemetry (this shape check)
 *     --> agent_intent_logs INSERT.
 *
 *   The edge builds records best-effort (its hard rule is "never throw near
 *   merchant traffic"), so records can arrive partial: method "UNKNOWN", null
 *   paths, missing domains. This module decides, per record, whether it can
 *   become a valid agent_intent_logs row — and normalizes it to exactly the
 *   column shapes the DB enforces, so a single bad record can never poison a
 *   multi-row batch INSERT with a constraint violation.
 *
 * Wire shape produced by edge/src/telemetry.js:
 *   { token, protocol, method, path, query, target_sku, shop_domain,
 *     inbound_payload, pii_redactions, user_geo, data_region, status,
 *     latency_ms, observed_at }
 *
 * Compliance note: inbound_payload arrives ALREADY PII-redacted (the edge's
 * redact.js strips names/emails/phones/street addresses before anything is
 * queued — PII never reaches this service). The audit counter
 * (pii_redactions) and the data-residency fields (user_geo 2-letter country,
 * data_region 'eu'|'row') are folded into the stored `_edge` meta so the
 * compliance trail persists with the row.
 *
 * Enrichment decision (non-obvious): agent_intent_logs has no columns for
 * status/latency/query, but the loss classifier needs the edge-observed HTTP
 * status to diagnose PROTOCOL_ERROR drop-offs. Transport facts are therefore
 * folded into the stored JSONB under a reserved `_edge` key
 * ({status, latency_ms, query, observed_at}) alongside the agent's own
 * payload fields. Consumers: src/lib/loss-classifier.js reads
 * payload._edge.status; dashboard latency analytics read _edge.latency_ms.
 *
 * PURE module: no express/pg imports, no I/O — unit-tested pre-`npm install`
 * by test/validate-telemetry.test.mjs.
 */

import { classifyIntentContext } from './intent-classifier.js';

/** Mirrors the CHECK constraint on agent_intent_logs.request_method. */
export const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/** Column widths from db/migrations/0003_agent_intent_logs.sql. */
const MAX_TOKEN_LENGTH = 255; // transaction_token VARCHAR(255)
const MAX_PROTOCOL_LENGTH = 50; // protocol_type VARCHAR(50)
const MAX_PATH_LENGTH = 255; // endpoint_path VARCHAR(255)
const MAX_SKU_LENGTH = 100; // target_sku VARCHAR(100)
const MAX_DOMAIN_LENGTH = 255; // merchant_profiles.shopify_shop_domain VARCHAR(255)

/**
 * Serialized-payload ceiling. The edge already caps body snapshots at 32KB;
 * 64KB here allows for enrichment overhead while guaranteeing a hostile
 * producer cannot land megabyte JSONB rows in the firehose table.
 */
const MAX_PAYLOAD_JSON_BYTES = 64 * 1024;

/** Sentinels shared with the edge and the DB schema. */
const ANONYMOUS_TOKEN = 'headless_anonymous';
const UNKNOWN_PROTOCOL = 'UNKNOWN_PROTOCOL';
const UNSPECIFIED_SKU = 'UNSPECIFIED';

/** UUID shape for the edge-minted idempotency id (db migration 0009). */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a plain object ({} — not array, not null). */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Unpaired UTF-16 surrogates: \uD800-\uDBFF with no low surrogate after,
 * or \uDC00-\uDFFF with no high surrogate before. JSON.parse accepts them
 * (the "\ud800" escape is legal JSON) and JSON.stringify re-emits them, but
 * PostgreSQL's jsonb rejects them the same way it rejects \u0000.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Make every string in a JSON tree (keys and values) jsonb-storable.
 *
 * PostgreSQL's jsonb rejects two classes of legal-in-JavaScript string
 * content, and ONE such value in ONE record would abort the whole multi-row
 * batch INSERT — a single hostile agent payload poisoning up to 499
 * innocent records, retried by the queue consumer until the batch
 * dead-letters (and, for the dead-letter drain itself, dropped for good):
 *   - U+0000: rejected outright (22P05). NUL carries no analytic meaning;
 *     it is removed.
 *   - Unpaired surrogates (\uD800-\uDFFF alone): rejected as invalid JSON
 *     text (22P02). Each is replaced with U+FFFD so the record keeps a
 *     visible marker where the unpairable code unit sat.
 * Removal/replacement (not rejection) keeps the record while making it
 * storable. Depth-bounded and cycle-safe by construction (JSON.parse
 * output only).
 */
export function stripNulCharacters(value, depth = 0) {
  if (typeof value === 'string') {
    const noNul = value.includes('\u0000') ? value.split('\u0000').join('') : value;
    // String.replace with a /g regex always scans from index 0 — safe to
    // share the regex instance across calls.
    return noNul.replace(LONE_SURROGATE, '\uFFFD');
  }
  if (value === null || typeof value !== 'object') return value;
  // FAIL CLOSED at the depth cap: returning the raw subtree would pass
  // un-scrubbed NULs straight through to the batch INSERT -- the exact
  // poisoning this function exists to stop. Dropping an absurdly deep
  // subtree loses nothing legitimate. Cap 128 comfortably exceeds the edge
  // redactor's own 64-level bound, so no edge-preserved payload can ever
  // reach this branch.
  if (depth > 128) return null;
  if (Array.isArray(value)) return value.map((entry) => stripNulCharacters(entry, depth + 1));
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    out[stripNulCharacters(key, depth + 1)] = stripNulCharacters(entry, depth + 1);
  }
  return out;
}

/** Trimmed string or null. */
function asTrimmedString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Build the `_edge` transport-facts object from record fields. Only fields
 * that survive type checks are included; an empty result returns null so we
 * never store a useless {"_edge":{}} blob.
 */
function buildEdgeMeta(record) {
  const meta = {};
  const status = record.status;
  if (Number.isInteger(status) && status >= 100 && status <= 599) meta.status = status;

  const latency = record.latency_ms;
  if (typeof latency === 'number' && Number.isFinite(latency) && latency >= 0) {
    meta.latency_ms = Math.round(latency);
  }

  const query = asTrimmedString(record.query);
  // Bounded: query strings can carry junk; 2KB is plenty for diagnostics.
  if (query !== null) meta.query = query.slice(0, 2048);

  const observedAt = asTrimmedString(record.observed_at);
  // Sanity-shape check only (full ISO validation is overkill for a debug field).
  if (observedAt !== null && observedAt.length <= 64) meta.observed_at = observedAt;

  // Compliance fields from the edge (see edge/src/redact.js): coarse consumer
  // geo for data-residency routing, and the PII-redaction audit counter
  // (>=0 = redactions applied; -1 = edge redactor failed and dropped the
  // payload as its fail-safe). Persisted so the compliance trail lives with
  // the row.
  const geo = asTrimmedString(record.user_geo);
  if (geo !== null && /^[A-Za-z]{2}$/.test(geo)) meta.user_geo = geo.toUpperCase();

  const region = asTrimmedString(record.data_region);
  if (region === 'eu' || region === 'row') meta.data_region = region;

  if (Number.isInteger(record.pii_redactions) && record.pii_redactions >= -1) {
    meta.pii_redactions = record.pii_redactions;
  }

  // Context Reconstruction (lib/intent-classifier.js): classify the agent's
  // shopping context (prompt/intent fields in the payload) so the Agent
  // Traffic screen can answer "which prompt categories drive traffic".
  // null = no context signal at all -> field simply absent.
  const intent = classifyIntentContext(record.inbound_payload);
  if (intent !== null) {
    meta.intent_category = intent.category;
    meta.intent_source = intent.source;
  }

  return Object.keys(meta).length > 0 ? meta : null;
}

/**
 * Validate one wire record and normalize it into an insert-ready shape.
 *
 * Philosophy: REPAIR what is safely repairable (missing token -> anonymous
 * sentinel, long protocol -> truncate: analytics-only fields), REJECT what
 * would corrupt attribution or violate DB constraints (bogus method, missing
 * path, oversized token — truncating an attribution token would manufacture
 * false order matches, so it is rejected instead).
 *
 * @param {unknown} record  one element of the POSTed records[] array.
 * @returns {{ok: true, value: {
 *     token: string, protocol: string, method: string, path: string,
 *     targetSku: string, shopDomain: string, payload: object|null,
 *     eventId: string|null,
 *   }} | {ok: false, error: string}}  Never throws.
 */
export function validateTelemetryRecord(record) {
  try {
    if (!isPlainObject(record)) {
      return { ok: false, error: 'record must be a JSON object' };
    }

    // NUL scrub FIRST: PostgreSQL rejects U+0000 in both text columns and
    // jsonb, and one poisoned string would abort the entire multi-row batch
    // INSERT downstream. Every later check operates on the scrubbed tree.
    record = stripNulCharacters(record);

    // --- event id (ingest idempotency key, db migration 0009) -----------
    // Optional: pre-0009 edge builds don't send one, and a malformed value
    // degrades to null (record still ingests — it just loses redelivery
    // dedup) rather than rejecting telemetry the edge already shipped.
    const eventIdRaw = asTrimmedString(record.event_id);
    const eventId = eventIdRaw !== null && UUID_PATTERN.test(eventIdRaw) ? eventIdRaw.toLowerCase() : null;

    // --- transaction token (attribution key) ----------------------------
    // Missing/blank degrades to the anonymous sentinel (matches the edge's
    // own fallback); OVERSIZED is rejected: truncation could collide two
    // different tokens and mis-attribute an order to the wrong intent.
    let token = asTrimmedString(record.token) ?? ANONYMOUS_TOKEN;
    if (token.length > MAX_TOKEN_LENGTH) {
      return { ok: false, error: `token exceeds ${MAX_TOKEN_LENGTH} chars` };
    }

    // --- protocol (analytics-only label) --------------------------------
    // Truncation is safe here: worst case a mangled label in a dashboard.
    const protocol = (asTrimmedString(record.protocol) ?? UNKNOWN_PROTOCOL).slice(0, MAX_PROTOCOL_LENGTH);

    // --- method (DB CHECK constraint — closed set) ----------------------
    // The edge emits 'UNKNOWN' when it could not read the method; such a
    // record cannot be stored (the CHECK would abort the whole batch), and
    // there is no honest repair, so it is rejected and counted.
    const method = (asTrimmedString(record.method) ?? '').toUpperCase();
    if (!ALLOWED_METHODS.has(method)) {
      return { ok: false, error: `method "${method || '(missing)'}" not in allowed set` };
    }

    // --- endpoint path (NOT NULL) ---------------------------------------
    let path = asTrimmedString(record.path);
    if (path === null) {
      return { ok: false, error: 'path is required' };
    }
    if (!path.startsWith('/')) path = `/${path}`; // normalize bare "availability"
    // Truncation is safe: a >255-char path is hostile/broken input and the
    // prefix keeps its analytic value ("which endpoint was probed").
    path = path.slice(0, MAX_PATH_LENGTH);

    // --- target SKU (sentinel-defaulted, analytics label) ---------------
    let targetSku = null;
    if (typeof record.target_sku === 'number' && Number.isFinite(record.target_sku)) {
      targetSku = String(record.target_sku); // numeric SKUs exist in the wild
    } else {
      targetSku = asTrimmedString(record.target_sku);
    }
    targetSku = (targetSku ?? UNSPECIFIED_SKU).slice(0, MAX_SKU_LENGTH);

    // --- shop domain (tenant resolution key) ----------------------------
    // Required: without it the record cannot be attributed to any merchant.
    // (An unknown-but-present domain is NOT this module's concern — the
    // route counts it as skipped_unknown_merchant after a DB lookup.)
    const shopDomain = asTrimmedString(record.shop_domain);
    if (shopDomain === null || shopDomain.length > MAX_DOMAIN_LENGTH) {
      return { ok: false, error: 'shop_domain is required (max 255 chars)' };
    }

    // --- payload enrichment (see header: `_edge` transport facts) -------
    const edgeMeta = buildEdgeMeta(record);
    const original = record.inbound_payload;
    let payload = null;
    if (isPlainObject(original)) {
      // Spread + reserved key. If a hostile agent sent its own `_edge` field,
      // ours wins (spread order) — transport truth beats payload claims.
      payload = edgeMeta ? { ...original, _edge: edgeMeta } : { ...original };
    } else if (original !== null && original !== undefined) {
      // Arrays/scalars are legal JSON bodies; wrap them so the stored JSONB
      // is always an object (keeps GIN containment queries and the `_edge`
      // convention uniform).
      payload = edgeMeta ? { agent_body: original, _edge: edgeMeta } : { agent_body: original };
    } else if (edgeMeta) {
      payload = { _edge: edgeMeta };
    }

    // Size cap AFTER enrichment. JSON.stringify can throw on circular input
    // (impossible off the JSON wire, possible from in-process callers) —
    // treat that as "payload unusable", keep the record.
    if (payload !== null) {
      try {
        const serialized = JSON.stringify(payload);
        if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_JSON_BYTES) {
          payload = edgeMeta ? { _edge: edgeMeta, payload_dropped: 'oversize' } : null;
        }
      } catch {
        payload = edgeMeta ? { _edge: edgeMeta, payload_dropped: 'unserializable' } : null;
      }
    }

    return {
      ok: true,
      value: { token, protocol, method, path, targetSku, shopDomain, payload, eventId },
    };
  } catch {
    // Hostile getters etc. — contract: never throws.
    return { ok: false, error: 'record could not be processed' };
  }
}
