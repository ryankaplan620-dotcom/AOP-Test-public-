/**
 * proxy.test.mjs — behavioral tests for the AOP edge proxy worker entrypoint
 * (src/index.js) plus origin-routing resolution (src/routing.js).
 *
 * Role in the AOP data flow: this suite is the safety net for the live traffic
 * path — it proves the worker transparently passes agent traffic through to
 * merchant origins, that intent telemetry is emitted ONLY for intercepted
 * endpoints, and (critically) that no telemetry/queue failure can ever alter
 * the merchant's response.
 *
 * Runs on plain Node 22 (node --test) with zero network and zero wrangler:
 *  - env is a stub ({EDGE_LOG_QUEUE: {send: recording spy}, ...})
 *  - ctx is a stub that records waitUntil promises so tests can flush deferred
 *    telemetry before asserting on it
 *  - globalThis.fetch is monkeypatched with a mock origin per test
 */

import { it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import worker, { RETRY_DELAY_SECONDS, DLQ_RETRY_DELAY_SECONDS } from '../src/index.js';
import { resolveOrigin } from '../src/routing.js';

// ---------------------------------------------------------------------------
// Test harness helpers
// ---------------------------------------------------------------------------

const REAL_FETCH = globalThis.fetch;
afterEach(() => {
  // Always restore the real fetch so one test's mock can't leak into the next.
  globalThis.fetch = REAL_FETCH;
});

/** ctx stub: records waitUntil promises so tests can await deferred telemetry. */
function makeCtx() {
  const ctx = {
    promises: [],
    waitUntil(promise) {
      this.promises.push(promise);
    },
  };
  return ctx;
}

/** Await all deferred (waitUntil) work registered during a fetch() call. */
async function flush(ctx) {
  await Promise.all(ctx.promises);
}

/** Queue binding spy: records every record passed to .send(). */
function makeQueueSpy() {
  const sends = [];
  return {
    sends,
    binding: {
      send: async (record) => {
        sends.push(record);
      },
    },
  };
}

/** Standard env stub with the redthread merchant route configured. */
function makeEnv(queueBinding, overrides = {}) {
  return {
    EDGE_LOG_QUEUE: queueBinding,
    MERCHANT_ROUTES: JSON.stringify({
      'agents.redthread.aop.network': 'https://redthreadapparel.com',
    }),
    DEFAULT_ORIGIN: '',
    INGEST_API_URL: 'https://ingest.example.com',
    INGEST_API_TOKEN: 'test-token',
    ...overrides,
  };
}

/**
 * Monkeypatch globalThis.fetch with a mock origin; returns the recorded calls
 * ({input, init}) for assertions on what the proxy forwarded.
 */
function installMockOrigin(handler) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ input: String(input), init });
    return handler(input, init);
  };
  return calls;
}

// ---------------------------------------------------------------------------
// fetch(): transparent passthrough
// ---------------------------------------------------------------------------

it('proxies status, body and headers transparently and stamps X-AOP-Latency-Ms', async () => {
  const { sends, binding } = makeQueueSpy();
  const env = makeEnv(binding);
  const ctx = makeCtx();
  const calls = installMockOrigin(
    () =>
      new Response('origin-body-bytes', {
        status: 418,
        headers: { 'content-type': 'text/plain', 'x-origin-header': 'yes' },
      }),
  );

  const request = new Request(
    'https://agents.redthread.aop.network/products/42?ref=agent',
    { headers: { 'x-custom-agent': 'v1' } },
  );
  const response = await worker.fetch(request, env, ctx);

  // Origin response passes through untouched: status, body, headers.
  assert.equal(response.status, 418);
  assert.equal(await response.text(), 'origin-body-bytes');
  assert.equal(response.headers.get('x-origin-header'), 'yes');
  assert.equal(response.headers.get('content-type'), 'text/plain');

  // Latency stamp added on the way back out.
  const latency = response.headers.get('x-aop-latency-ms');
  assert.ok(latency !== null, 'latency header must be present');
  assert.ok(Number.isFinite(Number(latency)) && Number(latency) >= 0);

  // Forwarded request: mapped origin host, same path + query, headers copied,
  // proxy marker header added.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, 'https://redthreadapparel.com/products/42?ref=agent');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.get('x-custom-agent'), 'v1');
  assert.equal(calls[0].init.headers.get('x-aop-proxy-processed'), 'true');

  // Non-intercepted path: no telemetry at all.
  await flush(ctx);
  assert.equal(sends.length, 0);
});

it('does not send telemetry for non-intercepted paths (POST included)', async () => {
  const { sends, binding } = makeQueueSpy();
  const env = makeEnv(binding);
  const ctx = makeCtx();
  installMockOrigin(() => new Response('ok', { status: 200 }));

  const request = new Request('https://agents.redthread.aop.network/cart/add', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sku: 'SKU-SHOULD-NOT-LOG' }),
  });
  const response = await worker.fetch(request, env, ctx);

  assert.equal(response.status, 200);
  await flush(ctx);
  assert.equal(sends.length, 0, 'non-intent endpoints must not produce telemetry');
  assert.equal(ctx.promises.length, 0, 'no deferred work should even be scheduled');
});

// ---------------------------------------------------------------------------
// fetch(): telemetry for intercepted intent endpoints
// ---------------------------------------------------------------------------

it('emits a full telemetry record for GET /availability?sku=...', async () => {
  const { sends, binding } = makeQueueSpy();
  const env = makeEnv(binding);
  const ctx = makeCtx();
  installMockOrigin(
    () =>
      new Response(JSON.stringify({ available: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );

  const request = new Request(
    'https://agents.redthread.aop.network/availability?sku=SKU-RED-01',
    {
      headers: {
        'X-Agent-Transaction-Token': 'tok_abc123',
        'X-Agent-Protocol': 'ACP',
      },
    },
  );
  const response = await worker.fetch(request, env, ctx);
  assert.equal(response.status, 200);

  await flush(ctx);
  assert.equal(sends.length, 1);
  const record = sends[0];
  assert.equal(record.token, 'tok_abc123');
  assert.equal(record.protocol, 'ACP');
  assert.equal(record.method, 'GET');
  assert.equal(record.path, '/availability');
  assert.equal(record.query, '?sku=SKU-RED-01');
  assert.equal(record.target_sku, 'SKU-RED-01');
  assert.equal(record.shop_domain, 'redthreadapparel.com');
  assert.equal(record.inbound_payload, null, 'GET has no body payload');
  assert.equal(record.status, 200);
  assert.ok(typeof record.latency_ms === 'number' && record.latency_ms >= 0);
  assert.ok(!Number.isNaN(Date.parse(record.observed_at)), 'observed_at must be ISO');
});

it('emits telemetry with parsed body + SKU for POST /shipping_quote and streams the body to origin', async () => {
  const { sends, binding } = makeQueueSpy();
  const env = makeEnv(binding);
  const ctx = makeCtx();

  const inboundBody = JSON.stringify({
    items: [{ sku: 'SKU-JACKET-9', quantity: 2 }],
    destination: { postal_code: '94107', country: 'US' },
  });

  let bodySeenByOrigin = null;
  installMockOrigin(async (_input, init) => {
    // The proxy must forward the body as a stream; read it like an origin would.
    bodySeenByOrigin = await new Response(init.body).text();
    return new Response(JSON.stringify({ quote_cents: 899 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  const request = new Request('https://agents.redthread.aop.network/shipping_quote', {
    method: 'POST',
    headers: { 'content-type': 'application/json' }, // NOTE: no agent headers -> fallbacks
    body: inboundBody,
  });
  const response = await worker.fetch(request, env, ctx);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { quote_cents: 899 });
  assert.equal(bodySeenByOrigin, inboundBody, 'origin must receive the exact inbound body');

  await flush(ctx);
  assert.equal(sends.length, 1);
  const record = sends[0];
  assert.equal(record.token, 'headless_anonymous', 'missing token header falls back');
  assert.equal(record.protocol, 'UNKNOWN_PROTOCOL', 'missing protocol header falls back');
  assert.equal(record.method, 'POST');
  assert.equal(record.path, '/shipping_quote');
  assert.equal(record.query, '');
  assert.equal(record.target_sku, 'SKU-JACKET-9', 'SKU extracted from items[0].sku');
  assert.deepEqual(record.inbound_payload, JSON.parse(inboundBody));
  assert.equal(record.shop_domain, 'redthreadapparel.com');
  assert.equal(record.status, 200);
});

it('intercepts intent endpoints as the final path segment (e.g. /apps/acp/availability)', async () => {
  const { sends, binding } = makeQueueSpy();
  const env = makeEnv(binding);
  const ctx = makeCtx();
  const calls = installMockOrigin(() => new Response('{}', { status: 200 }));

  const request = new Request(
    'https://agents.redthread.aop.network/apps/acp/availability?sku=A1',
  );
  await worker.fetch(request, env, ctx);

  // Full path preserved on the forwarded request.
  assert.equal(calls[0].input, 'https://redthreadapparel.com/apps/acp/availability?sku=A1');

  await flush(ctx);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].path, '/apps/acp/availability');
  assert.equal(sends[0].target_sku, 'A1');
});

// ---------------------------------------------------------------------------
// fetch(): telemetry failures must never touch the response
// ---------------------------------------------------------------------------

it('queue send failure does NOT affect the merchant response', async () => {
  const env = makeEnv({
    send: () => {
      throw new Error('queue infrastructure is down');
    },
  });
  const ctx = makeCtx();
  installMockOrigin(() => new Response('all good', { status: 200 }));

  const request = new Request('https://agents.redthread.aop.network/availability?sku=X1');
  const response = await worker.fetch(request, env, ctx);

  // Response is untouched by the queue explosion...
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'all good');

  // ...and the deferred telemetry promise resolves (never rejects) so the
  // runtime sees no unhandled failure either.
  await assert.doesNotReject(() => flush(ctx));
});

it('missing EDGE_LOG_QUEUE binding is tolerated (telemetry dropped, response intact)', async () => {
  const env = makeEnv(undefined); // no queue binding at all
  const ctx = makeCtx();
  installMockOrigin(() => new Response('fine', { status: 200 }));

  const request = new Request('https://agents.redthread.aop.network/availability?sku=X2');
  const response = await worker.fetch(request, env, ctx);
  assert.equal(response.status, 200);
  await assert.doesNotReject(() => flush(ctx));
});

// ---------------------------------------------------------------------------
// fetch(): failure modes -> controlled 502s
// ---------------------------------------------------------------------------

it('returns a 502 JSON error when no origin can be resolved, without calling fetch', async () => {
  const { sends, binding } = makeQueueSpy();
  const env = makeEnv(binding, { MERCHANT_ROUTES: '{}', DEFAULT_ORIGIN: '', INGEST_API_URL: '' });
  const ctx = makeCtx();
  const calls = installMockOrigin(() => new Response('should never happen'));

  const request = new Request('https://unknown-host.example.com/availability?sku=Z');
  const response = await worker.fetch(request, env, ctx);

  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error, 'no_origin_configured');
  assert.equal(typeof body.message, 'string');
  assert.equal(calls.length, 0, 'must not dispatch to any origin (and must not loop to self)');

  // NO telemetry for unroutable traffic: a shop_domain-less record is
  // rejected by the ingestion validator by contract, so queueing it would
  // only burn a queue message per scanner hit (review finding).
  await flush(ctx);
  assert.equal(sends.length, 0, 'unroutable requests must not queue telemetry');
});

it('a "//"-prefixed inbound path cannot override the origin host (SSRF regression)', async () => {
  // Regression for a critical review finding: building the origin URL as
  // new URL(pathname + search, originBase) treats "//attacker.example.com/x"
  // as protocol-relative and swaps the host, leaking agent headers (including
  // X-Agent-Transaction-Token) to an attacker-chosen server. The proxy must
  // always dispatch to the configured merchant origin.
  const { binding } = makeQueueSpy();
  const env = makeEnv(binding);
  const ctx = makeCtx();
  const calls = installMockOrigin(() => new Response('ok', { status: 200 }));

  const request = new Request(
    'https://agents.redthread.aop.network//attacker.example.com/collect?x=1',
    { headers: { 'X-Agent-Transaction-Token': 'tok_secret' } },
  );
  const response = await worker.fetch(request, env, ctx);

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  const forwarded = new URL(calls[0].input);
  assert.equal(forwarded.hostname, 'redthreadapparel.com', 'host must stay the merchant origin');
  assert.ok(
    forwarded.pathname.includes('attacker.example.com'),
    'the hostile path is forwarded as a mere path on the real origin',
  );
});

it('refuses to proxy to itself when a route maps a hostname back to itself', async () => {
  const { binding } = makeQueueSpy();
  const env = makeEnv(binding, {
    MERCHANT_ROUTES: JSON.stringify({ 'loop.aop.network': 'https://loop.aop.network' }),
    DEFAULT_ORIGIN: '',
    INGEST_API_URL: '', // dynamic routing off: this test isolates the static self-loop guard
  });
  const ctx = makeCtx();
  const calls = installMockOrigin(() => new Response('nope'));

  const request = new Request('https://loop.aop.network/products/1');
  const response = await worker.fetch(request, env, ctx);

  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, 'no_origin_configured');
  assert.equal(calls.length, 0);
});

it('returns a 502 JSON error when the origin fetch throws, and still records telemetry with status 502', async () => {
  const { sends, binding } = makeQueueSpy();
  const env = makeEnv(binding);
  const ctx = makeCtx();
  installMockOrigin(() => {
    throw new Error('ECONNREFUSED to origin');
  });

  const request = new Request('https://agents.redthread.aop.network/availability?sku=DOWN-1', {
    headers: { 'X-Agent-Transaction-Token': 'tok_down' },
  });
  const response = await worker.fetch(request, env, ctx);

  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error, 'origin_unreachable');

  await flush(ctx);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].status, 502);
  assert.equal(sends[0].token, 'tok_down');
  assert.equal(sends[0].target_sku, 'DOWN-1');
  assert.equal(sends[0].shop_domain, 'redthreadapparel.com', 'origin was resolved, just unreachable');
});

// ---------------------------------------------------------------------------
// routing: resolveOrigin()
// ---------------------------------------------------------------------------

it('resolveOrigin maps configured hostnames (case-insensitively) and normalizes origins', () => {
  const env = {
    MERCHANT_ROUTES: JSON.stringify({
      'agents.redthread.aop.network': 'https://redthreadapparel.com/some/base/path',
    }),
    DEFAULT_ORIGIN: '',
  };
  assert.equal(
    resolveOrigin('AGENTS.REDTHREAD.AOP.NETWORK', env),
    'https://redthreadapparel.com',
  );
});

it('resolveOrigin falls back to DEFAULT_ORIGIN for unmapped hosts, and to null when unset', () => {
  const env = {
    MERCHANT_ROUTES: '{}',
    DEFAULT_ORIGIN: 'https://fallback-merchant.example.com',
  };
  assert.equal(resolveOrigin('anything.example.org', env), 'https://fallback-merchant.example.com');
  assert.equal(resolveOrigin('anything.example.org', { MERCHANT_ROUTES: '{}', DEFAULT_ORIGIN: '' }), null);
  assert.equal(resolveOrigin('anything.example.org', {}), null);
});

it('resolveOrigin tolerates malformed MERCHANT_ROUTES JSON and still serves DEFAULT_ORIGIN', async () => {
  const env = {
    MERCHANT_ROUTES: '{this is : not json',
    DEFAULT_ORIGIN: 'https://fallback-merchant.example.com',
  };
  assert.equal(resolveOrigin('agents.redthread.aop.network', env), 'https://fallback-merchant.example.com');

  // And the full proxy path works end-to-end on the fallback.
  const { binding } = makeQueueSpy();
  const ctx = makeCtx();
  const calls = installMockOrigin(() => new Response('ok', { status: 200 }));
  const response = await worker.fetch(
    new Request('https://agents.redthread.aop.network/products/9'),
    { ...env, EDGE_LOG_QUEUE: binding },
    ctx,
  );
  assert.equal(response.status, 200);
  assert.equal(calls[0].input, 'https://fallback-merchant.example.com/products/9');
});

it('resolveOrigin skips individually invalid route entries without poisoning valid ones', () => {
  const env = {
    MERCHANT_ROUTES: JSON.stringify({
      'good.aop.network': 'https://good-merchant.example.com',
      'bad.aop.network': 'not-a-url',
      'worse.aop.network': 'ftp://wrong-scheme.example.com',
    }),
    DEFAULT_ORIGIN: '',
  };
  assert.equal(resolveOrigin('good.aop.network', env), 'https://good-merchant.example.com');
  assert.equal(resolveOrigin('bad.aop.network', env), null);
  assert.equal(resolveOrigin('worse.aop.network', env), null);
});

// ---------------------------------------------------------------------------
// queue(): consumer -> ingestion service
// ---------------------------------------------------------------------------

/** Queue batch stub with recording ack/retry spies. */
function makeBatch(bodies, { withRetryAll = true } = {}) {
  const state = { ackAllCalls: 0, retryAllCalls: 0, retryDelays: [], ackedIds: [] };
  const batch = {
    messages: bodies.map((body, i) => ({
      id: `msg-${i}`,
      body,
      ack() {
        state.ackedIds.push(`msg-${i}`);
      },
    })),
    ackAll() {
      state.ackAllCalls += 1;
    },
  };
  if (withRetryAll) {
    batch.retryAll = (options) => {
      state.retryAllCalls += 1;
      state.retryDelays.push(options?.delaySeconds ?? null);
    };
  }
  return { batch, state };
}

it('queue() POSTs the batch to INGEST_API_URL/ingest/telemetry with auth and acks on 2xx', async () => {
  const env = makeEnv(undefined, { INGEST_API_URL: 'https://ingest.example.com/' }); // trailing slash on purpose
  const records = [
    { token: 'tok_1', path: '/availability', status: 200 },
    { token: 'tok_2', path: '/shipping_quote', status: 200 },
  ];
  const { batch, state } = makeBatch(records);

  const calls = installMockOrigin(() => new Response('{"accepted":2}', { status: 200 }));
  await worker.queue(batch, env);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, 'https://ingest.example.com/ingest/telemetry');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['authorization'], 'Bearer test-token');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { records });

  assert.equal(state.ackAllCalls, 1, 'batch acked on 2xx');
  assert.equal(state.retryAllCalls, 0);
});

it('queue() routes DLQ batches to /ingest/dead-letters with the edge_dlq reason and dedupe ids (PR13)', async () => {
  const env = makeEnv(undefined, { INGEST_API_URL: 'https://ingest.example.com' });
  const records = [{ token: 'tok_poison', path: '/availability', status: 502 }];
  const { batch, state } = makeBatch(records);
  batch.queue = 'aop-edge-telemetry-dlq'; // Queues stamps the source queue name

  const calls = installMockOrigin(() => new Response('{"stored":1}', { status: 200 }));
  await worker.queue(batch, env);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, 'https://ingest.example.com/ingest/dead-letters');
  // ids are "<queue>:<message id>" so at-least-once redelivery cannot
  // double-store the records server-side.
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    records,
    reason: 'edge_dlq',
    ids: ['aop-edge-telemetry-dlq:msg-0'],
  });
  assert.equal(state.ackAllCalls, 1, 'preserved batch acked');
  assert.equal(state.retryAllCalls, 0);
});

it('queue() retries a DLQ batch with the LONG preservation backoff when the drain fails (never re-posts to /ingest/telemetry)', async () => {
  const env = makeEnv(undefined, { INGEST_API_URL: 'https://ingest.example.com' });
  const { batch, state } = makeBatch([{ token: 'tok_poison' }]);
  batch.queue = 'aop-edge-telemetry-dlq';

  const calls = installMockOrigin(() => new Response('down', { status: 503 }));
  await worker.queue(batch, env);

  assert.equal(calls.length, 1);
  assert.ok(calls[0].input.endsWith('/ingest/dead-letters'), 'DLQ batches never go back to /ingest/telemetry');
  assert.equal(state.retryAllCalls, 1, 'preservation retried');
  // An explicit retryAll delay OVERRIDES wrangler.toml's retry_delay: the
  // hot path's 30s here would shrink the DLQ's preservation window ~20x.
  assert.deepEqual(state.retryDelays, [DLQ_RETRY_DELAY_SECONDS]);
  assert.equal(state.ackAllCalls, 0);
});

it('queue() retries normal telemetry batches with the short hot-path backoff', async () => {
  const env = makeEnv(undefined, { INGEST_API_URL: 'https://ingest.example.com' });
  const { batch, state } = makeBatch([{ token: 'tok_1' }]);

  const calls = installMockOrigin(() => new Response('down', { status: 503 }));
  await worker.queue(batch, env);

  assert.equal(calls.length, 1);
  assert.deepEqual(state.retryDelays, [RETRY_DELAY_SECONDS]);
});

it('queue() retries the batch when the ingest service returns non-2xx', async () => {
  const env = makeEnv(undefined);
  const { batch, state } = makeBatch([{ token: 'tok_x' }]);

  installMockOrigin(() => new Response('sad', { status: 503 }));
  await worker.queue(batch, env);

  assert.equal(state.retryAllCalls, 1, 'non-2xx must trigger retryAll');
  assert.equal(state.ackAllCalls, 0, 'must not ack a failed batch');
});

it('queue() retries the batch when the ingest POST itself throws', async () => {
  const env = makeEnv(undefined);
  const { batch, state } = makeBatch([{ token: 'tok_y' }]);

  installMockOrigin(() => {
    throw new Error('network partition');
  });
  await worker.queue(batch, env);

  assert.equal(state.retryAllCalls, 1);
  assert.equal(state.ackAllCalls, 0);
});

it('queue() throws (so Queues redelivers) when retryAll is unavailable on failure', async () => {
  const env = makeEnv(undefined);
  const { batch } = makeBatch([{ token: 'tok_z' }], { withRetryAll: false });

  installMockOrigin(() => new Response('nope', { status: 500 }));
  await assert.rejects(() => worker.queue(batch, env), /responded 500/);
});

it('queue() logs and ACKS (drops) when INGEST_API_URL is unset instead of retrying forever', async () => {
  const env = makeEnv(undefined, { INGEST_API_URL: '' });
  const { batch, state } = makeBatch([{ token: 'tok_cfg' }]);

  const calls = installMockOrigin(() => new Response('should not be called'));
  await worker.queue(batch, env);

  assert.equal(calls.length, 0, 'no POST attempted without a destination');
  assert.equal(state.ackAllCalls, 1, 'batch dropped via ack so the queue does not wedge');
  assert.equal(state.retryAllCalls, 0);
});

// ---------------------------------------------------------------------------
// Dynamic (database-backed) routing: resolveOriginDynamic + fetch() fallback
// ---------------------------------------------------------------------------

import { clearDynamicRouteCache } from '../src/routing.js';

/** Mock fetch that answers /routes/resolve and a mock origin, counting calls. */
function installResolveAndOrigin({ resolveStatus = 200, origin = 'https://resolved-merchant.example.com' } = {}) {
  const counts = { resolve: 0, origin: 0 };
  const seen = { resolveAuth: null, originUrl: null };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('/routes/resolve')) {
      counts.resolve += 1;
      seen.resolveAuth = init.headers?.authorization ?? init.headers?.get?.('authorization') ?? null;
      if (resolveStatus !== 200) return new Response('{"error":"no route"}', { status: resolveStatus });
      return new Response(JSON.stringify({ hostname: 'x', origin }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    counts.origin += 1;
    seen.originUrl = url;
    return new Response('origin-ok', { status: 200 });
  };
  return { counts, seen };
}

it('falls back to dynamic resolution when static routes miss, and caches it', async () => {
  clearDynamicRouteCache();
  const { sends, binding } = makeQueueSpy();
  const env = makeEnv(binding, { MERCHANT_ROUTES: '{}', DEFAULT_ORIGIN: '' });
  const { counts, seen } = installResolveAndOrigin();

  const request = () =>
    worker.fetch(
      new Request('https://newstore.agents.aop.network/availability?sku=DYN-1', {
        headers: { 'X-Agent-Transaction-Token': 'tok_dyn' },
      }),
      env,
      makeCtx(),
    );

  const first = await request();
  assert.equal(first.status, 200);
  assert.equal(await first.text(), 'origin-ok');
  assert.equal(counts.resolve, 1, 'one control-plane lookup on the cold path');
  assert.equal(seen.resolveAuth, 'Bearer test-token', 'resolve call carries the edge credential');
  assert.ok(seen.originUrl.startsWith('https://resolved-merchant.example.com/availability'));

  const second = await request();
  assert.equal(second.status, 200);
  assert.equal(counts.resolve, 1, 'second request must hit the per-isolate cache');
  assert.equal(counts.origin, 2);
});

it('caches negative resolutions and returns the controlled 502', async () => {
  clearDynamicRouteCache();
  const { binding } = makeQueueSpy();
  const env = makeEnv(binding, { MERCHANT_ROUTES: '{}', DEFAULT_ORIGIN: '' });
  const { counts } = installResolveAndOrigin({ resolveStatus: 404 });

  for (let i = 0; i < 3; i++) {
    const response = await worker.fetch(
      new Request('https://unknown.agents.aop.network/availability?sku=X'),
      env,
      makeCtx(),
    );
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error, 'no_origin_configured');
  }
  assert.equal(counts.resolve, 1, 'negative result cached — one lookup for three requests');
  assert.equal(counts.origin, 0, 'nothing proxied for an unroutable host');
});

it('suffix gate: non-matching hostnames never trigger a dynamic lookup', async () => {
  clearDynamicRouteCache();
  const { binding } = makeQueueSpy();
  const env = makeEnv(binding, {
    MERCHANT_ROUTES: '{}',
    DEFAULT_ORIGIN: '',
    PROXY_HOSTNAME_SUFFIX: '.agents.aop.network',
  });
  const { counts } = installResolveAndOrigin();

  const outside = await worker.fetch(
    new Request('https://scanner-spray.example.org/availability'),
    env,
    makeCtx(),
  );
  assert.equal(outside.status, 502);
  assert.equal(counts.resolve, 0, 'suffix mismatch must not reach the control plane');

  const inside = await worker.fetch(
    new Request('https://shop.agents.aop.network/availability?sku=A'),
    env,
    makeCtx(),
  );
  assert.equal(inside.status, 200);
  assert.equal(counts.resolve, 1);
});

it('dynamic resolution failure degrades to 502, never an exception', async () => {
  clearDynamicRouteCache();
  const { binding } = makeQueueSpy();
  const env = makeEnv(binding, { MERCHANT_ROUTES: '{}', DEFAULT_ORIGIN: '' });
  globalThis.fetch = async () => {
    throw new Error('control plane unreachable');
  };
  const response = await worker.fetch(
    new Request('https://anything.agents.aop.network/availability'),
    env,
    makeCtx(),
  );
  assert.equal(response.status, 502);
});

it('static MERCHANT_ROUTES still wins without any dynamic lookup', async () => {
  clearDynamicRouteCache();
  const { binding } = makeQueueSpy();
  const env = makeEnv(binding); // has the redthread static route
  const { counts } = installResolveAndOrigin();

  const response = await worker.fetch(
    new Request('https://agents.redthread.aop.network/products/1'),
    env,
    makeCtx(),
  );
  assert.equal(response.status, 200);
  assert.equal(counts.resolve, 0, 'static hit must stay on the synchronous path');
});

it('rewrites origin-host redirect Locations onto the proxy hostname (review regression)', async () => {
  // Shopify origins routinely 301 (canonicalization). Passing the origin-host
  // Location through would eject the agent from the proxy permanently —
  // attribution for the session ends. Foreign-host redirects pass untouched.
  const { binding } = makeQueueSpy();
  const env = makeEnv(binding);
  const ctx = makeCtx();
  installMockOrigin(
    () =>
      new Response(null, {
        status: 301,
        headers: { Location: 'https://redthreadapparel.com/availability/' },
      })
  );
  const request = new Request('https://agents.redthread.aop.network/availability?sku=A');
  const response = await worker.fetch(request, env, ctx);
  assert.equal(response.status, 301);
  const location = new URL(response.headers.get('Location'));
  assert.equal(location.hostname, 'agents.redthread.aop.network', 'redirect stays on the proxy');
  assert.equal(location.pathname, '/availability/');

  // Foreign-host redirect (off-site payment) is NOT rewritten.
  installMockOrigin(
    () => new Response(null, { status: 302, headers: { Location: 'https://pay.example.com/x' } })
  );
  const response2 = await worker.fetch(request, env, makeCtx());
  assert.equal(new URL(response2.headers.get('Location')).hostname, 'pay.example.com');
});
