/**
 * shopify-oauth.test.mjs — unit tests for the pure OAuth helpers
 * (src/lib/shopify-oauth.js). node:crypto only; passes before npm install.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  normalizeShopDomain,
  verifyOAuthHmac,
  createStateNonce,
  verifyStateNonce,
  buildAuthorizeUrl,
  OAUTH_SCOPES,
  STATE_TTL_MS,
} from '../src/lib/shopify-oauth.js';

const SECRET = 'shpss_test_secret';

/** Sign a query object exactly like Shopify does. */
function signQuery(query, secret = SECRET) {
  const message = Object.keys(query)
    .filter((k) => k !== 'hmac' && k !== 'signature')
    .sort()
    .map((k) => `${k}=${Array.isArray(query[k]) ? query[k].join(',') : query[k]}`)
    .join('&');
  return { ...query, hmac: crypto.createHmac('sha256', secret).update(message).digest('hex') };
}

test('normalizeShopDomain accepts only *.myshopify.com', () => {
  assert.equal(normalizeShopDomain('RedThread.MyShopify.com'), 'redthread.myshopify.com');
  assert.equal(normalizeShopDomain('a.myshopify.com'), 'a.myshopify.com');
  for (const bad of [
    'evil.com',
    'redthread.myshopify.com.evil.com',
    'evil.com/redthread.myshopify.com',
    '-bad.myshopify.com',
    'bad-.myshopify.com',
    'sub.shop.myshopify.com',
    'myshopify.com',
    '',
    null,
    42,
  ]) {
    assert.equal(normalizeShopDomain(bad), null, String(bad));
  }
});

test('verifyOAuthHmac accepts a correctly signed query', () => {
  const query = signQuery({
    code: 'authcode123',
    shop: 'redthread.myshopify.com',
    state: 'nonce',
    timestamp: '1700000000',
  });
  assert.equal(verifyOAuthHmac(query, SECRET), true);
});

test('verifyOAuthHmac rejects tampering, wrong secret, and missing hmac', () => {
  const query = signQuery({ code: 'authcode123', shop: 'redthread.myshopify.com', timestamp: '1' });
  assert.equal(verifyOAuthHmac({ ...query, shop: 'evil.myshopify.com' }, SECRET), false, 'tampered param');
  assert.equal(verifyOAuthHmac(query, 'other-secret'), false, 'wrong secret');
  const { hmac, ...noHmac } = query;
  assert.equal(verifyOAuthHmac(noHmac, SECRET), false, 'missing hmac');
  assert.equal(verifyOAuthHmac({ ...query, hmac: 'zz'.repeat(32) }, SECRET), false, 'non-hex hmac');
  assert.equal(verifyOAuthHmac(null, SECRET), false);
});

test('verifyOAuthHmac excludes the signature param and joins repeated params with commas', () => {
  const query = signQuery({ shop: 'a.myshopify.com', ids: ['1', '2'], signature: 'legacy' });
  assert.equal(verifyOAuthHmac(query, SECRET), true);
});

test('state nonce round-trips, expires, and rejects forgery', () => {
  const now = 1_700_000_000_000;
  const nonce = createStateNonce(SECRET, now);
  assert.equal(verifyStateNonce(nonce, SECRET, now), true);
  assert.equal(verifyStateNonce(nonce, SECRET, now + STATE_TTL_MS - 1), true, 'within TTL');
  assert.equal(verifyStateNonce(nonce, SECRET, now + STATE_TTL_MS + 1), false, 'expired');
  assert.equal(verifyStateNonce(nonce, 'other-secret', now), false, 'wrong key');
  // Forged: re-sign a doctored timestamp with the wrong key material.
  const [ts, rand] = nonce.split('.');
  const forged = `${Number(ts) + 999999}.${rand}.${'ab'.repeat(32)}`;
  assert.equal(verifyStateNonce(forged, SECRET, now), false);
  assert.equal(verifyStateNonce('garbage', SECRET, now), false);
  assert.equal(verifyStateNonce(null, SECRET, now), false);
});

test('buildAuthorizeUrl targets the validated shop with the exact contract params', () => {
  const url = new URL(
    buildAuthorizeUrl({
      shop: 'redthread.myshopify.com',
      apiKey: 'api_key_x',
      appUrl: 'https://ingest.aop.network/',
      state: 'nonce123',
    }),
  );
  assert.equal(url.origin, 'https://redthread.myshopify.com');
  assert.equal(url.pathname, '/admin/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'api_key_x');
  assert.equal(url.searchParams.get('scope'), OAUTH_SCOPES);
  assert.equal(url.searchParams.get('redirect_uri'), 'https://ingest.aop.network/auth/callback');
  assert.equal(url.searchParams.get('state'), 'nonce123');
});

test('deriveProxyHostname builds <handle><suffix> or null', async () => {
  const { deriveProxyHostname } = await import('../src/lib/shopify-oauth.js');
  assert.equal(deriveProxyHostname('redthread.myshopify.com', '.agents.aop.network'), 'redthread.agents.aop.network');
  assert.equal(deriveProxyHostname('RedThread.MyShopify.com', '.agents.aop.network'), 'redthread.agents.aop.network');
  assert.equal(deriveProxyHostname('redthread.myshopify.com', null), null, 'no suffix -> null');
  assert.equal(deriveProxyHostname('redthread.myshopify.com', 'nodot'), null, 'suffix must start with dot');
  assert.equal(deriveProxyHostname('evil.com', '.agents.aop.network'), null, 'invalid shop -> null');
});
