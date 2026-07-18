/**
 * lib/shopify-hmac.js — Shopify webhook signature verification.
 *
 * Role in the AOP data flow:
 *   Shopify order-created webhooks are the money leg of cookie-less
 *   attribution: they carry the order (and, in note_attributes, the
 *   X-Agent-Transaction-Token echo) that gets stitched back to
 *   agent_intent_logs and inserted into reconciled_agent_orders, from which
 *   the 0.5% GMV commission is derived. Because commission billing hangs off
 *   these payloads, an unverified webhook is an attacker-controlled invoice —
 *   so verification happens against the RAW request bytes BEFORE any JSON
 *   parsing (src/routes/webhooks.js mounts express.raw for exactly this
 *   reason: any body transformation before HMAC-ing breaks byte-exactness).
 *
 * Shopify's scheme: X-Shopify-Hmac-Sha256 = base64(HMAC-SHA256(secret, raw body)).
 *
 * PURE module: no express/pg imports, no I/O — unit-tested pre-`npm install`
 * by test/shopify-hmac.test.mjs.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** base64 alphabet sanity check — see verifyShopifyHmac() for why we bother. */
const BASE64_SHAPE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Verify a Shopify webhook signature.
 *
 * Tolerant of hostile inputs by contract: a missing header, a non-base64
 * header, a null body, or any other garbage returns false — this function
 * NEVER throws, because an exception escaping webhook auth would bubble into
 * the express error handler as a 500 and make Shopify retry a request that
 * can never succeed.
 *
 * @param {unknown} rawBodyBuffer     the UNTOUCHED request body bytes (Buffer;
 *   a string is accepted defensively and hashed as UTF-8).
 * @param {unknown} hmacHeaderBase64  value of X-Shopify-Hmac-Sha256.
 * @param {unknown} secret            SHOPIFY_WEBHOOK_SECRET from config.
 * @returns {boolean}
 */
export function verifyShopifyHmac(rawBodyBuffer, hmacHeaderBase64, secret) {
  try {
    // Fail closed on every malformed input. An empty secret must never
    // verify anything (config.js enforces non-empty, but auth code assumes
    // its own invariants can be violated).
    if (typeof secret !== 'string' || secret.length === 0) return false;
    if (typeof hmacHeaderBase64 !== 'string' || hmacHeaderBase64.length === 0) return false;

    let body;
    if (Buffer.isBuffer(rawBodyBuffer)) {
      body = rawBodyBuffer;
    } else if (typeof rawBodyBuffer === 'string') {
      body = Buffer.from(rawBodyBuffer, 'utf8');
    } else {
      // No body (e.g. express.raw skipped because Content-Type didn't match)
      // means there is nothing the signature could have signed.
      return false;
    }

    // Buffer.from(x, 'base64') never throws — it silently SKIPS invalid
    // characters, so "!!!!" decodes to an empty buffer rather than erroring.
    // The explicit shape check rejects such garbage up front instead of
    // letting it flow into the length comparison looking like a short digest.
    const compactHeader = hmacHeaderBase64.trim();
    if (!BASE64_SHAPE.test(compactHeader)) return false;

    const expected = createHmac('sha256', secret).update(body).digest(); // 32 bytes
    const provided = Buffer.from(compactHeader, 'base64');

    // timingSafeEqual throws on length mismatch, so guard first. This length
    // check leaks nothing useful: the attacker already knows the length of
    // the header THEY sent, and the digest length (32) is public protocol.
    if (provided.length !== expected.length) return false;

    return timingSafeEqual(expected, provided);
  } catch {
    // Absolute backstop for exotic hostile inputs (Proxy objects with
    // throwing traps, etc.) — the contract is "boolean out, always".
    return false;
  }
}
