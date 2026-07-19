/**
 * lib/shopify-oauth.js — pure helpers for the Shopify OAuth install flow.
 *
 * Role in the AOP data flow:
 *   [merchant clicks Install] -> GET /auth/install?shop=x.myshopify.com
 *     -> buildAuthorizeUrl() (with a signed state nonce)
 *   [Shopify redirects back] -> GET /auth/callback?code&hmac&shop&state&timestamp
 *     -> verifyOAuthHmac() + verifyStateNonce() -> token exchange (route layer)
 *     -> encryptToken() -> merchant_profiles upsert -> webhook registration.
 *
 * Everything here is PURE (node:crypto only, no I/O) so the security-critical
 * verification logic is unit-tested pre-`npm install`. The route layer
 * (src/routes/oauth.js) owns the network calls.
 *
 * Security notes:
 *  - OAuth callback HMAC (Shopify contract): hex-encoded HMAC-SHA256 over the
 *    query string with `hmac`/`signature` removed and remaining params sorted
 *    lexicographically, keyed by the app's API secret. Compared timing-safely.
 *  - State nonce: stateless, HMAC-signed, expiring — `<ts>.<rand>.<sig>`.
 *    No server-side session store needed; forgery requires the API secret and
 *    replay is bounded by the TTL. (CSRF here is belt-and-braces: the callback
 *    HMAC already authenticates the whole query as Shopify-signed.)
 *  - Shop domain: strictly validated as *.myshopify.com before it is ever
 *    interpolated into a redirect URL or an Admin API hostname — a hostile
 *    `shop` param must never turn our redirect/exchange into an open relay.
 */

import crypto from 'node:crypto';

/** Admin API scopes the app requests at install. */
export const OAUTH_SCOPES = 'read_products,read_orders';

/** Nonce lifetime: installs are interactive; 10 minutes is generous. */
export const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Strict *.myshopify.com validation. Lowercased canonical form returned;
 * null for anything else (subdomain label rules per RFC + Shopify's own
 * charset: alphanumerics and hyphens, no leading/trailing hyphen).
 *
 * @param {unknown} shop
 * @returns {string|null}
 */
export function normalizeShopDomain(shop) {
  if (typeof shop !== 'string') return null;
  const candidate = shop.trim().toLowerCase();
  const match = /^([a-z0-9][a-z0-9-]*[a-z0-9]|[a-z0-9])\.myshopify\.com$/.exec(candidate);
  return match ? candidate : null;
}

/**
 * Verify the OAuth callback HMAC per Shopify's contract.
 *
 * @param {Record<string, string|string[]>} query parsed query params.
 * @param {string} apiSecret the app's API secret.
 * @returns {boolean} never throws.
 */
export function verifyOAuthHmac(query, apiSecret) {
  try {
    if (query === null || typeof query !== 'object') return false;
    const presented = query.hmac;
    if (typeof presented !== 'string' || !/^[0-9a-f]{64}$/i.test(presented)) return false;

    const message = Object.keys(query)
      .filter((key) => key !== 'hmac' && key !== 'signature')
      .sort()
      .map((key) => {
        // Repeated params arrive as arrays; Shopify joins them with commas.
        const value = Array.isArray(query[key]) ? query[key].join(',') : String(query[key]);
        return `${key}=${value}`;
      })
      .join('&');

    const expected = crypto.createHmac('sha256', apiSecret).update(message, 'utf8').digest();
    const given = Buffer.from(presented, 'hex');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  } catch {
    return false;
  }
}

/**
 * Mint a stateless, signed, expiring state nonce: `<ts>.<rand>.<sig>`.
 * @param {string} apiSecret signing key (the app secret — already required
 *   config, no extra key material to manage).
 * @param {number} [now] injected clock for tests.
 * @returns {string}
 */
export function createStateNonce(apiSecret, now = Date.now()) {
  const body = `${now}.${crypto.randomBytes(16).toString('hex')}`;
  const sig = crypto.createHmac('sha256', apiSecret).update(body, 'utf8').digest('hex');
  return `${body}.${sig}`;
}

/**
 * Verify a state nonce: signature (timing-safe) + TTL.
 * @param {unknown} nonce
 * @param {string} apiSecret
 * @param {number} [now] injected clock for tests.
 * @returns {boolean} never throws.
 */
export function verifyStateNonce(nonce, apiSecret, now = Date.now()) {
  try {
    if (typeof nonce !== 'string') return false;
    const parts = nonce.split('.');
    if (parts.length !== 3) return false;
    const [tsRaw, rand, sig] = parts;
    if (!/^[0-9a-f]{64}$/.test(sig)) return false;
    const expected = crypto
      .createHmac('sha256', apiSecret)
      .update(`${tsRaw}.${rand}`, 'utf8')
      .digest('hex');
    const givenBuf = Buffer.from(sig, 'hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    if (givenBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(givenBuf, expectedBuf)) {
      return false;
    }
    const ts = Number(tsRaw);
    if (!Number.isFinite(ts)) return false;
    // Reject both expired nonces and "from the future" clocks (>1min skew).
    return now - ts <= STATE_TTL_MS && ts - now <= 60_000;
  } catch {
    return false;
  }
}

/**
 * Build the Shopify authorize URL for the install redirect.
 * @param {{shop: string, apiKey: string, appUrl: string, state: string}} params
 *   shop MUST already be normalizeShopDomain()-validated.
 * @returns {string}
 */
export function buildAuthorizeUrl({ shop, apiKey, appUrl, state }) {
  const url = new URL(`https://${shop}/admin/oauth/authorize`);
  url.searchParams.set('client_id', apiKey);
  url.searchParams.set('scope', OAUTH_SCOPES);
  url.searchParams.set('redirect_uri', `${appUrl.replace(/\/+$/, '')}/auth/callback`);
  url.searchParams.set('state', state);
  return url.toString();
}
