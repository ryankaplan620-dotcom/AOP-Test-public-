/**
 * telemetry.js — pure helpers for building AOP intent-telemetry records.
 *
 * Role in the AOP data flow:
 *   [AI Agent] -> [edge proxy fetch()] --(these helpers build the record)-->
 *   env.EDGE_LOG_QUEUE -> queue consumer -> ingestion service -> PostgreSQL.
 *
 * The records built here are the raw material for everything downstream:
 * cookie-less attribution (the X-Agent-Transaction-Token is later stitched to
 * Shopify order-created webhooks), 0.5% GMV commission computation, and the
 * loss_diagnostics sweep that classifies intents which expire without
 * conversion inside the 60-second window.
 *
 * HARD INVARIANT: nothing in this module may ever throw. Telemetry is strictly
 * best-effort — a malformed agent payload, an oversized body, or a hostile
 * stream must degrade to a *partial* record, never to an error that could
 * propagate anywhere near the merchant's live proxied traffic. Every helper is
 * therefore wrapped defensively, and buildTelemetryRecord() always resolves
 * with a record object.
 *
 * COMPLIANCE INVARIANT: the captured body snapshot is passed through
 * redactPii() (see redact.js) before it is placed on the record, so consumer
 * names, emails, phone numbers and street addresses never reach the queue or
 * any durable store — only coarse geo (zip/state/country) survives. Records
 * also carry user_geo + data_region so EU-origin telemetry can be routed to
 * EU infrastructure (data-residency memo).
 */

import { redactPii, dataResidencyRegion } from './redact.js';

/**
 * Upper bound for the request-body snapshot captured into telemetry.
 * 32KB comfortably fits every real ACP/AP2 availability / shipping_quote
 * payload while guaranteeing the edge never buffers an unbounded (or
 * adversarial) agent body into memory. Bodies larger than this are treated
 * as unparseable and the record ships with inbound_payload = null.
 */
export const MAX_BODY_SNAPSHOT_BYTES = 32 * 1024;

/** Methods that carry no request body per the fetch spec — skip body capture. */
const BODYLESS_METHODS = new Set(['GET', 'HEAD']);

/**
 * Read the agent identity headers off an inbound request.
 *
 *  - X-Agent-Transaction-Token: the cookie-less attribution token agents echo
 *    into checkout; the ingestion service joins it against Shopify order
 *    webhooks. Missing/blank -> "headless_anonymous" so downstream GROUP BYs
 *    still bucket un-tokenized agent traffic instead of dropping it.
 *  - X-Agent-Protocol: which agent commerce protocol is calling (e.g. "ACP",
 *    "AP2"). Missing/blank -> "UNKNOWN_PROTOCOL".
 *  - X-User-Geo (fallback: request.cf.country, populated by Cloudflare): the
 *    end-consumer's country code, used ONLY for data-residency routing and
 *    coarse geo analytics. Missing -> null.
 *
 * Never throws: any header-access failure yields the fallback values.
 *
 * @param {Request|null|undefined} request
 * @returns {{token: string, protocol: string, geo: string|null}}
 */
export function extractAgentSignature(request) {
  let token = null;
  let protocol = null;
  let geo = null;
  try {
    // Optional chaining throughout: a missing/foreign "request" object (or a
    // headers implementation that throws) must still resolve to fallbacks.
    token = request?.headers?.get?.('X-Agent-Transaction-Token') ?? null;
    protocol = request?.headers?.get?.('X-Agent-Protocol') ?? null;
    // Explicit protocol header wins; Cloudflare's own geo-IP resolution
    // (request.cf.country) is the fallback for agents that omit it.
    geo = request?.headers?.get?.('X-User-Geo') ?? request?.cf?.country ?? null;
  } catch {
    // Swallow: fall through to fallbacks below.
  }
  return {
    token:
      typeof token === 'string' && token.trim() !== ''
        ? token.trim()
        : 'headless_anonymous',
    protocol:
      typeof protocol === 'string' && protocol.trim() !== ''
        ? protocol.trim()
        : 'UNKNOWN_PROTOCOL',
    geo: typeof geo === 'string' && geo.trim() !== '' ? geo.trim().toUpperCase() : null,
  };
}

/**
 * Coerce a URL-ish input (URL instance or string) into a URL, or null.
 * Never throws.
 */
function toUrl(url) {
  try {
    if (url instanceof URL) return url;
    if (typeof url === 'string' && url !== '') return new URL(url);
  } catch {
    // Malformed URL string — caller proceeds with a partial record.
  }
  return null;
}

/**
 * Incrementally read at most MAX_BODY_SNAPSHOT_BYTES from the CLONED request's
 * body stream. Reading chunk-by-chunk (instead of request.text()) is what
 * enforces the bound: an agent could POST a multi-megabyte body and we must
 * never buffer it all just for telemetry. The reader is cancelled afterwards
 * so the clone's tee branch releases its backpressure buffer.
 *
 * @param {Request|null|undefined} clonedRequest
 * @returns {Promise<{text: string, truncated: boolean} | null>} null when
 *   there is no capturable body (GET/HEAD, empty body, already-consumed clone,
 *   or any stream failure).
 */
async function captureBoundedBodyText(clonedRequest) {
  let stream = null;
  try {
    if (!clonedRequest) return null;
    const method = String(clonedRequest.method ?? '').toUpperCase();
    if (BODYLESS_METHODS.has(method)) return null;
    if (clonedRequest.bodyUsed) return null; // defensive: someone drained the clone
    stream = clonedRequest.body;
  } catch {
    return null;
  }
  if (!stream || typeof stream.getReader !== 'function') return null;

  let reader;
  try {
    reader = stream.getReader();
  } catch {
    return null; // stream locked or hostile — skip body capture entirely
  }

  const chunks = [];
  let total = 0;
  let truncated = false;
  try {
    // Stop as soon as the cap is exceeded; do NOT drain the rest of the body.
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        chunks.push(value);
        total += value.byteLength;
        if (total > MAX_BODY_SNAPSHOT_BYTES) {
          truncated = true;
          break;
        }
      }
    }
  } catch {
    return null; // stream error mid-read — degrade to "no body captured"
  } finally {
    // Cancel releases the underlying tee buffer; failures here are irrelevant.
    try {
      const cancelled = reader.cancel?.();
      cancelled?.catch?.(() => {});
    } catch {
      /* ignore */
    }
  }

  // Concatenate only up to the cap — the snapshot itself is bounded even when
  // the final chunk overshot it.
  const bounded = new Uint8Array(Math.min(total, MAX_BODY_SNAPSHOT_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    const room = bounded.length - offset;
    if (room <= 0) break;
    bounded.set(room >= chunk.byteLength ? chunk : chunk.subarray(0, room), offset);
    offset += Math.min(room, chunk.byteLength);
  }
  // fatal:false — invalid UTF-8 becomes replacement chars instead of throwing.
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bounded);
  return { text, truncated };
}

/**
 * Extract the SKU the agent is asking about. Precedence:
 *   1. ?sku= query parameter (GET-style availability probes)
 *   2. body.sku, body.product_sku, body.variant_sku, body.items[0].sku
 *      (POST-style ACP/AP2 payload conventions)
 * Numbers are stringified (some carts use numeric SKUs). Never throws.
 *
 * @param {URL|null} url
 * @param {unknown} payload parsed JSON body (or null)
 * @returns {string|null}
 */
function extractTargetSku(url, payload) {
  try {
    const fromQuery = url?.searchParams?.get?.('sku');
    if (typeof fromQuery === 'string' && fromQuery.trim() !== '') {
      return fromQuery.trim();
    }
  } catch {
    /* fall through to body fields */
  }

  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const candidates = [payload.sku, payload.product_sku, payload.variant_sku];
    const firstItem = Array.isArray(payload.items) ? payload.items[0] : null;
    if (firstItem && typeof firstItem === 'object') {
      candidates.push(firstItem.sku);
    }
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim() !== '') {
        return candidate.trim();
      }
      if (typeof candidate === 'number' && Number.isFinite(candidate)) {
        return String(candidate);
      }
    }
  }
  return null;
}

/**
 * Build one intent-telemetry record for the ingestion pipeline.
 *
 * @param {Request|null} clonedRequest a CLONE of the inbound request (the
 *   original's body must keep streaming untouched to the origin — cloning is
 *   the caller's job, done synchronously before origin dispatch). May be null
 *   (clone failed / bodiless flow); the record is then built from meta alone.
 * @param {URL|string|null} url the inbound request URL (path/query/sku source).
 * @param {object} meta pre-computed context from the fetch handler:
 *   {token, protocol, method, shopDomain, status, latencyMs, userGeo}
 * @returns {Promise<object>} ALWAYS resolves with a record — on any failure the
 *   affected fields are null and the rest of the record still ships. Shape:
 *   { token, protocol, method, path, query, target_sku, shop_domain,
 *     inbound_payload, pii_redactions, user_geo, data_region, status,
 *     latency_ms, observed_at }
 */
export async function buildTelemetryRecord(clonedRequest, url, meta = {}) {
  const safeMeta = meta && typeof meta === 'object' ? meta : {};

  // Start from a fully-populated skeleton so every downstream consumer can rely
  // on the shape even when parsing fails half-way through.
  const record = {
    token:
      typeof safeMeta.token === 'string' && safeMeta.token !== ''
        ? safeMeta.token
        : 'headless_anonymous',
    protocol:
      typeof safeMeta.protocol === 'string' && safeMeta.protocol !== ''
        ? safeMeta.protocol
        : 'UNKNOWN_PROTOCOL',
    method: 'UNKNOWN',
    path: null,
    query: '',
    target_sku: null,
    // shop_domain = resolved ORIGIN hostname; the ingestion service maps it to
    // a merchant_id. null when no origin could be resolved (502 flows).
    shop_domain:
      typeof safeMeta.shopDomain === 'string' && safeMeta.shopDomain !== ''
        ? safeMeta.shopDomain
        : null,
    inbound_payload: null,
    // Compliance audit trail: how many PII redactions redactPii() applied to
    // the payload (0 = clean payload, -1 = redactor failed and the payload was
    // dropped as the fail-safe).
    pii_redactions: 0,
    // Data-residency fields (compliance memo): consumer country code and its
    // storage region ('eu' records must land on EU infrastructure).
    user_geo:
      typeof safeMeta.userGeo === 'string' && safeMeta.userGeo !== ''
        ? safeMeta.userGeo
        : null,
    data_region: dataResidencyRegion(safeMeta.userGeo),
    status: Number.isInteger(safeMeta.status) ? safeMeta.status : null,
    latency_ms: Number.isFinite(safeMeta.latencyMs)
      ? Math.max(0, Math.round(safeMeta.latencyMs))
      : null,
    observed_at: new Date().toISOString(),
  };

  try {
    // Method: prefer the request itself, fall back to meta (clone may be null).
    try {
      const method = clonedRequest?.method ?? safeMeta.method;
      if (typeof method === 'string' && method !== '') {
        record.method = method.toUpperCase();
      }
    } catch {
      /* keep 'UNKNOWN' */
    }

    const parsedUrl = toUrl(url) ?? toUrl(clonedRequest?.url);
    if (parsedUrl) {
      record.path = parsedUrl.pathname;
      record.query = parsedUrl.search; // includes leading '?', '' when absent
    }

    // Body snapshot: bounded read from the clone, then best-effort JSON parse.
    const snapshot = await captureBoundedBodyText(clonedRequest);
    let parsedPayload = null;
    if (snapshot && !snapshot.truncated && snapshot.text.trim() !== '') {
      // A truncated body can never be valid JSON — don't even attempt it, and
      // never ship a mangled half-payload downstream.
      try {
        parsedPayload = JSON.parse(snapshot.text) ?? null;
      } catch {
        // Non-JSON body (form-encoded, garbage, etc.) -> payload stays null.
      }
    }

    // SKU extraction runs on the RAW parse (sku fields are never PII), but the
    // record only ever carries the REDACTED payload — PII must not survive
    // past this function (compliance invariant, see module header).
    record.target_sku = extractTargetSku(parsedUrl, parsedPayload);
    const { payload: redactedPayload, redactions } = redactPii(parsedPayload);
    record.inbound_payload = redactedPayload;
    record.pii_redactions = redactions;
  } catch {
    // Absolute backstop: whatever exploded, the partial record still ships.
  }

  return record;
}
