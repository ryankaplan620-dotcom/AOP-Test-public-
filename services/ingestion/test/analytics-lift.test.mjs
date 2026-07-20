/**
 * test/analytics-lift.test.mjs — route-level tests for GET /analytics/lift
 * (proof-of-lift report assembly in src/routes/analytics.js).
 *
 * Scripted fake db (same harness as analytics-auth.test.mjs): the SQL layer
 * is pinned by the scoping suite; THIS suite pins the report math — weekly
 * series merging, exact split-half conversion lift, and the honesty guards
 * (null lift when the baseline cannot support a relative comparison).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { buildAnalyticsRouter } from '../src/routes/analytics.js';

const PLATFORM_TOKEN = 'platform-dashboard-token';
const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function fakeDb(script) {
  const statements = [];
  return {
    statements,
    async query(text, params = []) {
      statements.push({ text, params });
      for (const [pattern, responder] of script) {
        if (pattern.test(text)) {
          const result = typeof responder === 'function' ? responder(text, params) : responder;
          return { rows: [], rowCount: 0, ...result };
        }
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

async function startApp(db) {
  const app = express();
  app.use(
    '/analytics',
    buildAnalyticsRouter({
      config: { dashboardApiToken: PLATFORM_TOKEN, dashboardAllowedOrigin: '*' },
      db,
      logger: silentLogger,
    })
  );
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: 'internal error' }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function getLift(baseUrl, query = '') {
  const response = await fetch(`${baseUrl}/analytics/lift${query}`, {
    headers: { authorization: `Bearer ${PLATFORM_TOKEN}` },
  });
  return { status: response.status, body: await response.json() };
}

const W1 = '2026-06-01T00:00:00.000Z';
const W2 = '2026-06-08T00:00:00.000Z';
const W3 = '2026-06-15T00:00:00.000Z';

test('lift report merges sparse weekly series and computes split-half lift', async () => {
  const db = fakeDb([
    [
      /date_trunc\('week', processed_at\)/,
      {
        rows: [
          { week: W1, impressions: '100' },
          { week: W2, impressions: '150' },
          { week: W3, impressions: '200' },
        ],
      },
    ],
    // Sparse on purpose: no wins in W1 — the merge must default it to 0.
    [
      /date_trunc\('week', reconciled_at\)/,
      {
        rows: [
          { week: W2, orders_won: '3' },
          { week: W3, orders_won: '9' },
        ],
      },
    ],
    [
      /date_trunc\('week', created_at\)/,
      {
        rows: [
          { week: W1, losses: '10', estimated_revenue_lost: '500.00' },
          { week: W3, losses: '4', estimated_revenue_lost: '120.00' },
        ],
      },
    ],
    [
      /AS imp_recent/,
      { rows: [{ imp_recent: '200', imp_baseline: '200', won_recent: '9', won_baseline: '6' }] },
    ],
    [
      /AS recent_count/,
      {
        rows: [
          { reason: 'PRICE_DISCREPANCY', recent_count: '2', baseline_count: '8' },
          { reason: 'STOCK_OUTAGE', recent_count: '5', baseline_count: '1' },
        ],
      },
    ],
  ]);
  const app = await startApp(db);
  try {
    const { status, body } = await getLift(app.url, '?days=56');
    assert.equal(status, 200);
    assert.equal(body.window_days, 56);
    assert.equal(body.recent_days, 28);
    assert.equal(body.baseline_days, 28);

    // Interval bindings, not just response echoes: the weekly series scans
    // the window ($1=56), the split halves are bounded by halfDays ($1=28),
    // and the reason split carries (window, halfDays). Swapping these
    // silently overlaps the halves — the params are the contract.
    const weeklyQ = db.statements.find((s) => /date_trunc\('week', processed_at\)/.test(s.text));
    assert.deepEqual(weeklyQ.params, [56, null]);
    const splitQ = db.statements.find((s) => /AS imp_recent/.test(s.text));
    assert.deepEqual(splitQ.params, [28, null]);
    const reasonsQ = db.statements.find((s) => /AS recent_count/.test(s.text));
    assert.deepEqual(reasonsQ.params, [56, 28, null]);

    // Split halves: 6/200 = 3% baseline, 9/200 = 4.5% recent.
    assert.deepEqual(body.baseline, { impressions: 200, orders_won: 6, conversion_rate_pct: 3 });
    assert.deepEqual(body.recent, { impressions: 200, orders_won: 9, conversion_rate_pct: 4.5 });
    // Relative lift: (4.5 - 3) / 3 = +50%.
    assert.equal(body.conversion_lift_pct, 50);

    // Weekly merge: three weeks, sparse series zero-filled, sorted. W2 is
    // the row exercising the losses/revenue zero-fill (no loss row for it).
    assert.equal(body.weekly.length, 3);
    assert.deepEqual(body.weekly[0], {
      week_start: W1,
      impressions: 100,
      orders_won: 0,
      losses: 10,
      estimated_revenue_lost: '500.00',
      conversion_rate_pct: 0,
    });
    assert.deepEqual(body.weekly[1], {
      week_start: W2,
      impressions: 150,
      orders_won: 3,
      losses: 0,
      estimated_revenue_lost: '0',
      conversion_rate_pct: 2,
    });
    assert.deepEqual(body.weekly[2], {
      week_start: W3,
      impressions: 200,
      orders_won: 9,
      losses: 4,
      estimated_revenue_lost: '120.00',
      conversion_rate_pct: 4.5,
    });

    // Reason shifts sorted by delta ascending (improvements first).
    assert.deepEqual(body.reason_shifts, [
      { reason: 'PRICE_DISCREPANCY', baseline_count: 8, recent_count: 2, delta: -6 },
      { reason: 'STOCK_OUTAGE', baseline_count: 1, recent_count: 5, delta: 4 },
    ]);
  } finally {
    await app.close();
  }
});

test('lift is null (never invented) when the baseline cannot support it', async () => {
  const cases = [
    // No baseline impressions at all (brand-new merchant).
    { imp_recent: '50', imp_baseline: '0', won_recent: '2', won_baseline: '0' },
    // Baseline traffic but zero conversions: relative change is undefined.
    { imp_recent: '50', imp_baseline: '80', won_recent: '2', won_baseline: '0' },
    // No recent traffic either.
    { imp_recent: '0', imp_baseline: '80', won_recent: '0', won_baseline: '3' },
  ];
  for (const split of cases) {
    const db = fakeDb([[/AS imp_recent/, { rows: [split] }]]);
    const app = await startApp(db);
    try {
      const { status, body } = await getLift(app.url);
      assert.equal(status, 200);
      assert.equal(body.conversion_lift_pct, null, JSON.stringify(split));
      // The absolute rates are still reported for the dashboard to render.
      assert.equal(typeof body.baseline.conversion_rate_pct, 'number');
    } finally {
      await app.close();
    }
  }
});

test('lift ratio uses raw counts — sub-rounding conversion moves are not erased', async () => {
  // 7/9000 (0.0778%) -> 11/9000 (0.1222%): both DISPLAY as 0.1%, but the
  // real relative lift is 4/7 = +57.1%. Computing from rounded rates would
  // report 0; the guard on the rounded baseline would even null it out for
  // rates under 0.05%.
  const db = fakeDb([
    [
      /AS imp_recent/,
      { rows: [{ imp_recent: '9000', imp_baseline: '9000', won_recent: '11', won_baseline: '7' }] },
    ],
  ]);
  const app = await startApp(db);
  try {
    const { body } = await getLift(app.url);
    assert.equal(body.baseline.conversion_rate_pct, 0.1); // display rounding
    assert.equal(body.recent.conversion_rate_pct, 0.1); // display rounding
    assert.equal(body.conversion_lift_pct, 57.1); // raw-count truth
  } finally {
    await app.close();
  }

  // A baseline whose rate rounds to 0.0% (4/10000 = 0.04%) is still a real
  // baseline: lift must be computed, not nulled.
  const db2 = fakeDb([
    [
      /AS imp_recent/,
      { rows: [{ imp_recent: '10000', imp_baseline: '10000', won_recent: '8', won_baseline: '4' }] },
    ],
  ]);
  const app2 = await startApp(db2);
  try {
    const { body } = await getLift(app2.url);
    assert.equal(body.baseline.conversion_rate_pct, 0); // display rounding
    assert.equal(body.conversion_lift_pct, 100);
  } finally {
    await app2.close();
  }
});

test('lift defaults to a 56-day window and clamps ?days to the standard bounds', async () => {
  const db = fakeDb([]);
  const app = await startApp(db);
  try {
    const def = await getLift(app.url);
    assert.equal(def.body.window_days, 56);
    const clamped = await getLift(app.url, '?days=5000');
    assert.equal(clamped.body.window_days, 90);
    const one = await getLift(app.url, '?days=1');
    assert.equal(one.body.window_days, 1);
    assert.equal(one.body.recent_days, 1); // halfDays floor is 1, never 0
    assert.equal(one.body.baseline_days, 1); // equal-length halves, always
  } finally {
    await app.close();
  }
});
