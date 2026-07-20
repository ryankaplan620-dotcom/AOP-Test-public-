/**
 * test/analytics-enrichment.test.mjs — edge-enrichment management
 * (PUT/GET /analytics/enrichment, migration 0015) and the /routes/resolve
 * bundling the edge consumes.
 *
 * The PUT route is the FABRICATION GATE for what the edge injects verbatim
 * into merchant HTML — this suite pins its validation: schema.org shape,
 * size cap, NUL rejection, the enabled-requires-payload invariant, and
 * platform-only access.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { buildAnalyticsRouter } from '../src/routes/analytics.js';
import { buildRoutingRouter } from '../src/routes/routing.js';
import { generateApiKey } from '../src/lib/api-keys.js';

const PLATFORM_TOKEN = 'platform-dashboard-token';
const INGEST_TOKEN = 'ingest-edge-token';
const MERCHANT_ID = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
const SHOP = 'tenant-a.myshopify.com';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

const JSONLD = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'Tenant A',
};

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
  app.use(express.json({ limit: '2mb' }));
  app.use(
    '/analytics',
    buildAnalyticsRouter({
      config: { dashboardApiToken: PLATFORM_TOKEN, dashboardAllowedOrigin: '*' },
      db,
      logger: silentLogger,
    })
  );
  app.use(
    '/routes',
    buildRoutingRouter({ config: { ingestApiToken: INGEST_TOKEN }, db, logger: silentLogger })
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

/** Script fragments. */
const merchantHit = [
  /SELECT id, shopify_shop_domain\s+FROM merchant_profiles/,
  { rows: [{ id: MERCHANT_ID, shopify_shop_domain: SHOP }], rowCount: 1 },
];
const enrichmentRow = (over = {}) => [
  /enrichment_updated_at\s+FROM merchant_profiles/,
  {
    rows: [
      {
        id: MERCHANT_ID,
        shopify_shop_domain: SHOP,
        enrichment_enabled: true,
        enrichment_jsonld: JSONLD,
        enrichment_updated_at: new Date('2026-07-20T00:00:00Z'),
        ...over,
      },
    ],
    rowCount: 1,
  },
];
const updateHit = [/UPDATE merchant_profiles\s+SET enrichment_jsonld/, { rows: [{ id: MERCHANT_ID }], rowCount: 1 }];

test('PUT /analytics/enrichment stores a validated payload and echoes the config', async () => {
  const db = fakeDb([merchantHit, updateHit, enrichmentRow()]);
  const app = await startApp(db);
  try {
    const r = await send(app.url, 'PUT', '/analytics/enrichment', PLATFORM_TOKEN, {
      shop_domain: SHOP,
      jsonld: JSONLD,
      enabled: true,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.merchant_id, MERCHANT_ID);
    assert.equal(r.body.enabled, true);
    assert.deepEqual(r.body.jsonld, JSONLD);

    const update = db.statements.find((s) => /UPDATE merchant_profiles\s+SET enrichment_jsonld/.test(s.text));
    assert.equal(update.params[0], MERCHANT_ID);
    assert.deepEqual(JSON.parse(update.params[1]), JSONLD); // stored verbatim
    assert.equal(update.params[2], true);
  } finally {
    await app.close();
  }
});

test('PUT validation: the fabrication gate rejects every malformed payload', async () => {
  const db = fakeDb([merchantHit, updateHit, enrichmentRow()]);
  const app = await startApp(db);
  const put = (body) => send(app.url, 'PUT', '/analytics/enrichment', PLATFORM_TOKEN, body);
  try {
    assert.equal((await put({ jsonld: JSONLD, enabled: true })).status, 400); // no selector
    assert.equal((await put({ shop_domain: SHOP, jsonld: JSONLD })).status, 400); // no enabled
    assert.equal((await put({ shop_domain: SHOP, jsonld: 'a string', enabled: true })).status, 400);
    assert.equal((await put({ shop_domain: SHOP, jsonld: [], enabled: true })).status, 400);
    assert.equal((await put({ shop_domain: SHOP, jsonld: { '@type': 'Organization' }, enabled: true })).status, 400); // no @context
    assert.equal(
      (await put({ shop_domain: SHOP, jsonld: { '@context': 'https://evil.example', '@type': 'X' }, enabled: true }))
        .status,
      400
    ); // non-schema.org context
    assert.equal((await put({ shop_domain: SHOP, jsonld: null, enabled: true })).status, 400); // enabled w/o payload
    // Oversize: pad past the 32KB cap.
    const fat = { ...JSONLD, description: 'x'.repeat(33 * 1024) };
    assert.equal((await put({ shop_domain: SHOP, jsonld: fat, enabled: true })).status, 400);
    // NUL smuggling.
    const nul = { ...JSONLD, name: 'a\u0000b' };
    assert.equal((await put({ shop_domain: SHOP, jsonld: nul, enabled: true })).status, 400);
    // None of the rejected payloads may have reached the database write.
    assert.ok(!db.statements.some((s) => /UPDATE merchant_profiles\s+SET enrichment_jsonld/.test(s.text)));
  } finally {
    await app.close();
  }
});

test('PUT accepts jsonld arrays, disable-and-clear, and 404s unknown merchants', async () => {
  const db = fakeDb([
    [/SELECT id, shopify_shop_domain\s+FROM merchant_profiles/, { rows: [], rowCount: 0 }],
  ]);
  const app = await startApp(db);
  try {
    const unknown = await send(app.url, 'PUT', '/analytics/enrichment', PLATFORM_TOKEN, {
      shop_domain: 'nobody.myshopify.com',
      jsonld: JSONLD,
      enabled: true,
    });
    assert.equal(unknown.status, 404);
  } finally {
    await app.close();
  }

  const db2 = fakeDb([merchantHit, updateHit, enrichmentRow({ enrichment_enabled: false, enrichment_jsonld: null })]);
  const app2 = await startApp(db2);
  try {
    const cleared = await send(app2.url, 'PUT', '/analytics/enrichment', PLATFORM_TOKEN, {
      shop_domain: SHOP,
      jsonld: null,
      enabled: false,
    });
    assert.equal(cleared.status, 200);
    const update = db2.statements.find((s) => /UPDATE merchant_profiles\s+SET enrichment_jsonld/.test(s.text));
    assert.deepEqual(update.params.slice(1), [null, false]);

    const arrayOk = await send(app2.url, 'PUT', '/analytics/enrichment', PLATFORM_TOKEN, {
      merchant_id: MERCHANT_ID,
      jsonld: [JSONLD, { '@context': 'https://schema.org', '@type': 'Product', name: 'Tee' }],
      enabled: true,
    });
    assert.equal(arrayOk.status, 200);
  } finally {
    await app2.close();
  }
});

test('enrichment management is platform-only and GET validates/404s', async () => {
  const key = generateApiKey();
  const db = fakeDb([
    [/FROM merchant_api_keys k/, { rows: [{ merchant_id: MERCHANT_ID, shopify_shop_domain: SHOP }], rowCount: 1 }],
    [/enrichment_updated_at\s+FROM merchant_profiles/, { rows: [], rowCount: 0 }],
  ]);
  const app = await startApp(db);
  try {
    const putForbidden = await send(app.url, 'PUT', '/analytics/enrichment', key.plaintext, {
      shop_domain: SHOP,
      jsonld: JSONLD,
      enabled: true,
    });
    assert.equal(putForbidden.status, 403);
    const getForbidden = await send(app.url, 'GET', `/analytics/enrichment?merchant_id=${MERCHANT_ID}`, key.plaintext);
    assert.equal(getForbidden.status, 403);

    const badId = await send(app.url, 'GET', '/analytics/enrichment?merchant_id=nope', PLATFORM_TOKEN);
    assert.equal(badId.status, 400);
    const missing = await send(app.url, 'GET', `/analytics/enrichment?merchant_id=${MERCHANT_ID}`, PLATFORM_TOKEN);
    assert.equal(missing.status, 404);
  } finally {
    await app.close();
  }
});

test('/routes/resolve bundles enrichment for the edge (null when disabled)', async () => {
  const db = fakeDb([
    [
      /CASE WHEN enrichment_enabled THEN enrichment_jsonld ELSE NULL END/,
      (text, params) => ({
        rows: [
          {
            origin_url: 'https://tenant-a.example',
            enrichment: params[0] === 'enabled.shop.example' ? JSONLD : null,
          },
        ],
        rowCount: 1,
      }),
    ],
  ]);
  const app = await startApp(db);
  try {
    const enabled = await send(app.url, 'GET', '/routes/resolve?hostname=enabled.shop.example', INGEST_TOKEN);
    assert.equal(enabled.status, 200);
    assert.equal(enabled.body.origin, 'https://tenant-a.example');
    assert.deepEqual(enabled.body.enrichment, JSONLD);

    const disabled = await send(app.url, 'GET', '/routes/resolve?hostname=disabled.shop.example', INGEST_TOKEN);
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.enrichment, null);
  } finally {
    await app.close();
  }
});
