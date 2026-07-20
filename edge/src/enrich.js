/**
 * enrich.js — edge response enrichment: inject optimizer-verified JSON-LD.
 *
 * Role in the AOP data flow:
 *   [optimizer /rewrite | /claims: schema.org JSON-LD built from facts the
 *    merchant supplied] -> [operator stores it via PUT /analytics/enrichment
 *    (validated, size-capped)] -> [ingestion /routes/resolve returns it with
 *    the route answer] -> THIS MODULE injects it into merchant HTML at the
 *    proxy -- the storefront needs NO changes for agents to see machine-
 *    readable policy/product claims.
 *
 * PRIME DIRECTIVE COMPLIANCE (the reason for this module's shape):
 *   Enrichment NEVER blocks live traffic and NEVER adds a control-plane call
 *   of its own. The payload rides the SAME /routes/resolve answer that
 *   dynamic routing already fetches (routing.js stores {origin, enrichment}
 *   in one shared per-isolate cache), and the reply path only ever does a
 *   SYNCHRONOUS read of that cache (routing.getCachedEnrichment). A merchant
 *   whose origin is resolved statically (MERCHANT_ROUTES — a config escape
 *   hatch) is never enriched, so a slow/down control plane can never add
 *   TTFB to their HTML. Dynamically-routed (OAuth-onboarded) merchants —
 *   the ones enrichment is configured for — enrich on the first request
 *   because the routing lookup already carried the payload.
 *
 * FABRICATION GUARD: this module NEVER generates or edits content. It
 * injects the stored payload VERBATIM (JSON-serialized with '<' escaped as
 * < so markup can never break out of the script tag). The honesty
 * chain is: optimizer builds from merchant facts -> platform write path
 * validates shape/size -> edge injects verbatim.
 */

/**
 * Never buffer HTML beyond this. Enforced INCREMENTALLY during the read
 * (see readBoundedHtml) so a chunked/undeclared-length body cannot absorb
 * unbounded memory before the cap is noticed.
 */
export const MAX_ENRICHABLE_BYTES = 2 * 1024 * 1024;

/** Raw-text elements whose contents must never be treated as markup. */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'template', 'textarea', 'title']);

/**
 * Serialize the payload for embedding inside <script type="application/ld+json">.
 * '<' is escaped as < (valid JSON, identical parse result) so payload
 * strings can never contain a literal '</script>' or '<!--' and break out of
 * the tag — the ONLY transformation ever applied to the stored payload.
 *
 * @param {object|Array} jsonld
 * @returns {string|null} null if the payload is unserializable
 */
export function serializeJsonLd(jsonld) {
  try {
    const serialized = JSON.stringify(jsonld);
    if (typeof serialized !== 'string') return null;
    return serialized.replace(/</g, '\\u003c');
  } catch {
    return null;
  }
}

/**
 * Find a TOP-LEVEL insertion index just before the first </head> that is NOT
 * inside a comment or a raw-text element (<script>, <style>, <template>,
 * <textarea>, <title>). Splicing a tag that ends in '</script>' inside an
 * existing inline <script> would prematurely close it and corrupt the page;
 * skipping raw-text/comment regions prevents that. Returns -1 when no safe
 * head position exists (the caller then appends at end of document, which is
 * always safe — never inside another element).
 *
 * O(n): only inspects positions at '<'.
 *
 * @param {string} html
 * @returns {number}
 */
function safeHeadInsertionIndex(html) {
  const lower = html.toLowerCase();
  const len = lower.length;
  let i = 0;
  while (i < len) {
    const lt = lower.indexOf('<', i);
    if (lt === -1) return -1;

    if (lower.startsWith('<!--', lt)) {
      const end = lower.indexOf('-->', lt + 4);
      if (end === -1) return -1; // unterminated comment: no safe head position
      i = end + 3;
      continue;
    }
    if (lower.startsWith('</head', lt)) return lt;

    // Opening tag? If it starts a raw-text element, jump past its close tag.
    const m = /^<([a-z][a-z0-9]*)/.exec(lower.slice(lt, lt + 16));
    if (m && RAW_TEXT_ELEMENTS.has(m[1])) {
      const closeTag = `</${m[1]}`;
      const end = lower.indexOf(closeTag, lt + m[0].length);
      if (end === -1) return -1; // unterminated raw-text element: bail
      i = end + closeTag.length;
      continue;
    }
    i = lt + 1;
  }
  return -1;
}

/**
 * Inject the JSON-LD script tag into an HTML document string.
 * Placement: before the first TOP-LEVEL </head> (never inside a script or
 * comment); when none exists, appended at end of document (always safe).
 * Returns null only when the payload cannot be serialized.
 *
 * @param {string} html
 * @param {object|Array} jsonld
 * @returns {string|null}
 */
export function injectJsonLd(html, jsonld) {
  const serialized = serializeJsonLd(jsonld);
  if (serialized === null) return null;
  const tag = `<script type="application/ld+json" data-aop-enriched="true">${serialized}</script>`;
  const idx = safeHeadInsertionIndex(html);
  if (idx !== -1) return html.slice(0, idx) + tag + html.slice(idx);
  return html + tag;
}

/**
 * Read a response body as UTF-8 text with an INCREMENTAL byte cap. Bounds
 * isolate memory even for chunked/undeclared-length bodies: it stops
 * collecting once the cap is exceeded and hands back a passthrough stream
 * (already-read chunks + the untouched remainder) so the client still gets
 * the full body — just un-enriched.
 *
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<{text: string} | {overflow: true, stream: ReadableStream}>}
 */
async function readBoundedHtml(response, maxBytes) {
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
      if (total > maxBytes) {
        // Over cap: reconstruct the full body (buffered chunks + the rest of
        // the reader) as a stream and skip enrichment. Memory stays bounded
        // to ~maxBytes + one chunk.
        const buffered = chunks;
        const stream = new ReadableStream({
          start(controller) {
            for (const c of buffered) controller.enqueue(c);
          },
          async pull(controller) {
            const next = await reader.read();
            if (next.done) {
              controller.close();
              return;
            }
            controller.enqueue(next.value);
          },
          cancel(reason) {
            reader.cancel(reason).catch(() => {});
          },
        });
        return { overflow: true, stream };
      }
    }
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return { text: new TextDecoder('utf-8').decode(buf) };
}

/**
 * Inject a KNOWN, already-cached enrichment payload into a proxied response.
 * NO network — the payload is supplied by the caller from the synchronous
 * route cache. Enriches only GET + 200 + text/html + identity-encoded bodies
 * within the size cap; every other case (and any failure) returns the
 * ORIGINAL response object with its stream untouched.
 *
 * @param {{request: Request, response: Response, jsonld: object|Array}} params
 * @returns {Promise<Response>}
 */
export async function enrichResponse({ request, response, jsonld }) {
  try {
    if (jsonld === null || typeof jsonld !== 'object') return response;
    if (request?.method !== 'GET') return response;
    if (response?.status !== 200) return response;

    const contentType = response.headers?.get?.('content-type') ?? '';
    if (!/text\/html/i.test(contentType)) return response;

    // Compressed bodies must NOT be decoded as text — the bytes are gzip/br,
    // not UTF-8. Injecting into them would corrupt the page. Pass through
    // untouched (the payload stays compressed and framing is intact).
    const encoding = (response.headers?.get?.('content-encoding') ?? '').trim().toLowerCase();
    if (encoding !== '' && encoding !== 'identity') return response;

    // Declared-oversize fast path: skip without buffering at all.
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > MAX_ENRICHABLE_BYTES) return response;
    if (!response.body) return response;

    const read = await readBoundedHtml(response, MAX_ENRICHABLE_BYTES);
    if (read.overflow) {
      // Too big to enrich: hand back the reconstructed full stream, dropping
      // now-stale framing headers (the reader re-frames the transfer).
      const passthrough = new Response(read.stream, response);
      passthrough.headers.delete('content-length');
      passthrough.headers.delete('transfer-encoding');
      return passthrough;
    }

    const injected = injectJsonLd(read.text, jsonld);
    if (injected === null || injected === read.text) {
      // Serialize failed or nothing changed: return the buffered bytes as-is
      // (body content is byte-identical, so ETag/Last-Modified stay valid).
      const unchanged = new Response(read.text, response);
      unchanged.headers.delete('content-length');
      unchanged.headers.delete('transfer-encoding');
      return unchanged;
    }

    const enriched = new Response(injected, response);
    // The body changed: byte-level framing AND content validators from the
    // origin now describe a different representation. Drop them all.
    enriched.headers.delete('content-length');
    enriched.headers.delete('content-encoding');
    enriched.headers.delete('transfer-encoding');
    enriched.headers.delete('etag');
    enriched.headers.delete('last-modified');
    enriched.headers.set('x-aop-enriched', '1');
    return enriched;
  } catch {
    // If readBoundedHtml already consumed the stream this returns a response
    // whose body is spent — but that only happens after a mid-read failure,
    // which is an aborted transfer either way (identical to the un-proxied
    // outcome). Every pre-read failure path above returns the intact original.
    return response;
  }
}
