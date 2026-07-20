/**
 * test/api-keys.test.mjs — unit tests for lib/api-keys.js (merchant API key
 * generation + hashing, multi-tenant /analytics auth).
 *
 * PURE module: importable pre-`npm install` like the other lib suites.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { API_KEY_PREFIX, generateApiKey, hashApiKey, isApiKeyShaped } from '../src/lib/api-keys.js';

test('generateApiKey mints prefix + 43 base64url chars and matching digest', () => {
  const { plaintext, keyHash, keyPrefix } = generateApiKey();

  assert.ok(plaintext.startsWith(API_KEY_PREFIX));
  assert.equal(plaintext.length, API_KEY_PREFIX.length + 43);
  assert.match(plaintext.slice(API_KEY_PREFIX.length), /^[A-Za-z0-9_-]{43}$/);

  // The stored digest is exactly sha256(plaintext) in lowercase hex.
  assert.equal(keyHash, createHash('sha256').update(plaintext, 'utf8').digest('hex'));
  assert.match(keyHash, /^[0-9a-f]{64}$/);

  // Display prefix: recognizable but far too short to reconstruct the key.
  assert.equal(keyPrefix, plaintext.slice(0, 13));
  assert.ok(keyPrefix.length < API_KEY_PREFIX.length + 8);
});

test('generateApiKey output is unique across many mints', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const { plaintext } = generateApiKey();
    assert.ok(!seen.has(plaintext), 'duplicate key minted');
    seen.add(plaintext);
  }
});

test('hashApiKey is deterministic and rejects non-strings', () => {
  assert.equal(hashApiKey('aop_live_x'), hashApiKey('aop_live_x'));
  assert.notEqual(hashApiKey('aop_live_x'), hashApiKey('aop_live_y'));
  assert.throws(() => hashApiKey(null), TypeError);
  assert.throws(() => hashApiKey(12345), TypeError);
  assert.throws(() => hashApiKey(undefined), TypeError);
});

test('isApiKeyShaped accepts generated keys only', () => {
  assert.equal(isApiKeyShaped(generateApiKey().plaintext), true);

  // Everything that is not exactly prefix + 43 base64url chars is rejected —
  // the auth middleware uses this to skip DB probes for arbitrary bearers.
  assert.equal(isApiKeyShaped('some-dashboard-platform-token'), false);
  assert.equal(isApiKeyShaped(API_KEY_PREFIX), false);
  assert.equal(isApiKeyShaped(`${API_KEY_PREFIX}short`), false);
  assert.equal(isApiKeyShaped(`${API_KEY_PREFIX}${'a'.repeat(44)}`), false);
  assert.equal(isApiKeyShaped(`${API_KEY_PREFIX}${'a'.repeat(42)}!`), false);
  assert.equal(isApiKeyShaped(`${API_KEY_PREFIX.toUpperCase()}${'a'.repeat(43)}`), false);
  assert.equal(isApiKeyShaped(null), false);
  assert.equal(isApiKeyShaped(undefined), false);
  assert.equal(isApiKeyShaped(42), false);
  assert.equal(isApiKeyShaped(''), false);
});
