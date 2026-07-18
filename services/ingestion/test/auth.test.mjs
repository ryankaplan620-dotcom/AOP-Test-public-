/**
 * test/auth.test.mjs — unit tests for src/lib/auth.js (timing-safe token check).
 *
 * Role in the AOP data flow: guards the Worker Ingestion Engine's bearer
 * auth. These tests pin the fail-closed contract (equal/unequal/empty/
 * non-string) and the hash-first shape that makes length mismatches safe.
 *
 * PURE-module suite: imports nothing but node:test, node:assert and the
 * module under test — must pass BEFORE `npm install` (no express/pg).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timingSafeTokenCheck } from '../src/lib/auth.js';

const SECRET = 'aop-ingest-secret-token-0123456789abcdef';

test('accepts an exactly matching token', () => {
  assert.equal(timingSafeTokenCheck(SECRET, SECRET), true);
});

test('rejects a wrong token of the same length', () => {
  const wrong = SECRET.slice(0, -1) + (SECRET.endsWith('x') ? 'y' : 'x');
  assert.equal(wrong.length, SECRET.length);
  assert.equal(timingSafeTokenCheck(wrong, SECRET), false);
});

test('rejects a token of a different length WITHOUT throwing (hash-first shape)', () => {
  // crypto.timingSafeEqual throws on length mismatch; the hash-first design
  // must absorb any length difference silently.
  assert.equal(timingSafeTokenCheck('short', SECRET), false);
  assert.equal(timingSafeTokenCheck(SECRET + 'suffix', SECRET), false);
  assert.equal(timingSafeTokenCheck('a'.repeat(10_000), SECRET), false);
});

test('rejects the empty string presented as a token', () => {
  assert.equal(timingSafeTokenCheck('', SECRET), false);
});

test('fails closed when the expected secret is empty', () => {
  // Config guarantees a non-empty secret, but a broken invariant must never
  // turn "" into a universal password.
  assert.equal(timingSafeTokenCheck('', ''), false);
  assert.equal(timingSafeTokenCheck('anything', ''), false);
});

test('fails closed on non-string inputs (missing header, hostile types)', () => {
  assert.equal(timingSafeTokenCheck(undefined, SECRET), false);
  assert.equal(timingSafeTokenCheck(null, SECRET), false);
  assert.equal(timingSafeTokenCheck(12345, SECRET), false);
  assert.equal(timingSafeTokenCheck({ token: SECRET }, SECRET), false);
  assert.equal(timingSafeTokenCheck(SECRET, undefined), false);
  assert.equal(timingSafeTokenCheck(SECRET, null), false);
});

test('is case-sensitive and whitespace-exact (no normalization back door)', () => {
  assert.equal(timingSafeTokenCheck(SECRET.toUpperCase(), SECRET), false);
  assert.equal(timingSafeTokenCheck(` ${SECRET}`, SECRET), false);
  assert.equal(timingSafeTokenCheck(`${SECRET} `, SECRET), false);
});

test('handles unicode tokens without throwing', () => {
  const unicodeSecret = 'sécret-töken-😀';
  assert.equal(timingSafeTokenCheck(unicodeSecret, unicodeSecret), true);
  assert.equal(timingSafeTokenCheck('sécret-töken-😅', unicodeSecret), false);
});
