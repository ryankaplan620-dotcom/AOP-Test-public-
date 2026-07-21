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
import { insertDeadLetters } from '../src/repositories.js';

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
  // Params are (reason, record, dedupe_key) triples; one row per record.
  (text, params) => ({ rows: params.filter((_, i) => i % 3 === 1).map((_, i) => ({ id: i + 1 })), rowCount: 1 }),
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
    // At-least-once redelivery must not double-store: the arbiter is load-
    // bearing, pin its presence in the SQL text.
    assert.match(insert.text, /ON CONFLICT \(dedupe_key\) DO NOTHING/);
    assert.equal(insert.params[0], 'edge_dlq');
    assert.deepEqual(JSON.parse(insert.params[1]), records[0]); // verbatim
    assert.equal(insert.params[2], null); // no ids sent -> no dedupe key
    assert.deepEqual(JSON.parse(insert.params[4]), records[1]);
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

test('dead-letters scrubs lone surrogates (jsonb rejects them like NUL) and NUL in reason', async () => {
  const db = fakeDb([insertHit]);
  const app = await startApp(db);
  try {
    // "\ud800" is legal JSON; PG jsonb rejects it with 22P02. The route
    // must make it storable, not let it 500 the whole preserved batch.
    const r = await post(app.url, {
      records: [{ note: 'a\ud800b', ok: 'c\ud83d\ude00d' }],
      reason: 'edge\u0000dlq',
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.stored, 1);
    const insert = db.statements.find((s) => /INSERT INTO dead_letter_telemetry/.test(s.text));
    assert.equal(insert.params[0], 'edgedlq'); // NUL stripped from reason too
    const stored = JSON.parse(insert.params[1]);
    assert.equal(stored.note, 'a\ufffdb'); // lone surrogate -> U+FFFD marker
    assert.equal(stored.ok, 'c\ud83d\ude00d'); // proper pairs untouched
  } finally {
    await app.close();
  }
});

test('dead-letters maps caller ids to dedupe keys, index-aligned across skipped null slots', async () => {
  const db = fakeDb([insertHit]);
  const app = await startApp(db);
  try {
    const r = await post(app.url, {
      records: [{ a: 1 }, null, { b: 2 }],
      ids: ['q:m0', 'q:m1', 'q:m2'],
      reason: 'edge_dlq',
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.stored, 2);
    const insert = db.statements.find((s) => /INSERT INTO dead_letter_telemetry/.test(s.text));
    // Slot 1 was null (skipped) — record {b:2} must keep ITS id, not m1's.
    assert.deepEqual(JSON.parse(insert.params[1]), { a: 1 });
    assert.equal(insert.params[2], 'q:m0');
    assert.deepEqual(JSON.parse(insert.params[4]), { b: 2 });
    assert.equal(insert.params[5], 'q:m2');
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// insertDeadLetters totality: a jsonb-unstorable record must degrade to a
// sentinel row, never abort the batch (the DLQ consumer has no DLQ of its
// own — a permanently-500ing drain LOSES the batch after max_retries).
// ---------------------------------------------------------------------------

/** Fake db whose query() delegates to a scripted function. */
function scriptedDb(fn) {
  const statements = [];
  return {
    statements,
    async query(text, params = []) {
      statements.push({ text, params });
      return fn(text, params, statements.length);
    },
  };
}

test('insertDeadLetters falls back to per-record inserts on a data exception, sentineling the unstorable record', async () => {
  const records = [{ good: 1 }, { poison: true }, { good: 2 }];
  const db = scriptedDb((text, params, n) => {
    if (n === 1) {
      // The multi-row batch INSERT aborts on the poison value.
      const err = new Error('invalid input syntax for type json');
      err.code = '22P02';
      throw err;
    }
    // Per-record path: reject the poison record once, accept its sentinel.
    if (JSON.parse(params[1]).poison === true) {
      const err = new Error('invalid input syntax for type json');
      err.code = '22P02';
      throw err;
    }
    return { rows: [{ id: n }], rowCount: 1 };
  });

  const { stored } = await insertDeadLetters(db, records, 'edge_dlq', ['k0', 'k1', 'k2']);
  assert.equal(stored, 3, 'both good records AND the sentinel stored');
  // 1 batch attempt + 3 per-record + 1 sentinel retry = 5 statements.
  assert.equal(db.statements.length, 5);
  const sentinel = db.statements.find((s) => /aop_unpreservable/.test(s.params[1] ?? ''));
  assert.ok(sentinel, 'sentinel row written for the unstorable record');
  assert.equal(sentinel.params[2], 'k1', 'sentinel keeps the original dedupe key');
});

test('insertDeadLetters propagates infrastructure errors so the queue retries (never fake-succeeds)', async () => {
  const db = scriptedDb(() => {
    const err = new Error('connection terminated');
    err.code = '57P01'; // admin_shutdown — NOT a data exception
    throw err;
  });
  await assert.rejects(() => insertDeadLetters(db, [{ a: 1 }], 'edge_dlq'), /connection terminated/);
  assert.equal(db.statements.length, 1, 'no per-record fallback on infra failure');
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

  // Stateful fake: the STARTUP tick parks on its watermark read until the
  // explicit runOnce() below has finished, then sees the watermark that
  // send wrote and must conclude not_due. (stop() can no longer be used to
  // drain a send — a pass that observes `stopped` before its POST starts
  // now deliberately bails.)
  let watermark = null;
  let parkFirstRead = true;
  let releaseStartupTick;
  const startupGate = new Promise((resolve) => {
    releaseStartupTick = resolve;
  });
  const statements = [];
  const db = {
    async query(text, params = []) {
      statements.push({ text, params });
      if (/INSERT INTO sweep_state/.test(text)) {
        watermark = params[1];
        return { rows: [], rowCount: 1 };
      }
      if (/FROM sweep_state/.test(text)) {
        if (parkFirstRead) {
          parkFirstRead = false;
          await startupGate;
        }
        return watermark === null
          ? { rows: [], rowCount: 0 }
          : { rows: [{ watermark }], rowCount: 1 };
      }
      for (const [pattern, resp] of digestBuildScript) {
        if (pattern.test(text)) return { rows: [], rowCount: 0, ...resp };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const job = startDigestJob({
    db,
    config: { digestWebhookUrl: 'https://hooks.example/digest', digestIntervalMs: 7 * 24 * 3600 * 1000 },
    logger: silentLogger,
  });
  const result = await job.runOnce(); // startup tick is parked; this pass sends
  releaseStartupTick();
  await job.stop(); // startup tick resumes, sees the watermark -> not_due

  assert.equal(result.sent, true);
  assert.equal(posts.length, 1, 'exactly one send: the resumed startup tick was gated by the watermark');
  assert.equal(posts[0].url, 'https://hooks.example/digest');
  assert.equal(posts[0].body.kind, 'aop_weekly_digest');
  assert.equal(posts[0].body.scope, 'platform');
  assert.equal(posts[0].body.dead_letters, 5); // ops alert included
  assert.ok(posts[0].body.text.includes('ALERT: 5 telemetry record(s) dead-lettered'));
  // Watermark advanced (durable no-double-send).
  const wm = statements.find((s) => /INSERT INTO sweep_state/.test(s.text));
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

test('digest stop() during the DB phase prevents a post-shutdown webhook POST', async (t) => {
  // stop() can only abort a POST that already started; a pass still in its
  // DB phase must re-check `stopped` before STARTING one — otherwise a
  // hung webhook pins shutdown for the full 10s timeout (= the process's
  // entire watchdog budget).
  let fetched = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetched += 1;
    return new Response('ok', { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  let releaseWatermark;
  const gate = new Promise((resolve) => {
    releaseWatermark = resolve;
  });
  const db = {
    async query(text) {
      if (/FROM sweep_state/.test(text)) {
        await gate; // hold the pass in its DB phase until stop() has run
        return { rows: [], rowCount: 0 }; // no watermark -> digest is due
      }
      for (const [pattern, resp] of digestBuildScript) {
        if (pattern.test(text)) return { rows: [], rowCount: 0, ...resp };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const job = startDigestJob({
    db,
    config: { digestWebhookUrl: 'https://hooks.example/digest', digestIntervalMs: 1 },
    logger: silentLogger,
  });
  // The startup tick is now blocked inside the watermark read.
  const stopping = job.stop();
  releaseWatermark(); // pass resumes: due -> build -> must bail before fetch
  await stopping;
  assert.equal(fetched, 0, 'no webhook POST may start after stop()');
});

test('digest job is a no-op when DIGEST_WEBHOOK_URL is unset', async () => {
  const db = fakeDb([]);
  const job = startDigestJob({ db, config: { digestWebhookUrl: null, digestIntervalMs: 1 }, logger: silentLogger });
  const result = await job.runOnce();
  await job.stop();
  assert.deepEqual(result, { sent: false, reason: 'disabled' });
  assert.equal(db.statements.length, 0);
});
