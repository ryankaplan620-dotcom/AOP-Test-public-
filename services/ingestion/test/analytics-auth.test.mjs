/**
 * test/analytics-auth.test.mjs — route-level tests for multi-tenant auth on
 * src/routes/analytics.js (platform token vs merchant API keys, migration
 * 0014).
 *
 * Same honesty layer as webhooks-adjustments.test.mjs: the real router over
 * HTTP with a scripted fake db, because the contract under test is exactly
 * "which SQL parameters does each credential class produce" plus "are the
 * failure responses uniform".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { buildAnalyticsRouter } from '../src/routes/analytics.js';
import { generateApiKey } from '../src/lib/api-keys.js';

const PLATFORM_TOKEN = 'platform-dashboard-token';
const MERCHANT_ID = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
const SHOP = 'tenant-a.myshopify.com';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

/** Scripted fake db (regex -> responder), recording every statement. */
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

/** App with the same JSON-before-router shape src/app.js uses. */
async function startApp(db, { dashboardApiToken = PLATFORM_TOKEN } = {}) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(
    '/analytics',
    buildAnalyticsRouter({
      config: { dashboardApiToken, dashboardAllowedOrigin: '*' },
      db,
      logger: silentLogger,
    })
  );
  // Central error handler stand-in (src/app.js owns the real one).
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(500).json({ error: 'internal error' });
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function get(baseUrl, path, token) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: response.status, body: await response.json() };
}

async function send(baseUrl, method, path, token, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

/** Script fragment: a live merchant key row for `key`. */
const keyLookupHit = [
  /FROM merchant_api_keys k/,
  { rows: [{ merchant_id: MERCHANT_ID, shopify_shop_domain: SHOP }], rowCount: 1 },
];

test('missing / malformed / unknown credentials all get the identical 401', async () => {
  const db = fakeDb([[/FROM merchant_api_keys k/, { rows: [], rowCount: 0 }]]);
  const app = await startApp(db);
  try {
    const missing = await get(app.url, '/analytics/whoami', null);
    const wrongToken = await get(app.url, '/analytics/whoami', 'not-the-token');
    const unknownKey = await get(app.url, '/analytics/whoami', generateApiKey().plaintext);

    for (const r of [missing, wrongToken, unknownKey]) {
      assert.equal(r.status, 401);
      assert.deepEqual(r.body, { error: 'unauthorized' });
    }
  } finally {
    await app.close();
  }
});

test('non-key-shaped bearer never touches the database', async () => {
  const db = fakeDb([]);
  const app = await startApp(db);
  try {
    await get(app.url, '/analytics/whoami', 'garbage-bearer-value');
    assert.equal(db.statements.length, 0);
  } finally {
    await app.close();
  }
});

test('platform token: whoami reports platform and queries stay unscoped', async () => {
  const db = fakeDb([]);
  const app = await startApp(db);
  try {
    const who = await get(app.url, '/analytics/whoami', PLATFORM_TOKEN);
    assert.equal(who.status, 200);
    assert.deepEqual(who.body, { role: 'platform', merchant_id: null, shop_domain: null });
    // Platform auth itself must not hit the db (timing-safe compare only).
    assert.equal(db.statements.length, 0);

    const reasons = await get(app.url, '/analytics/loss-reasons?days=7', PLATFORM_TOKEN);
    assert.equal(reasons.status, 200);
    const q = db.statements.find((s) => /FROM loss_diagnostics/.test(s.text));
    assert.ok(q, 'loss-reasons query issued');
    assert.deepEqual(q.params, [7, null]); // $2 NULL = platform-wide
  } finally {
    await app.close();
  }
});

test('merchant key: whoami reports the shop and EVERY data endpoint is tenant-scoped', async () => {
  const key = generateApiKey();
  const db = fakeDb([
    keyLookupHit,
    // Row-shape stubs for queries whose repository code reads rows[0].
    // (Anchored on estimated_losses — 'AS impressions' would also match the
    // lift report's weekly series, which needs a different row shape.)
    [
      /AS estimated_losses/,
      { rows: [{ impressions: '0', orders_won: '0', adjustments: '0', losses: '0', estimated_losses: '0' }], rowCount: 1 },
    ],
    [
      /AS price_losses/,
      {
        rows: [
          { price_losses: '0', revenue_lost: '0', avg_delta_cents: null, avg_our_price_cents: null, avg_competitor_price_cents: null },
        ],
        rowCount: 1,
      },
    ],
  ]);
  const app = await startApp(db);
  try {
    const who = await get(app.url, '/analytics/whoami', key.plaintext);
    assert.equal(who.status, 200);
    assert.deepEqual(who.body, { role: 'merchant', merchant_id: MERCHANT_ID, shop_domain: SHOP });

    // The lookup went by digest — the plaintext never reaches the db layer —
    // and the SQL pins the revocation predicate (a revoked row must not auth).
    const lookup = db.statements.find((s) => /FROM merchant_api_keys k/.test(s.text));
    assert.deepEqual(lookup.params, [key.keyHash]);
    assert.match(lookup.text, /revoked_at IS NULL/);
    assert.ok(!db.statements.some((s) => s.params.includes(key.plaintext)));

    // Drive ALL seven data endpoints with the merchant credential.
    for (const path of [
      '/analytics/summary?days=7',
      '/analytics/loss-reasons?days=7',
      '/analytics/traffic?days=7',
      '/analytics/billing?month=2026-07',
      '/analytics/benchmark?days=7',
      '/analytics/lift?days=56',
      '/analytics/activity?limit=5',
    ]) {
      const r = await get(app.url, path, key.plaintext);
      assert.equal(r.status, 200, `${path} -> ${r.status}`);
    }

    // Every issued data statement must (a) bind the tenant id as its scoping
    // param and (b) contain the scoping predicate the EXPECTED number of
    // times. The count matters: getRecentActivity has TWO union branches,
    // the summary counts query FIVE subselects, the lift split FOUR — a
    // params-only assertion cannot catch a predicate dropped from just one
    // branch, text counts can.
    const SCOPE_PREDICATE = /\$\d+::uuid IS NULL OR (?:[a-z]+\.)?merchant_id = \$\d+/g;
    const EXPECTED = [
      [/date_trunc\('week', processed_at\)/, 1], // lift weekly impressions
      [/date_trunc\('week', reconciled_at\)/, 1], // lift weekly wins
      [/date_trunc\('week', created_at\)/, 1], // lift weekly losses
      [/AS imp_recent/, 4], // lift split-half: 4 subselects
      [/AS recent_count/, 1], // lift reason shifts
      [/AS estimated_losses/, 5], // summary counts: 5 subselects
      [/WITH charges/, 2], // summary money: charges + credits CTEs
      [/endpoint_path AS phase/, 1], // summary phase breakdown
      [/GROUP BY calculated_loss_reason/, 1], // loss-reasons
      [/UNION ALL/, 2], // activity: LOST + WON branches
      [/GROUP BY protocol_type/, 1], // traffic protocols
      [/intent_category/, 1], // traffic intent categories
      [/GROUP BY target_sku[\s\S]*LIMIT 10/, 1], // traffic top SKUs
      [/WITH bounds/, 2], // billing: charges + credits CTEs
      [/AS price_losses/, 1], // benchmark overall
      [/LIMIT 20/, 1], // benchmark by-SKU
    ];
    const dataStatements = db.statements.filter((s) => !/merchant_api_keys/.test(s.text));
    assert.equal(dataStatements.length, 16, 'expected 16 scoped data statements');
    for (const s of dataStatements) {
      const head = s.text.replace(/\s+/g, ' ').slice(0, 70);
      assert.equal(s.params[s.params.length - 1], MERCHANT_ID, `tenant param missing: ${head}`);
      const spec = EXPECTED.find(([re]) => re.test(s.text));
      assert.ok(spec, `unrecognized data statement: ${head}`);
      const count = (s.text.match(SCOPE_PREDICATE) ?? []).length;
      assert.equal(count, spec[1], `scope-predicate count ${count} != ${spec[1]} in: ${head}`);
    }
  } finally {
    await app.close();
  }
});

test('revoked key (no live row) gets the same uniform 401', async () => {
  const db = fakeDb([[/FROM merchant_api_keys k/, { rows: [], rowCount: 0 }]]);
  const app = await startApp(db);
  try {
    const r = await get(app.url, '/analytics/summary?days=7', generateApiKey().plaintext);
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { error: 'unauthorized' });
    // The 'revoked' semantics are enforced by SQL, not the fake: pin the
    // predicate so the lookup can never silently start matching tombstones.
    // (verify-pr10 exercises the same path against real PostgreSQL.)
    const lookup = db.statements.find((s) => /FROM merchant_api_keys k/.test(s.text));
    assert.match(lookup.text, /AND k\.revoked_at IS NULL/);
  } finally {
    await app.close();
  }
});

test('unconfigured DASHBOARD_API_TOKEN keeps the whole surface 503 — keys included', async () => {
  const db = fakeDb([keyLookupHit]);
  const app = await startApp(db, { dashboardApiToken: null });
  try {
    const r = await get(app.url, '/analytics/whoami', generateApiKey().plaintext);
    assert.equal(r.status, 503);
    assert.equal(db.statements.length, 0);
  } finally {
    await app.close();
  }
});

test('key management is platform-only: a valid merchant key gets 403', async () => {
  const key = generateApiKey();
  const db = fakeDb([keyLookupHit]);
  const app = await startApp(db);
  try {
    const create = await send(app.url, 'POST', '/analytics/keys', key.plaintext, { shop_domain: SHOP });
    assert.equal(create.status, 403);
    const list = await get(app.url, '/analytics/keys', key.plaintext);
    assert.equal(list.status, 403);
    const del = await send(app.url, 'DELETE', `/analytics/keys/${MERCHANT_ID}`, key.plaintext);
    assert.equal(del.status, 403);
    // No key row was ever written or touched by the refused calls.
    assert.ok(!db.statements.some((s) => /INSERT INTO merchant_api_keys/.test(s.text)));
    assert.ok(!db.statements.some((s) => /UPDATE merchant_api_keys/.test(s.text)));
  } finally {
    await app.close();
  }
});

test('POST /analytics/keys mints a key: plaintext once, digest stored, prefix display-only', async () => {
  const KEY_ID = 'cccccccc-1111-2222-3333-dddddddddddd';
  const db = fakeDb([
    [/FROM merchant_profiles/, { rows: [{ id: MERCHANT_ID, shopify_shop_domain: SHOP }], rowCount: 1 }],
    [
      /INSERT INTO merchant_api_keys/,
      (text, params) => ({
        rows: [{ id: KEY_ID, key_prefix: params[2], created_at: new Date('2026-07-20T00:00:00Z') }],
        rowCount: 1,
      }),
    ],
  ]);
  const app = await startApp(db);
  try {
    const r = await send(app.url, 'POST', '/analytics/keys', PLATFORM_TOKEN, {
      shop_domain: SHOP,
      label: 'tenant A dashboard',
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.id, KEY_ID);
    assert.equal(r.body.merchant_id, MERCHANT_ID);
    assert.match(r.body.api_key, /^aop_live_[A-Za-z0-9_-]{43}$/);
    assert.equal(r.body.key_prefix, r.body.api_key.slice(0, 13));
    assert.equal(r.body.label, 'tenant A dashboard');

    const insert = db.statements.find((s) => /INSERT INTO merchant_api_keys/.test(s.text));
    // Stored: merchant, 64-hex digest, display prefix, label — never plaintext.
    assert.equal(insert.params[0], MERCHANT_ID);
    assert.match(insert.params[1], /^[0-9a-f]{64}$/);
    assert.equal(insert.params[2], r.body.api_key.slice(0, 13));
    assert.equal(insert.params[3], 'tenant A dashboard');
    assert.ok(!insert.params.includes(r.body.api_key));
  } finally {
    await app.close();
  }
});

test('POST /analytics/keys: unknown merchant 404, missing selector 400', async () => {
  const db = fakeDb([[/FROM merchant_profiles/, { rows: [], rowCount: 0 }]]);
  const app = await startApp(db);
  try {
    const unknown = await send(app.url, 'POST', '/analytics/keys', PLATFORM_TOKEN, {
      shop_domain: 'nobody.myshopify.com',
    });
    assert.equal(unknown.status, 404);

    const missing = await send(app.url, 'POST', '/analytics/keys', PLATFORM_TOKEN, {});
    assert.equal(missing.status, 400);

    const badUuid = await send(app.url, 'POST', '/analytics/keys', PLATFORM_TOKEN, {
      merchant_id: 'not-a-uuid',
    });
    assert.equal(badUuid.status, 400);
  } finally {
    await app.close();
  }
});

test('DELETE /analytics/keys/:id: revoke, idempotent revoke, and 404s', async () => {
  const KEY_ID = 'cccccccc-1111-2222-3333-dddddddddddd';
  let revoked = false;
  const db = fakeDb([
    [
      /UPDATE merchant_api_keys/,
      () => {
        if (revoked) return { rows: [], rowCount: 0 };
        revoked = true;
        return { rows: [{ id: KEY_ID }], rowCount: 1 };
      },
    ],
    [/SELECT 1 FROM merchant_api_keys/, () => ({ rows: [{ '?column?': 1 }], rowCount: 1 })],
  ]);
  const app = await startApp(db);
  try {
    const first = await send(app.url, 'DELETE', `/analytics/keys/${KEY_ID}`, PLATFORM_TOKEN);
    assert.equal(first.status, 200);
    assert.equal(first.body.status, 'revoked');

    const second = await send(app.url, 'DELETE', `/analytics/keys/${KEY_ID}`, PLATFORM_TOKEN);
    assert.equal(second.status, 200);
    assert.equal(second.body.status, 'already_revoked');

    const badShape = await send(app.url, 'DELETE', '/analytics/keys/definitely-not-a-uuid', PLATFORM_TOKEN);
    assert.equal(badShape.status, 404);
  } finally {
    await app.close();
  }
});

test('malformed percent-encoding in /keys/:id answers 400, not 500 (full app wiring)', async () => {
  // Express decodes req.params during route matching; %zz throws URIError
  // before the handler's UUID_SHAPE guard runs. The CENTRAL handler (app.js)
  // owns the mapping, so this test wires the real app, not the bare router.
  const { buildApp } = await import('../src/app.js');
  const appLogger = { info() {}, warn() {}, error() {}, debug() {}, child: () => appLogger };
  const config = {
    rateLimitPerMinute: 0,
    ingestApiToken: 'ingest-tok',
    shopifyWebhookSecret: 'whsec',
    dashboardApiToken: PLATFORM_TOKEN,
    dashboardAllowedOrigin: '*',
    shopifyOauth: null,
    proxyHostnameSuffix: null,
  };
  const db = fakeDb([]);
  const app = buildApp({ config, db, logger: appLogger });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/analytics/keys/%zz`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${PLATFORM_TOKEN}` },
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'malformed request path' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('GET /analytics/keys validates merchant_id and returns the inventory', async () => {
  const db = fakeDb([
    [
      /FROM merchant_api_keys k[\s\S]*ORDER BY/,
      {
        rows: [
          {
            id: 'cccccccc-1111-2222-3333-dddddddddddd',
            merchant_id: MERCHANT_ID,
            shopify_shop_domain: SHOP,
            key_prefix: 'aop_live_abcd',
            label: null,
            created_at: new Date('2026-07-20T00:00:00Z'),
            revoked_at: null,
          },
        ],
        rowCount: 1,
      },
    ],
  ]);
  const app = await startApp(db);
  try {
    const bad = await get(app.url, '/analytics/keys?merchant_id=nope', PLATFORM_TOKEN);
    assert.equal(bad.status, 400);

    const list = await get(app.url, `/analytics/keys?merchant_id=${MERCHANT_ID}`, PLATFORM_TOKEN);
    assert.equal(list.status, 200);
    assert.equal(list.body.keys.length, 1);
    assert.equal(list.body.keys[0].key_prefix, 'aop_live_abcd');
    assert.ok(!('key_hash' in list.body.keys[0]));
    const q = db.statements.find((s) => /FROM merchant_api_keys k[\s\S]*ORDER BY/.test(s.text));
    assert.deepEqual(q.params, [MERCHANT_ID.toLowerCase()]);
  } finally {
    await app.close();
  }
});
