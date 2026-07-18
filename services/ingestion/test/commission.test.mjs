/**
 * test/commission.test.mjs — unit tests for src/lib/commission.js.
 *
 * Role in the AOP data flow: pins the integer-cents money math used for
 * commission verification/reporting so it can never drift from the DB's
 * generated column round(gmv * rate, 2) — including half-up cent rounding
 * and NUMERIC(12,2)-scale magnitudes.
 *
 * PURE-module suite: imports nothing but node:test, node:assert and the
 * module under test — must pass BEFORE `npm install` (no express/pg).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMoneyToCents,
  computeCommissionCents,
  formatCentsAsDecimal,
  MAX_MONEY_CENTS,
  DEFAULT_COMMISSION_RATE,
} from '../src/lib/commission.js';

/* ---------------------------- parseMoneyToCents ---------------------------- */

test('parses canonical Shopify decimal strings exactly', () => {
  assert.equal(parseMoneyToCents('19.99'), 1999);
  assert.equal(parseMoneyToCents('0.01'), 1);
  assert.equal(parseMoneyToCents('0.00'), 0);
  assert.equal(parseMoneyToCents('129.90'), 12990);
  assert.equal(parseMoneyToCents('1000000.00'), 100_000_000);
});

test('parses bare integers and single-decimal strings', () => {
  assert.equal(parseMoneyToCents('10'), 1000);
  assert.equal(parseMoneyToCents('1234.5'), 123450);
  assert.equal(parseMoneyToCents('0'), 0);
});

test('is whitespace-tolerant and accepts a leading plus', () => {
  assert.equal(parseMoneyToCents('  7.25  '), 725);
  assert.equal(parseMoneyToCents('+3.10'), 310);
});

test('rounds beyond-cent precision HALF-UP at the cent', () => {
  assert.equal(parseMoneyToCents('1.005'), 101); // exactly half a cent -> up
  assert.equal(parseMoneyToCents('1.004999'), 100); // just below half -> down
  assert.equal(parseMoneyToCents('12.345'), 1235);
  assert.equal(parseMoneyToCents('12.3449'), 1234);
});

test('defensively accepts finite non-negative numbers', () => {
  assert.equal(parseMoneyToCents(19.99), 1999);
  assert.equal(parseMoneyToCents(0), 0);
  assert.equal(parseMoneyToCents(100), 10000);
});

test('rejects negatives, garbage, and non-money types with null (never throws)', () => {
  assert.equal(parseMoneyToCents('-5.00'), null);
  assert.equal(parseMoneyToCents(-1), null);
  assert.equal(parseMoneyToCents('1,234.56'), null); // thousands separator
  assert.equal(parseMoneyToCents('$19.99'), null);
  assert.equal(parseMoneyToCents('19.99 USD'), null);
  assert.equal(parseMoneyToCents('1e5'), null);
  assert.equal(parseMoneyToCents(''), null);
  assert.equal(parseMoneyToCents('.'), null);
  assert.equal(parseMoneyToCents('.99'), null); // Shopify always emits a whole part
  assert.equal(parseMoneyToCents(null), null);
  assert.equal(parseMoneyToCents(undefined), null);
  assert.equal(parseMoneyToCents({ amount: '19.99' }), null);
  assert.equal(parseMoneyToCents(NaN), null);
  assert.equal(parseMoneyToCents(Infinity), null);
});

test('enforces the NUMERIC(12,2) ceiling and DoS-scale digit strings', () => {
  assert.equal(parseMoneyToCents('9999999999.99'), MAX_MONEY_CENTS);
  assert.equal(parseMoneyToCents('10000000000.00'), null); // one cent past the column max
  assert.equal(parseMoneyToCents('9'.repeat(500)), null); // absurd digit flood
});

/* -------------------------- computeCommissionCents ------------------------- */

test('computes the flat 0.5% commission on typical GMVs (matches DB half-up)', () => {
  // $19.99 -> 1999c * 0.005 = 9.995c -> 10c (DB: round(0.09995, 2) = 0.10)
  assert.equal(computeCommissionCents(1999), 10);
  // $100.00 -> 50c exactly
  assert.equal(computeCommissionCents(10000), 50);
  // $129.90 -> 64.95c -> 65c
  assert.equal(computeCommissionCents(12990), 65);
});

test('handles the $0.01 floor edge without drift', () => {
  // 1c * 0.005 = 0.005c -> rounds DOWN to 0 (DB: round(0.00005, 2) = 0.00)
  assert.equal(computeCommissionCents(1), 0);
  assert.equal(computeCommissionCents(0), 0);
});

test('half-up boundary: exactly half a cent rounds up like the DB', () => {
  // $1.00 -> 100c * 0.005 = 0.5c -> 1c (DB: round(0.005, 2) = 0.01)
  assert.equal(computeCommissionCents(100), 1);
  // $3.00 -> 1.5c -> 2c
  assert.equal(computeCommissionCents(300), 2);
});

test('huge GMV stays exact (no float, no 2^53 drift)', () => {
  // NUMERIC(12,2) max: $9,999,999,999.99 -> 4,999,999,999.995c -> 5,000,000,000c.
  // The intermediate product 999,999,999,999 * 5000 = ~5.0e15 sits right at
  // the edge of IEEE-754's safe-integer range — the BigInt path must land it
  // exactly where PostgreSQL's NUMERIC math does.
  assert.equal(computeCommissionCents(MAX_MONEY_CENTS), 5_000_000_000);
  // One cent below the ceiling: 999,999,999,998c * 0.005 = 4,999,999,999.99c -> half-up -> 5,000,000,000c.
  assert.equal(computeCommissionCents(MAX_MONEY_CENTS - 1), 5_000_000_000);
  // A mid-scale exactness spot check: $86,753,090.91 -> 43,376,545.455c -> 43,376,545c.
  assert.equal(computeCommissionCents(8_675_309_091), 43_376_545);
});

test('supports explicit non-default rates', () => {
  assert.equal(computeCommissionCents(10000, 0.01), 100); // 1% of $100
  assert.equal(computeCommissionCents(10000, 0), 0); // 0% is legal
  assert.equal(computeCommissionCents(999, 0.025), 25); // 24.975c -> 25c
});

test('default rate constant matches the DB column default', () => {
  assert.equal(DEFAULT_COMMISSION_RATE, 0.005);
  assert.equal(computeCommissionCents(1999), computeCommissionCents(1999, 0.005));
});

test('rejects invalid GMV/rate inputs with null (never throws)', () => {
  assert.equal(computeCommissionCents(-1), null);
  assert.equal(computeCommissionCents(19.99), null); // cents must be integers
  assert.equal(computeCommissionCents('1999'), null);
  assert.equal(computeCommissionCents(null), null);
  assert.equal(computeCommissionCents(Number.MAX_SAFE_INTEGER + 1), null);
  assert.equal(computeCommissionCents(MAX_MONEY_CENTS + 1), null);
  assert.equal(computeCommissionCents(1000, -0.005), null);
  assert.equal(computeCommissionCents(1000, 1.5), null); // >100% is corrupt
  assert.equal(computeCommissionCents(1000, NaN), null);
  assert.equal(computeCommissionCents(1000, '0.005'), null);
});

/* --------------------------- formatCentsAsDecimal -------------------------- */

test('formats integer cents as NUMERIC-ready decimal strings', () => {
  assert.equal(formatCentsAsDecimal(1999), '19.99');
  assert.equal(formatCentsAsDecimal(5), '0.05');
  assert.equal(formatCentsAsDecimal(0), '0.00');
  assert.equal(formatCentsAsDecimal(100), '1.00');
  assert.equal(formatCentsAsDecimal(5_000_000_000), '50000000.00');
});

test('round-trips with parseMoneyToCents', () => {
  for (const cents of [0, 1, 99, 100, 1999, 12990, MAX_MONEY_CENTS]) {
    assert.equal(parseMoneyToCents(formatCentsAsDecimal(cents)), cents);
  }
});

test('formatCentsAsDecimal rejects invalid input with null', () => {
  assert.equal(formatCentsAsDecimal(-1), null);
  assert.equal(formatCentsAsDecimal(1.5), null);
  assert.equal(formatCentsAsDecimal('1999'), null);
  assert.equal(formatCentsAsDecimal(null), null);
});
