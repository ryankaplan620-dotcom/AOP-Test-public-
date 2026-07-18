/**
 * analytics-params.test.mjs — unit tests for the pure /analytics query-param
 * parsing (src/lib/analytics-params.js).
 *
 * PURE-module suite: imports nothing but node:test, node:assert and the
 * module under test — passes before `npm install`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampInt,
  parseWindowDays,
  parseLimit,
  percentShare,
  DEFAULT_WINDOW_DAYS,
  MAX_WINDOW_DAYS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from '../src/lib/analytics-params.js';

test('parseWindowDays defaults, parses, and clamps', () => {
  assert.equal(parseWindowDays(undefined), DEFAULT_WINDOW_DAYS);
  assert.equal(parseWindowDays('30'), 30);
  assert.equal(parseWindowDays('999999'), MAX_WINDOW_DAYS, 'hostile window clamped to retention cap');
  assert.equal(parseWindowDays('0'), 1);
  assert.equal(parseWindowDays('-5'), 1);
  assert.equal(parseWindowDays('banana'), DEFAULT_WINDOW_DAYS, 'garbage degrades to default, never 400');
});

test('parseLimit defaults, parses, and clamps', () => {
  assert.equal(parseLimit(undefined), DEFAULT_LIMIT);
  assert.equal(parseLimit('100'), 100);
  assert.equal(parseLimit('1000000'), MAX_LIMIT);
  assert.equal(parseLimit(''), DEFAULT_LIMIT);
});

test('clampInt takes the first value of a repeated query param', () => {
  // express yields arrays for ?days=3&days=90 — first occurrence wins.
  assert.equal(clampInt(['3', '90'], { def: 7, min: 1, max: 90 }), 3);
});

test('clampInt tolerates hostile shapes', () => {
  assert.equal(clampInt({ evil: true }, { def: 7, min: 1, max: 90 }), 7);
  assert.equal(clampInt(null, { def: 7, min: 1, max: 90 }), 7);
  assert.equal(clampInt('12.9', { def: 7, min: 1, max: 90 }), 12, 'parseInt semantics');
});

test('percentShare rounds to one decimal and never yields NaN', () => {
  assert.equal(percentShare(843, 42150), 2);
  assert.equal(percentShare(1, 3), 33.3);
  assert.equal(percentShare(0, 0), 0, 'empty window renders 0%, not NaN');
  assert.equal(percentShare(5, 0), 0);
  assert.equal(percentShare('x', 10), 0);
});
