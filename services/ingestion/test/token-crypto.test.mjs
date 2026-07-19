/**
 * token-crypto.test.mjs — unit tests for merchant OAuth token encryption
 * (src/lib/token-crypto.js). Pure node:crypto; passes before npm install.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { parseEncryptionKey, encryptToken, decryptToken } from '../src/lib/token-crypto.js';

const KEY_HEX = crypto.randomBytes(32).toString('hex');
const KEY = parseEncryptionKey(KEY_HEX);
const SHOP = 'redthread.myshopify.com';

test('parseEncryptionKey accepts 64 hex chars and rejects everything else', () => {
  assert.equal(parseEncryptionKey(KEY_HEX).length, 32);
  assert.equal(parseEncryptionKey(` ${KEY_HEX} `).length, 32, 'whitespace tolerated');
  for (const bad of ['', 'abc', KEY_HEX.slice(0, 63), `${KEY_HEX}0`, 'z'.repeat(64), null, 42]) {
    assert.throws(() => parseEncryptionKey(bad), /64 hex/, String(bad).slice(0, 20));
  }
});

test('round-trip: encrypt then decrypt recovers the token', () => {
  const token = 'shpat_0123456789abcdef0123456789abcdef';
  const ciphertext = encryptToken(token, KEY, SHOP);
  assert.match(ciphertext, /^enc:v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
  assert.ok(!ciphertext.includes(token), 'plaintext must not appear in ciphertext');
  assert.equal(decryptToken(ciphertext, KEY, SHOP), token);
});

test('unique IV per call: same input encrypts differently every time', () => {
  const a = encryptToken('same-token', KEY, SHOP);
  const b = encryptToken('same-token', KEY, SHOP);
  assert.notEqual(a, b);
  assert.equal(decryptToken(a, KEY, SHOP), decryptToken(b, KEY, SHOP));
});

test('AAD binding: ciphertext refuses to decrypt for a different shop', () => {
  const ciphertext = encryptToken('shpat_secret', KEY, SHOP);
  assert.throws(() => decryptToken(ciphertext, KEY, 'other.myshopify.com'));
  // ...but domain CASE differences must not break decryption.
  assert.equal(decryptToken(ciphertext, KEY, 'RedThread.MYSHOPIFY.com'), 'shpat_secret');
});

test('tampering with any part fails decryption', () => {
  const ciphertext = encryptToken('shpat_secret', KEY, SHOP);
  const parts = ciphertext.split(':'); // enc v1 iv tag ct
  for (let i = 2; i < 5; i++) {
    const mutated = [...parts];
    const buf = Buffer.from(mutated[i], 'base64');
    buf[0] ^= 0xff;
    mutated[i] = buf.toString('base64');
    assert.throws(() => decryptToken(mutated.join(':'), KEY, SHOP), undefined, `part ${i}`);
  }
});

test('wrong key fails; malformed/unversioned inputs are rejected cleanly', () => {
  const ciphertext = encryptToken('shpat_secret', KEY, SHOP);
  const otherKey = parseEncryptionKey(crypto.randomBytes(32).toString('hex'));
  assert.throws(() => decryptToken(ciphertext, otherKey, SHOP));
  for (const bad of ['plaintext-token', 'enc:v2:a:b:c', 'enc:v1:only-two:parts', '', null]) {
    assert.throws(() => decryptToken(bad, KEY, SHOP));
  }
});

test('encrypt rejects empty tokens and bad keys', () => {
  assert.throws(() => encryptToken('', KEY, SHOP), /empty/);
  assert.throws(() => encryptToken('x', Buffer.alloc(16), SHOP), /32-byte/);
});
