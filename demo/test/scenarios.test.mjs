/**
 * scenarios.test.mjs — unit tests for the demo scenario generator.
 * Plain `node --test`, zero deps. Uses a seeded LCG so distribution
 * assertions are deterministic.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScenario,
  weightedPick,
  mintToken,
  CATALOG,
  PROTOCOLS,
  OUTCOME_WEIGHTS,
} from '../lib/scenarios.js';

/** Deterministic [0,1) LCG for reproducible distribution tests. */
function makeRng(seed = 42) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

test('weightedPick respects weights and never returns undefined', () => {
  const rng = makeRng(7);
  const counts = {};
  for (let i = 0; i < 5000; i++) {
    const { outcome } = weightedPick(OUTCOME_WEIGHTS, rng);
    counts[outcome] = (counts[outcome] ?? 0) + 1;
  }
  // Every configured outcome appears...
  for (const { outcome } of OUTCOME_WEIGHTS) {
    assert.ok(counts[outcome] > 0, `${outcome} never produced`);
  }
  // ...and WON lands near its 30% weight (loose 20-40% band, 5k trials).
  assert.ok(counts.WON / 5000 > 0.2 && counts.WON / 5000 < 0.4, `WON share ${counts.WON / 5000}`);
});

test('tokens are unique and prefixed', () => {
  const rng = makeRng(1);
  const tokens = new Set();
  for (let i = 0; i < 1000; i++) tokens.add(mintToken(i, rng));
  assert.equal(tokens.size, 1000);
  assert.match(mintToken(5, rng), /^demo_tok_000005_/);
});

test('scenarios carry classifier-compatible loss evidence', () => {
  const rng = makeRng(9);
  const seen = new Set();
  for (let i = 0; i < 3000; i++) {
    const scenario = buildScenario(i, rng);
    seen.add(scenario.outcome);
    assert.ok(CATALOG.some((p) => p.sku === scenario.sku));
    assert.ok(PROTOCOLS.includes(scenario.protocol));
    assert.ok(scenario.probes.length >= 1);
    assert.equal(scenario.probes[0].path, '/availability');

    const quote = scenario.probes.find((p) => p.path === '/shipping_quote');
    switch (scenario.outcome) {
      case 'WON':
        assert.equal(scenario.converts, true);
        assert.match(scenario.orderTotal, /^\d+\.\d{2}$/, 'decimal-string order total');
        break;
      case 'PROTOCOL_ERROR':
        // Failed availability ping, no quote follow-up.
        assert.equal(scenario.probes[0].status, 502);
        assert.equal(quote, undefined);
        break;
      case 'PRICE_DISCREPANCY':
        // Classifier needs BOTH sides: our quoted_price and competitor_price
        // (flat key in its COMPETITOR_PRICE_KEYS list), with competitor lower.
        assert.ok(quote.payload.competitor_price < quote.payload.quoted_price);
        break;
      case 'SHIPPING_LATENCY':
        assert.ok(quote.payload.delivery_days > 3, 'over the 3-day agent threshold');
        assert.equal(quote.payload.competitor_price, undefined, 'no price signal to preempt');
        break;
      case 'STOCK_OUTAGE':
        assert.equal(quote.payload.variant_available, false);
        assert.ok(quote.payload.delivery_days <= 3, 'shipping must not preempt stock');
        break;
      case 'UNKNOWN_DROPOFF':
        assert.ok(quote.payload.delivery_days <= 3);
        assert.equal(quote.payload.competitor_price, undefined);
        assert.equal(quote.payload.variant_available, undefined);
        break;
      default:
        assert.fail(`unexpected outcome ${scenario.outcome}`);
    }
  }
  // The generator must be able to produce every outcome.
  for (const { outcome } of OUTCOME_WEIGHTS) {
    assert.ok(seen.has(outcome), `${outcome} never generated in 3000 scenarios`);
  }
});

test('non-converting scenarios never carry an order total', () => {
  const rng = makeRng(3);
  for (let i = 0; i < 500; i++) {
    const scenario = buildScenario(i, rng);
    if (!scenario.converts) assert.equal(scenario.orderTotal, null);
  }
});
