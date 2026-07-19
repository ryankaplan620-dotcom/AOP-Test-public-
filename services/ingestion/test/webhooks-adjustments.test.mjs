/**
 * test/webhooks-adjustments.test.mjs — route-level tests for the billing
 * credit webhooks (refunds/create, orders/cancelled) in src/routes/webhooks.js.
 *
 * Unlike the pure-module suites, this one imports express (installed by
 * `npm ci` in CI) and drives the real router over HTTP on an ephemeral port:
 * real raw-body handling, real HMAC verification, scripted fake db. That is
 * the honest layer to test — the credit path's contract IS its HTTP
 * behavior + the SQL it issues.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { buildWebhooksRouter } from '../src/routes/webhooks.js';

const SECRET = 'test-webhook-secret';
const MERCHANT_ID = '11111111-2222-3333-4444-555555555555';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * Scripted fake db. `script` keys are regexes matched against SQL text (first
 * match wins); values produce {rows, rowCount}. Records every statement for
 * assertions. withClient hands the SAME query dispatcher to the repository,
 * so BEGIN/COMMIT/ROLLBACK flow through the script too.
 */
function fakeDb(script) {
  const statements = [];
  async function query(text, params = []) {
    statements.push({ text, params });
    for (const [pattern, responder] of script) {
      if (pattern.test(text)) {
        const result = typeof responder === 'function' ? responder(text, params) : responder;
        return { rows: [], rowCount: 0, ...result };
      }
    }
    return { rows: [], rowCount: 0 };
  }
  return {
    query,
    withClient: (fn) => fn(query),
    statements,
  };
}

/** Start the router on an ephemeral port; returns {url, close}. */
async function startApp(db) {
  const app = express();
  app.use(
    '/webhooks',
    buildWebhooksRouter({ config: { shopifyWebhookSecret: SECRET }, db, logger: silentLogger })
  );
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** POST a signed Shopify webhook the way Shopify sends it. */
async function postWebhook(baseUrl, path, payload, { shopDomain = 'shop.myshopify.com', tamper = false } = {}) {
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  const hmac = crypto.createHmac('sha256', SECRET).update(raw).digest('base64');
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-shopify-hmac-sha256': tamper ? hmac.slice(0, -2) + 'xx' : hmac,
      'x-shopify-shop-domain': shopDomain,
    },
    body: raw,
  });
  return { status: response.status, body: await response.json() };
}

/** Script fragments shared across cases. */
const merchantHit = [
  /FROM merchant_profiles/,
  { rows: [{ id: MERCHANT_ID, shopify_shop_domain: 'shop.myshopify.com' }], rowCount: 1 },
];
const parentOrder = (over = {}) => [
  /FROM reconciled_agent_orders[\s\S]*FOR UPDATE/,
  {
    rows: [
      {
        id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        commission_rate: '0.00500',
        gross_merchandise_value: '200.00',
        ...over,
      },
    ],
    rowCount: 1,
  },
];

const REFUND = {
  id: 998877,
  order_id: 123456,
  transactions: [
    { kind: 'refund', status: 'success', amount: '80.00' },
    { kind: 'refund', status: 'failure', amount: '999.00' }, // failed attempt: excluded
    { kind: 'sale', status: 'success', amount: '15.00' }, // not a refund: excluded
  ],
};

test('refunds/create credits the refunded GMV (idempotency key refund:<id>)', async () => {
  const db = fakeDb([
    merchantHit,
    parentOrder(),
    [
      /INSERT INTO order_adjustments/,
      { rows: [{ id: 'adj-1', adjusted_gmv: '80.00', commission_credit: '0.40' }], rowCount: 1 },
    ],
  ]);
  const app = await startApp(db);
  try {
    const { status, body } = await postWebhook(app.url, '/webhooks/shopify/refunds-create', REFUND);
    assert.equal(status, 200);
    assert.equal(body.action, 'credited');

    const insert = db.statements.find((s) => /INSERT INTO order_adjustments/.test(s.text));
    assert.ok(insert, 'must issue the ledger INSERT');
    // [merchantId, parentId, sourceEventId, kind, requested, gmv, rate]
    assert.equal(insert.params[0], MERCHANT_ID);
    assert.equal(insert.params[2], 'refund:998877');
    assert.equal(insert.params[3], 'REFUND');
    assert.equal(insert.params[4], '80.00'); // only the successful refund transaction
    // Transaction discipline: BEGIN before the lock, COMMIT after the insert.
    const kinds = db.statements.map((s) => s.text.split(/\s/)[0]);
    assert.ok(kinds.includes('BEGIN') && kinds.includes('COMMIT'));
  } finally {
    await app.close();
  }
});

test('orders/cancelled credits the full remainder (requested NULL, key cancel:<order id>)', async () => {
  const db = fakeDb([
    merchantHit,
    parentOrder(),
    [
      /INSERT INTO order_adjustments/,
      { rows: [{ id: 'adj-2', adjusted_gmv: '200.00', commission_credit: '1.00' }], rowCount: 1 },
    ],
  ]);
  const app = await startApp(db);
  try {
    const { status, body } = await postWebhook(app.url, '/webhooks/shopify/orders-cancelled', {
      id: 123456,
      cancelled_at: '2026-07-19T00:00:00Z',
    });
    assert.equal(status, 200);
    assert.equal(body.action, 'credited');
    const insert = db.statements.find((s) => /INSERT INTO order_adjustments/.test(s.text));
    assert.equal(insert.params[2], 'cancel:123456');
    assert.equal(insert.params[3], 'CANCELLATION');
    assert.equal(insert.params[4], null); // null = credit everything remaining
  } finally {
    await app.close();
  }
});

test('webhook redelivery is acknowledged as already_credited (UNIQUE backstop)', async () => {
  const db = fakeDb([
    merchantHit,
    parentOrder(),
    [/INSERT INTO order_adjustments/, { rows: [], rowCount: 0 }], // conflict fired
    [/SELECT 1 FROM order_adjustments WHERE source_event_id/, { rows: [{ '?column?': 1 }], rowCount: 1 }],
  ]);
  const app = await startApp(db);
  try {
    const { status, body } = await postWebhook(app.url, '/webhooks/shopify/refunds-create', REFUND);
    assert.equal(status, 200);
    assert.equal(body.action, 'already_credited');
  } finally {
    await app.close();
  }
});

test('refund of a never-attributed (human) order credits nothing', async () => {
  const db = fakeDb([
    merchantHit,
    [/FROM reconciled_agent_orders[\s\S]*FOR UPDATE/, { rows: [], rowCount: 0 }],
  ]);
  const app = await startApp(db);
  try {
    const { status, body } = await postWebhook(app.url, '/webhooks/shopify/refunds-create', REFUND);
    assert.equal(status, 200);
    assert.equal(body.action, 'order_not_attributed');
    assert.ok(!db.statements.some((s) => /INSERT INTO order_adjustments/.test(s.text)));
  } finally {
    await app.close();
  }
});

test('fully-credited order acknowledges without double-crediting (ledger clamp)', async () => {
  const db = fakeDb([
    merchantHit,
    parentOrder(),
    [/INSERT INTO order_adjustments/, { rows: [], rowCount: 0 }], // clamp: remaining = 0
    [/SELECT 1 FROM order_adjustments WHERE source_event_id/, { rows: [], rowCount: 0 }],
  ]);
  const app = await startApp(db);
  try {
    const { status, body } = await postWebhook(app.url, '/webhooks/shopify/orders-cancelled', {
      id: 123456,
    });
    assert.equal(status, 200);
    assert.equal(body.action, 'already_fully_credited');
  } finally {
    await app.close();
  }
});

test('restock-only refund (zero money moved) is ignored', async () => {
  const db = fakeDb([merchantHit]);
  const app = await startApp(db);
  try {
    const { status, body } = await postWebhook(app.url, '/webhooks/shopify/refunds-create', {
      id: 5,
      order_id: 6,
      transactions: [{ kind: 'refund', status: 'success', amount: '0.00' }],
    });
    assert.equal(status, 200);
    assert.equal(body.action, 'ignored_zero_amount');
    assert.ok(!db.statements.some((s) => /order_adjustments/.test(s.text)));
  } finally {
    await app.close();
  }
});

test('refund amount falls back to refund_line_items when transactions are absent', async () => {
  const db = fakeDb([
    merchantHit,
    parentOrder(),
    [
      /INSERT INTO order_adjustments/,
      { rows: [{ id: 'adj-3', adjusted_gmv: '45.50', commission_credit: '0.23' }], rowCount: 1 },
    ],
  ]);
  const app = await startApp(db);
  try {
    const { status, body } = await postWebhook(app.url, '/webhooks/shopify/refunds-create', {
      id: 7,
      order_id: 8,
      refund_line_items: [{ subtotal: '30.00' }, { subtotal: '15.50' }],
    });
    assert.equal(status, 200);
    assert.equal(body.action, 'credited');
    const insert = db.statements.find((s) => /INSERT INTO order_adjustments/.test(s.text));
    assert.equal(insert.params[4], '45.50');
  } finally {
    await app.close();
  }
});

test('bad HMAC is rejected 401 before any DB work', async () => {
  const db = fakeDb([]);
  const app = await startApp(db);
  try {
    const { status } = await postWebhook(app.url, '/webhooks/shopify/refunds-create', REFUND, {
      tamper: true,
    });
    assert.equal(status, 401);
    assert.equal(db.statements.length, 0);
  } finally {
    await app.close();
  }
});

test('unknown merchant is acknowledged without touching the ledger', async () => {
  const db = fakeDb([[/FROM merchant_profiles/, { rows: [], rowCount: 0 }]]);
  const app = await startApp(db);
  try {
    const { status, body } = await postWebhook(app.url, '/webhooks/shopify/orders-cancelled', {
      id: 1,
    });
    assert.equal(status, 200);
    assert.equal(body.action, 'skipped_unknown_merchant');
  } finally {
    await app.close();
  }
});

test('orders/create still reconciles and now records the order currency', async () => {
  const db = fakeDb([
    merchantHit,
    [/FROM agent_intent_logs/, { rows: [{ id: 'intent-1' }], rowCount: 1 }],
    [
      /INSERT INTO reconciled_agent_orders/,
      (text, params) => {
        assert.ok(/currency/.test(text), 'insert must include the currency column');
        assert.equal(params[5], 'EUR');
        return { rows: [{ id: 'ord-1', commission_fee: '0.65' }], rowCount: 1 };
      },
    ],
  ]);
  const app = await startApp(db);
  try {
    const { status, body } = await postWebhook(app.url, '/webhooks/shopify/orders-create', {
      id: 42,
      total_price: '129.90',
      currency: 'eur',
      note_attributes: [{ name: 'aop_transaction_token', value: 'tok_abc' }],
    });
    assert.equal(status, 200);
    assert.equal(body.action, 'reconciled');
  } finally {
    await app.close();
  }
});
