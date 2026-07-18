/**
 * test/shopify-hmac.test.mjs — unit tests for src/lib/shopify-hmac.js.
 *
 * Role in the AOP data flow: pins the authenticity gate in front of the
 * Webhook Receiver Engine — the ONLY thing standing between a forged HTTP
 * POST and a fabricated commission-bearing order. Covers accept, reject,
 * and the full garbage-tolerance contract (returns false, never throws).
 *
 * PURE-module suite: imports nothing but node:test, node:assert,
 * node:crypto and the module under test — must pass BEFORE `npm install`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyShopifyHmac } from '../src/lib/shopify-hmac.js';

const SECRET = 'shpss_test_webhook_secret_42';
const ORDER_BODY = Buffer.from(
  JSON.stringify({
    id: 5678901234,
    total_price: '129.90',
    note_attributes: [{ name: 'aop_transaction_token', value: 'tok_abc123' }],
  }),
  'utf8'
);

/** Sign exactly the way Shopify does: base64(HMAC-SHA256(secret, raw bytes)). */
function shopifySign(body, secret) {
  return createHmac('sha256', secret).update(body).digest('base64');
}

test('accepts a correctly signed body', () => {
  const header = shopifySign(ORDER_BODY, SECRET);
  assert.equal(verifyShopifyHmac(ORDER_BODY, header, SECRET), true);
});

test('accepts a signed string body (defensive string path, UTF-8 semantics)', () => {
  const bodyString = ORDER_BODY.toString('utf8');
  const header = shopifySign(Buffer.from(bodyString, 'utf8'), SECRET);
  assert.equal(verifyShopifyHmac(bodyString, header, SECRET), true);
});

test('rejects when the body was tampered with after signing', () => {
  const header = shopifySign(ORDER_BODY, SECRET);
  const tampered = Buffer.from(ORDER_BODY.toString('utf8').replace('129.90', '1.00'), 'utf8');
  assert.equal(verifyShopifyHmac(tampered, header, SECRET), false);
});

test('rejects a signature minted with the wrong secret', () => {
  const header = shopifySign(ORDER_BODY, 'some-other-secret');
  assert.equal(verifyShopifyHmac(ORDER_BODY, header, SECRET), false);
});

test('rejects even a single flipped byte in the signature', () => {
  const header = shopifySign(ORDER_BODY, SECRET);
  const flipped = (header[0] === 'A' ? 'B' : 'A') + header.slice(1);
  assert.equal(verifyShopifyHmac(ORDER_BODY, flipped, SECRET), false);
});

test('returns false (never throws) on a missing header', () => {
  assert.equal(verifyShopifyHmac(ORDER_BODY, undefined, SECRET), false);
  assert.equal(verifyShopifyHmac(ORDER_BODY, null, SECRET), false);
  assert.equal(verifyShopifyHmac(ORDER_BODY, '', SECRET), false);
});

test('returns false (never throws) on garbage headers', () => {
  // Not base64 at all.
  assert.equal(verifyShopifyHmac(ORDER_BODY, '!!!!not-base64!!!!', SECRET), false);
  // Valid base64 alphabet but wrong decoded length (not a 32-byte digest).
  assert.equal(verifyShopifyHmac(ORDER_BODY, 'QUJD', SECRET), false); // "ABC"
  // Empty-ish decodes.
  assert.equal(verifyShopifyHmac(ORDER_BODY, '====', SECRET), false);
  // Non-string exotic types.
  assert.equal(verifyShopifyHmac(ORDER_BODY, 12345, SECRET), false);
  assert.equal(verifyShopifyHmac(ORDER_BODY, { hmac: 'x' }, SECRET), false);
  assert.equal(verifyShopifyHmac(ORDER_BODY, Buffer.from('abc'), SECRET), false);
});

test('returns false (never throws) on bodyless / non-buffer bodies', () => {
  const header = shopifySign(ORDER_BODY, SECRET);
  assert.equal(verifyShopifyHmac(undefined, header, SECRET), false);
  assert.equal(verifyShopifyHmac(null, header, SECRET), false);
  assert.equal(verifyShopifyHmac({ parsed: 'object' }, header, SECRET), false);
  assert.equal(verifyShopifyHmac(42, header, SECRET), false);
});

test('fails closed when the secret is missing or empty', () => {
  const header = shopifySign(ORDER_BODY, SECRET);
  assert.equal(verifyShopifyHmac(ORDER_BODY, header, ''), false);
  assert.equal(verifyShopifyHmac(ORDER_BODY, header, undefined), false);
  assert.equal(verifyShopifyHmac(ORDER_BODY, header, null), false);
});

test('accepts an empty body when signed as such (Shopify test pings)', () => {
  const empty = Buffer.alloc(0);
  const header = shopifySign(empty, SECRET);
  assert.equal(verifyShopifyHmac(empty, header, SECRET), true);
});

test('tolerates surrounding whitespace on the header value', () => {
  const header = shopifySign(ORDER_BODY, SECRET);
  assert.equal(verifyShopifyHmac(ORDER_BODY, `  ${header}  `, SECRET), true);
});
