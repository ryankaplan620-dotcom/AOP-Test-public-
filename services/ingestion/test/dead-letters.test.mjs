/**
 * test/dead-letters.test.mjs — the DLQ drain endpoint
 * (POST /ingest/dead-letters, migration 0016) + digest builder/job (PR13).
 *
 * Route layer: real express + scripted fake db, matching the house pattern.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { buildTelemetryRouter, MAX_RECORDS_PER_BATCH } from '../src/routes/telemetry.js';
import { startDigestJob, DIGEST_JOB_NAME } from '../src/jobs/digest.js';

const INGEST_TOKEN = 'tok-ingest-test';
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
  app.use(express.json({ limit: '24mb' }));
  app.use('/ingest', buildTelemetryRouter({ config: { ingestApiToken: INGEST_TOKEN }, db, logger: silentLogger }));
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

async function post(baseUrl, body, token = INGEST_TOKEN) {
  const response = await fetch(`${baseUrl}/ingest/dead-letters`, {
    method: 'POST',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const insertHit = [
  /INSERT INTO dead_letter_telemetry/,
  (text, params) => ({ rows: params.filter((_, i) => i % 2 === 1).map((_, i) => ({ id: i + 1 })), rowCount: 1 }),
];

test('POST /ingest/dead-letters preserves records verbatim with the reason', async () => {
  const db = fakeDb([insertHit]);
  const app = await startApp(db);
  try {
    const records = [
      { token: 'tok_x', shop_domain: 'unknown.example', status: 502 },
      { garbage: true, nested: { deep: 'value' } },
    ];
    const r = await post(app.url, { records, reason: 'edge_dlq' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.stored, 2);

    const insert = db.statements.find((s) => /INSERT INTO dead_letter_telemetry/.test(s.text));
    assert.equal(insert.params[0], 'edge_dlq');
    assert.deepEqual(JSON.parse(insert.params[1]), records[0]); // verbatim
    assert.deepEqual(JSON.parse(insert.params[3]), records[1]);
  } finally {
    await app.close();
  }
});

test('dead-letters auth + shape + cap: uniform 401, 400 on bad body, 413 over cap', async () => {
  const db = fakeDb([insertHit]);
  const app = await startApp(db);
  try {
    assert.equal((await post(app.url, { records: [] }, null)).status, 401);
    assert.equal((await post(app.url, { records: [] }, 'wrong')).status, 401);
    assert.equal((await post(app.url, { nope: true })).status, 400);
    const over = await post(app.url, { records: Array(MAX_RECORDS_PER_BATCH + 1).fill({}) });
    assert.equal(over.status, 413);
    // Nothing was written by the refused calls.
    assert.ok(!db.statements.some((s) => /INSERT INTO dead_letter_telemetry/.test(s.text)));
  } finally {
    await app.close();
  }
});

test('dead-letters sanitizes NUL and preserves unpreservable slots as sentinels', async () => {
  const db = fakeDb([insertHit]);
  const app = await startApp(db);
  try {
    const r = await post(app.url, { records: [{ name: 'a\u0000b' }, null] });
    assert.equal(r.status, 200);
    assert.equal(r.body.stored, 1); // null slot skipped
    const insert = db.statements.find((s) => /INSERT INTO dead_letter_telemetry/.test(s.text));
    assert.equal(insert.params[0], 'unknown'); // default reason
    assert.deepEqual(JSON.parse(insert.params[1]), { name: 'ab' }); // NUL stripped
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Digest job (watermark-gated weekly delivery)
// ---------------------------------------------------------------------------

/** Rows every digest build touches (summary/reasons/lift/dead-letters). */
const digestBuildScript = [
  [/AS estimated_losses/, { rows: [{ impressions: '10', orders_won: '2', adjustments: '0', losses: '3', estimated_losses: '42.00' }] }],
  [/AS imp_recent/, { rows: [{ imp_recent: '10', imp_baseline: '8', won_recent: '2', won_baseline: '1' }] }],
  [/FROM dead_letter_telemetry/, { rows: [{ n: '5' }] }],
];

function digestDb({ watermark }) {
  return fakeDb([
    [/FROM sweep_state/, { rows: watermark === null ? [] : [{ watermark }], rowCount: watermark === null ? 0 : 1 }],
    [/INSERT INTO sweep_state/, { rows: [], rowCount: 1 }],
    ...digestBuildScript,
  ]);
}

test('digest job sends when due, POSTs the platform digest, and advances the watermark', async (t) => {
  const posts = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    posts.push({ url, body: JSON.parse(init.body) });
    return new Response('ok', { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  const db = digestDb({ watermark: null }); // never sent -> due
  const job = startDigestJob({
    db,
    config: { digestWebhookUrl: 'https://hooks.example/digest', digestIntervalMs: 7 * 24 * 3600 * 1000 },
    logger: silentLogger,
  });
  // The job fires a catch-up tick at startup; stop() awaits it. (An explicit
  // runOnce() on top would double-send here ONLY because the fake db never
  // persists the watermark the first send wrote.)
  await job.stop();

  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'https://hooks.example/digest');
  assert.equal(posts[0].body.kind, 'aop_weekly_digest');
  assert.equal(posts[0].body.scope, 'platform');
  assert.equal(posts[0].body.dead_letters, 5); // ops alert included
  assert.ok(posts[0].body.text.includes('ALERT: 5 telemetry record(s) dead-lettered'));
  // Watermark advanced (durable no-double-send).
  const wm = db.statements.find((s) => /INSERT INTO sweep_state/.test(s.text));
  assert.ok(wm, 'watermark written');
  assert.equal(wm.params[0], DIGEST_JOB_NAME);
});

test('digest job does NOT send when not due, and does NOT advance on webhook failure', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  // Not due: watermark 1 hour ago with a 7-day interval.
  let fetched = 0;
  globalThis.fetch = async () => {
    fetched += 1;
    return new Response('ok', { status: 200 });
  };
  const dbNotDue = digestDb({ watermark: new Date(Date.now() - 3600_000).toISOString() });
  const jobNotDue = startDigestJob({
    db: dbNotDue,
    config: { digestWebhookUrl: 'https://hooks.example/digest', digestIntervalMs: 7 * 24 * 3600 * 1000 },
    logger: silentLogger,
  });
  const notDue = await jobNotDue.runOnce();
  await jobNotDue.stop();
  assert.equal(notDue.sent, false);
  assert.equal(notDue.reason, 'not_due');
  assert.equal(fetched, 0, 'no webhook call when not due');

  // Webhook 500: no watermark write -> retried next tick.
  globalThis.fetch = async () => new Response('nope', { status: 500 });
  const dbFail = digestDb({ watermark: null });
  const jobFail = startDigestJob({
    db: dbFail,
    config: { digestWebhookUrl: 'https://hooks.example/digest', digestIntervalMs: 7 * 24 * 3600 * 1000 },
    logger: silentLogger,
  });
  const failed = await jobFail.runOnce();
  await jobFail.stop();
  assert.equal(failed.sent, false);
  assert.ok(!dbFail.statements.some((s) => /INSERT INTO sweep_state/.test(s.text)), 'watermark NOT advanced');
});

test('digest job is a no-op when DIGEST_WEBHOOK_URL is unset', async () => {
  const db = fakeDb([]);
  const job = startDigestJob({ db, config: { digestWebhookUrl: null, digestIntervalMs: 1 }, logger: silentLogger });
  const result = await job.runOnce();
  await job.stop();
  assert.deepEqual(result, { sent: false, reason: 'disabled' });
  assert.equal(db.statements.length, 0);
});
