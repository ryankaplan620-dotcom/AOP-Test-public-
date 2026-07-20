/**
 * lib/api-keys.js — merchant API key generation + hashing (multi-tenant auth).
 *
 * Role in the AOP data flow:
 *   The platform operator issues one of these keys per merchant (POST
 *   /analytics/keys); the merchant's dashboard presents it as a bearer token
 *   on /analytics reads and the auth middleware scopes every query to that
 *   merchant_id. The DASHBOARD_API_TOKEN remains the platform-wide
 *   credential; these keys are strictly narrower.
 *
 * Storage contract (migration 0014):
 *   Only the SHA-256 hex digest of the key is ever persisted. Lookup is
 *   hash-then-index: the presented key is digested and matched against the
 *   UNIQUE key_hash column. Unlike password checking this needs no
 *   constant-time comparison or salt: the input is 256 bits of CSPRNG
 *   output, so an attacker can neither dictionary-attack the digest nor
 *   learn anything from B-tree comparison timing (every probe's digest is
 *   effectively random). The platform token — a human-chosen secret — keeps
 *   its timing-safe comparison in lib/auth.js.
 *
 * PURE module: no express/pg imports — unit-tested by test/api-keys.test.mjs.
 */

import { createHash, randomBytes } from 'node:crypto';

/**
 * Recognizable prefix, GitHub-token style: greppable in leaked logs/repos
 * (secret scanners can be taught 'aop_live_'), and the auth middleware can
 * skip a DB round trip for bearers that cannot possibly be merchant keys.
 */
export const API_KEY_PREFIX = 'aop_live_';

/** 32 CSPRNG bytes -> 43 base64url chars; prefix + body = 52 chars total. */
const KEY_RANDOM_BYTES = 32;

/** Chars of plaintext kept as the display prefix (migration 0014 comment). */
const DISPLAY_PREFIX_CHARS = 13; // 'aop_live_' + 4 leader chars

/**
 * Shape gate for the auth middleware: prefix plus base64url body of the
 * exact generated length. Anything else skips the DB lookup entirely (the
 * platform token was already checked first).
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isApiKeyShaped(value) {
  return (
    typeof value === 'string' &&
    value.startsWith(API_KEY_PREFIX) &&
    /^[A-Za-z0-9_-]{43}$/.test(value.slice(API_KEY_PREFIX.length))
  );
}

/**
 * SHA-256 hex digest of a plaintext key — the ONLY form that touches the
 * database. Lowercase hex to match the migration's CHECK.
 *
 * @param {string} plaintext
 * @returns {string} 64 lowercase hex chars
 * @throws {TypeError} on non-string input (programmer error, not user input:
 *   callers gate with isApiKeyShaped first).
 */
export function hashApiKey(plaintext) {
  if (typeof plaintext !== 'string') {
    throw new TypeError('hashApiKey expects a string');
  }
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/**
 * Mint a new merchant API key.
 *
 * @returns {{plaintext: string, keyHash: string, keyPrefix: string}}
 *   plaintext is returned to the caller EXACTLY ONCE (the create route's
 *   response) and must never be logged or persisted; keyHash + keyPrefix are
 *   what the repository stores.
 */
export function generateApiKey() {
  const plaintext = API_KEY_PREFIX + randomBytes(KEY_RANDOM_BYTES).toString('base64url');
  return {
    plaintext,
    keyHash: hashApiKey(plaintext),
    keyPrefix: plaintext.slice(0, DISPLAY_PREFIX_CHARS),
  };
}
