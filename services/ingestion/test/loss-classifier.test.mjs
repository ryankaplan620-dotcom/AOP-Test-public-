/**
 * test/loss-classifier.test.mjs — unit tests for src/lib/loss-classifier.js.
 *
 * Role in the AOP data flow: pins the heuristic that turns expired intents
 * into loss_diagnostics rows. Covers every reason's trigger, the priority
 * order, the UNKNOWN_DROPOFF fallback, revenue estimation, and the
 * never-throws contract against hostile/malformed payload shapes.
 *
 * PURE-module suite: imports nothing but node:test, node:assert and the
 * modules under test — must pass BEFORE `npm install` (no express/pg).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLoss, LOSS_REASONS, SHIPPING_LATENCY_THRESHOLD_DAYS } from '../src/lib/loss-classifier.js';

/** Convenience: a realistic intent row with an overridable payload. */
function intentRow(payload, overrides = {}) {
  return {
    id: 'f2a4c78e-0000-4000-8000-000000000001',
    merchant_id: 'f2a4c78e-0000-4000-8000-000000000002',
    transaction_token: 'tok_test_1',
    protocol_type: 'STRIPE_ACP',
    request_method: 'POST',
    endpoint_path: '/availability',
    target_sku: 'SKU-RED-42',
    inbound_payload: payload,
    processed_at: '2026-07-17T12:00:00.000Z',
    ...overrides,
  };
}

/* ------------------------------ reason triggers ---------------------------- */

test('PRICE_DISCREPANCY: competitor price below ours', () => {
  const verdict = classifyLoss(
    intentRow({ price: '24.99', competitor_price: '18.99' })
  );
  assert.equal(verdict.reason, LOSS_REASONS.PRICE_DISCREPANCY);
  assert.equal(verdict.estimatedRevenueLost, 2499); // integer cents of OUR price
  assert.equal(verdict.competitorDelta.our_price_cents, 2499);
  assert.equal(verdict.competitorDelta.competitor_price_cents, 1899);
  assert.equal(verdict.competitorDelta.delta_cents, 600);
});

test('PRICE_DISCREPANCY: cheapest entry of a competitors[] array wins', () => {
  const verdict = classifyLoss(
    intentRow({
      total: 50.0,
      competitors: [{ price: '49.99' }, { price: '39.99' }, { price: 'garbage' }],
    })
  );
  assert.equal(verdict.reason, LOSS_REASONS.PRICE_DISCREPANCY);
  assert.equal(verdict.competitorDelta.competitor_price_cents, 3999);
});

test('no PRICE_DISCREPANCY when the competitor is NOT cheaper', () => {
  const verdict = classifyLoss(intentRow({ price: '18.99', competitor_price: '24.99' }));
  assert.equal(verdict.reason, LOSS_REASONS.UNKNOWN_DROPOFF);
});

test('no PRICE_DISCREPANCY without our own price to compare against', () => {
  const verdict = classifyLoss(intentRow({ competitor_price: '18.99' }));
  assert.equal(verdict.reason, LOSS_REASONS.UNKNOWN_DROPOFF);
});

test('SHIPPING_LATENCY: quoted delivery days beyond the threshold', () => {
  const verdict = classifyLoss(intentRow({ delivery_days: SHIPPING_LATENCY_THRESHOLD_DAYS + 2 }));
  assert.equal(verdict.reason, LOSS_REASONS.SHIPPING_LATENCY);
  assert.equal(verdict.competitorDelta.quoted_delivery_days, SHIPPING_LATENCY_THRESHOLD_DAYS + 2);
  assert.equal(verdict.competitorDelta.threshold_days, SHIPPING_LATENCY_THRESHOLD_DAYS);
});

test('SHIPPING_LATENCY: fastest of quotes[] governs (agent picks the best option)', () => {
  // Fastest quote is 2 days -> NOT a latency loss even though one quote is slow.
  const fastEnough = classifyLoss(
    intentRow({ quotes: [{ delivery_days: 7 }, { delivery_days: 2 }] }, { endpoint_path: '/shipping_quote' })
  );
  assert.equal(fastEnough.reason, LOSS_REASONS.UNKNOWN_DROPOFF);

  // Every option slow -> latency loss.
  const allSlow = classifyLoss(
    intentRow({ quotes: [{ delivery_days: 7 }, { days: 5 }] }, { endpoint_path: '/shipping_quote' })
  );
  assert.equal(allSlow.reason, LOSS_REASONS.SHIPPING_LATENCY);
});

test('SHIPPING_LATENCY: shipping_quote intents flagged slow without numeric days', () => {
  const verdict = classifyLoss(
    intentRow({ slow_quote: true }, { endpoint_path: '/shipping_quote' })
  );
  assert.equal(verdict.reason, LOSS_REASONS.SHIPPING_LATENCY);
});

test('STOCK_OUTAGE: boolean, zero-quantity, and string-status conventions', () => {
  for (const payload of [
    { available: false },
    { in_stock: false },
    { inventory_quantity: 0 },
    { stock: 0 },
    { availability: 'out_of_stock' },
    { stock_status: 'SOLD_OUT' }, // case-insensitive
    { variant: { available: false } },
    { items: [{ sku: 'SKU-RED-42', in_stock: false }] },
    { requested_variant: { size_available: false } },
  ]) {
    const verdict = classifyLoss(intentRow(payload));
    assert.equal(verdict.reason, LOSS_REASONS.STOCK_OUTAGE, JSON.stringify(payload));
  }
});

test('no STOCK_OUTAGE for merely-missing availability fields', () => {
  const verdict = classifyLoss(intentRow({ available: undefined, stock: 12 }));
  assert.equal(verdict.reason, LOSS_REASONS.UNKNOWN_DROPOFF);
});

test('POLICY_AMBIGUITY: boolean flags, string statuses, nested policy, flags[]', () => {
  for (const payload of [
    { policy_ambiguous: true },
    { return_policy: 'unclear' },
    { refund_policy: 'CONFLICTING' },
    { policy: { ambiguous: true } },
    { flags: ['stock_ok', 'policy_ambiguity'] },
  ]) {
    const verdict = classifyLoss(intentRow(payload));
    assert.equal(verdict.reason, LOSS_REASONS.POLICY_AMBIGUITY, JSON.stringify(payload));
  }
});

test('PROTOCOL_ERROR: non-2xx status recorded by the edge (_edge.status)', () => {
  for (const status of [404, 500, 429, 302]) {
    const verdict = classifyLoss(intentRow({ _edge: { status, latency_ms: 84 } }));
    assert.equal(verdict.reason, LOSS_REASONS.PROTOCOL_ERROR, `status ${status}`);
    assert.equal(verdict.competitorDelta.observed_status, status);
  }
});

test('2xx edge status is NOT a protocol error', () => {
  const verdict = classifyLoss(intentRow({ _edge: { status: 200 } }));
  assert.equal(verdict.reason, LOSS_REASONS.UNKNOWN_DROPOFF);
});

test('an agent "status" STRING field is not mistaken for an HTTP status', () => {
  // status: "out_of_stock" must classify via the stock path, never crash the
  // integer-status check.
  const verdict = classifyLoss(intentRow({ status: 'out_of_stock' }));
  assert.equal(verdict.reason, LOSS_REASONS.STOCK_OUTAGE);
});

/* ------------------------------ priority order ----------------------------- */

test('PROTOCOL_ERROR outranks in-payload signals (agent never saw the answer)', () => {
  const verdict = classifyLoss(
    intentRow({ _edge: { status: 503 }, available: false, price: '24.99', competitor_price: '9.99' })
  );
  assert.equal(verdict.reason, LOSS_REASONS.PROTOCOL_ERROR);
});

test('STOCK_OUTAGE outranks price/shipping signals (absolute blocker)', () => {
  const verdict = classifyLoss(
    intentRow({ available: false, price: '24.99', competitor_price: '9.99', delivery_days: 9 })
  );
  assert.equal(verdict.reason, LOSS_REASONS.STOCK_OUTAGE);
});

test('PRICE_DISCREPANCY outranks SHIPPING_LATENCY and POLICY_AMBIGUITY', () => {
  const verdict = classifyLoss(
    intentRow({ price: '24.99', competitor_price: '9.99', delivery_days: 9, policy_ambiguous: true })
  );
  assert.equal(verdict.reason, LOSS_REASONS.PRICE_DISCREPANCY);
});

/* --------------------------- revenue estimation ---------------------------- */

test('estimates revenue from payload price/total fields (integer cents)', () => {
  assert.equal(classifyLoss(intentRow({ price: '24.99', available: false })).estimatedRevenueLost, 2499);
  assert.equal(classifyLoss(intentRow({ total: 100, delivery_days: 10 })).estimatedRevenueLost, 10000);
  assert.equal(classifyLoss(intentRow({ items: [{ price: '9.95' }] })).estimatedRevenueLost, 995);
  assert.equal(classifyLoss(intentRow({ product: { unit_price: '5.50' } })).estimatedRevenueLost, 550);
});

test('revenue estimate is 0 when no price field parses', () => {
  assert.equal(classifyLoss(intentRow({ price: 'call us', available: false })).estimatedRevenueLost, 0);
  assert.equal(classifyLoss(intentRow({ delivery_days: 10 })).estimatedRevenueLost, 0);
  assert.equal(classifyLoss(intentRow(null)).estimatedRevenueLost, 0);
});

/* ------------------------- fallback + hostile input ------------------------ */

test('UNKNOWN_DROPOFF fallback for empty/absent payloads', () => {
  for (const payload of [null, undefined, {}]) {
    const verdict = classifyLoss(intentRow(payload));
    assert.equal(verdict.reason, LOSS_REASONS.UNKNOWN_DROPOFF);
    assert.equal(verdict.estimatedRevenueLost, 0);
    assert.equal(verdict.competitorDelta, null);
  }
});

test('never throws on malformed rows and hostile payload shapes', () => {
  const hostileCases = [
    undefined,
    null,
    42,
    'a string, not a row',
    [],
    {},
    intentRow('payload is a string'),
    intentRow([1, 2, 3]),
    intentRow({ items: 'not-an-array' }),
    intentRow({ competitors: [null, 'x', 9, { price: {} }] }),
    intentRow({ quotes: [{ delivery_days: 'soon' }] }),
    intentRow({ _edge: 'not-an-object' }),
    intentRow({ _edge: { status: 'five hundred' } }),
    intentRow({ price: { deeply: { nested: true } }, competitor_price: [] }),
    intentRow({ flags: [{}, null, 7] }),
    // Hostile getter that throws on property access.
    intentRow(
      new Proxy(
        {},
        {
          get() {
            throw new Error('trap');
          },
          // has() must not throw or even isObject checks get exciting.
        }
      )
    ),
  ];
  for (const row of hostileCases) {
    const verdict = classifyLoss(row);
    assert.equal(typeof verdict.reason, 'string');
    assert.equal(Object.values(LOSS_REASONS).includes(verdict.reason), true);
    assert.equal(Number.isSafeInteger(verdict.estimatedRevenueLost), true);
    assert.equal(verdict.estimatedRevenueLost >= 0, true);
  }
});

test('every returned reason is in the DB CHECK-constraint vocabulary', () => {
  const dbAllowed = new Set([
    'PRICE_DISCREPANCY',
    'SHIPPING_LATENCY',
    'STOCK_OUTAGE',
    'POLICY_AMBIGUITY',
    'PROTOCOL_ERROR',
    'UNKNOWN_DROPOFF',
  ]);
  for (const reason of Object.values(LOSS_REASONS)) {
    assert.equal(dbAllowed.has(reason), true, reason);
  }
});
