/**
 * lib/auth.js — timing-safe bearer-token comparison for the ingest API.
 *
 * Role in the AOP data flow:
 *   The Cloudflare Worker's queue consumer authenticates its HTTPS POSTs to
 *   /ingest/telemetry with a shared bearer token (INGEST_API_TOKEN). This
 *   module is the ONLY place that token comparison happens, so the
 *   constant-time property is enforced in exactly one spot.
 *
 * Why hash-then-compare:
 *   crypto.timingSafeEqual THROWS when its inputs differ in length, and a
 *   naive length pre-check leaks the secret's length through early-return
 *   timing (an attacker probing with growing tokens sees a timing step at the
 *   true length). Hashing both sides to fixed-width SHA-256 digests first
 *   means the comparison is always 32 bytes vs 32 bytes: same code path, same
 *   duration, regardless of how long or short the presented token is.
 *
 * PURE module: no express/pg imports, no I/O — unit-tested pre-`npm install`
 * by test/auth.test.mjs.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/** Fixed-width digest of arbitrary-length input (see header for rationale). */
function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Compare a presented token against the expected secret in constant time.
 *
 * @param {unknown} headerValue  the token presented by the caller (already
 *   stripped of any "Bearer " prefix by the route layer). Any non-string —
 *   including undefined for a missing header — fails closed.
 * @param {unknown} expected     the configured INGEST_API_TOKEN.
 * @returns {boolean} true only for an exact match. Never throws.
 */
export function timingSafeTokenCheck(headerValue, expected) {
  try {
    // Fail closed on non-strings. An empty *expected* secret also fails
    // closed: config.js guarantees it's non-empty, but if that invariant is
    // ever broken, "" must not become a token that authenticates everyone.
    if (typeof headerValue !== 'string' || typeof expected !== 'string') return false;
    if (expected.length === 0) return false;

    // NOTE: hashing happens on BOTH sides unconditionally — do not "optimize"
    // by short-circuiting on length; that reintroduces the timing leak this
    // module exists to prevent.
    return timingSafeEqual(sha256(headerValue), sha256(expected));
  } catch {
    // timingSafeEqual cannot throw for equal-length buffers, but the contract
    // of this function is "never throws", so keep the belt with the braces.
    return false;
  }
}
