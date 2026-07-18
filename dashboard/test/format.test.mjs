/**
 * format.test.mjs — unit tests for the dashboard's pure formatting helpers.
 * Plain `node --test`: no browser, no bundler, no React.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney, formatCount, formatPct, formatClock, lossReasonLabel } from '../src/format.js';

test('formatMoney renders decimal strings and degrades to em-dash', () => {
  assert.equal(formatMoney('165220.00'), '$165,220.00');
  assert.equal(formatMoney('0.65'), '$0.65');
  assert.equal(formatMoney(1234.5), '$1,234.50');
  assert.equal(formatMoney(null), '—');
  assert.equal(formatMoney('not-money'), '—');
  assert.equal(formatMoney(''), '—');
});

test('formatCount adds thousands separators', () => {
  assert.equal(formatCount(42150), '42,150');
  assert.equal(formatCount('843'), '843');
  assert.equal(formatCount(undefined), '—');
});

test('formatPct renders one decimal', () => {
  assert.equal(formatPct(2), '2.0%');
  assert.equal(formatPct(66.7), '66.7%');
  assert.equal(formatPct(NaN), '—');
});

test('formatClock renders HH:MM:SS and tolerates garbage', () => {
  assert.match(formatClock('2026-07-18T08:12:04Z'), /^\d{2}:\d{2}:\d{2}$/);
  assert.equal(formatClock('nope'), '—');
  assert.equal(formatClock(null), '—');
});

test('lossReasonLabel maps known codes and passes through novel ones', () => {
  assert.equal(lossReasonLabel('SHIPPING_LATENCY'), 'Delivery Speed');
  assert.equal(lossReasonLabel('PRICE_DISCREPANCY'), 'Price Discrepancy');
  assert.equal(lossReasonLabel('FUTURE_REASON'), 'FUTURE_REASON');
});
