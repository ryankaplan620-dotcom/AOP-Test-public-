/**
 * enrich.test.mjs — edge response enrichment (src/enrich.js) + its wiring
 * into the worker entrypoint (src/index.js) + the shared route cache
 * (src/routing.js).
 *
 * PRIME DIRECTIVE the suite guards: the reply path NEVER fetches. Enrichment
 * comes from a synchronous cache warmed out of band; a cold isolate ships
 * un-enriched (never blocked). Plus: the </script> breakout guard, safe
 * placement (never inside an inline script), the incremental size cap for
 * chunked bodies, compressed-body passthrough, and framing/validator header
 * cleanup.
 *
 * Plain Node (node --test), no network: globalThis.fetch is monkeypatched.
 */

import { it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.js';
import { serializeJsonLd, injectJsonLd, enrichResponse, MAX_ENRICHABLE_BYTES } from '../src/enrich.js';
import { clearDynamicRouteCache, getCachedEnrichment } from '../src/routing.js';

const REAL_FETCH = globalThis.fetch;
beforeEach(() => {
  clearDynamicRouteCache();
});
afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

const JSONLD = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'Red Thread Apparel',
  hasMerchantReturnPolicy: { '@type': 'MerchantReturnPolicy', merchantReturnDays: 30 },
};

function makeEnv() {
  return {
    MERCHANT_ROUTES: JSON.stringify({ 'agents.shop.example': 'https://origin.example' }),
    INGEST_API_URL: 'https://ingest.example',
    INGEST_API_TOKEN: 'tok-edge',
    EDGE_LOG_QUEUE: { send: async () => {} },
  };
}

/** fetch stub: control-plane resolve answers vs origin answers, recording URLs. */
function stubFetch({ resolveBody, resolveStatus = 200, originResponse }) {
  const calls = [];
  globalThis.fetch = async (input) => {
    const urlString = typeof input === 'string' ? input : input.url;
    calls.push(urlString);
    if (urlString.includes('/routes/resolve')) {
      return new Response(JSON.stringify(resolveBody ?? {}), {
        status: resolveStatus,
        headers: { 'content-type': 'application/json' },
      });
    }
    return originResponse ? originResponse() : new Response('unexpected', { status: 500 });
  };
  return calls;
}

const htmlResponse = (html, headers = {}) =>
  new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });

const GET = new Request('https://agents.shop.example/', { method: 'GET' });

// ---------------------------------------------------------------------------
// serializeJsonLd / injectJsonLd (pure)
// ---------------------------------------------------------------------------

it('serializeJsonLd escapes < so a payload can never break out of the tag', () => {
  const hostile = { ...JSONLD, name: 'x</script><script>alert(1)</script>' };
  const serialized = serializeJsonLd(hostile);
  assert.ok(!serialized.includes('<'));
  assert.ok(!serialized.includes('</script>'));
  assert.deepEqual(JSON.parse(serialized), hostile); // escape is pure JSON
});

it('injectJsonLd places the tag before a TOP-LEVEL </head>', () => {
  const out = injectJsonLd('<html><head><title>x</title></head><body>hi</body></html>', JSONLD);
  assert.ok(out.indexOf('data-aop-enriched') < out.indexOf('</head>'));
  assert.ok(out.indexOf('data-aop-enriched') > out.indexOf('</title>')); // after raw-text title
});

it('injectJsonLd NEVER splices inside an inline <script> that contains </head>', () => {
  // The head's own inline script contains the literal "</head>" in a string.
  // Splicing there would prematurely close the merchant's <script>.
  const html =
    '<html><head><script>var s="</head>";document.title=s;</script></head><body>hi</body></html>';
  const out = injectJsonLd(html, JSONLD);
  // The merchant's script source must remain intact and uninterrupted...
  assert.ok(out.includes('<script>var s="</head>";document.title=s;</script>'));
  // ...and the injected tag lands AFTER that inline script closed (at the
  // real top-level </head>), never inside the string literal.
  const injectedAt = out.indexOf('data-aop-enriched');
  const merchantScriptClose = out.indexOf('document.title=s;</script>') + 'document.title=s;</script>'.length;
  assert.ok(injectedAt > merchantScriptClose, 'injected after the inline script closed');
});

it('injectJsonLd appends at end of document when no safe head position exists', () => {
  const out = injectJsonLd('<!-- </head> only in a comment --><body>hi</body>', JSONLD);
  // The only </head> is inside a comment; must NOT inject there.
  assert.ok(out.endsWith('</script>'));
  assert.ok(out.indexOf('data-aop-enriched') > out.indexOf('<body>'));
});

// ---------------------------------------------------------------------------
// enrichResponse (no network; payload supplied)
// ---------------------------------------------------------------------------

it('enrichResponse injects and strips stale framing + validator headers', async () => {
  const original = htmlResponse('<html><head></head><body>store</body></html>', {
    'content-length': '44',
    etag: '"origin-v1"',
    'last-modified': 'Mon, 01 Jan 2026 00:00:00 GMT',
  });
  const out = await enrichResponse({ request: GET, response: original, jsonld: JSONLD });
  const body = await out.text();
  assert.ok(body.includes('data-aop-enriched'));
  assert.ok(body.includes('"merchantReturnDays":30'));
  assert.equal(out.headers.get('x-aop-enriched'), '1');
  assert.equal(out.headers.get('content-length'), null);
  assert.equal(out.headers.get('etag'), null, 'stale validator dropped');
  assert.equal(out.headers.get('last-modified'), null);
});

it('enrichResponse passes through: non-GET, non-200, non-HTML, and COMPRESSED bodies', async () => {
  const cases = [
    { request: new Request('https://x/', { method: 'POST' }), response: htmlResponse('<html></html>') },
    { request: GET, response: new Response('<html></html>', { status: 404, headers: { 'content-type': 'text/html' } }) },
    { request: GET, response: new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }) },
    // Compressed: bytes are gzip, must NOT be decoded as text.
    { request: GET, response: htmlResponse('<html></html>', { 'content-encoding': 'gzip' }) },
  ];
  for (const { request, response } of cases) {
    const out = await enrichResponse({ request, response, jsonld: JSONLD });
    assert.equal(out, response, 'SAME object — stream untouched');
    assert.equal(out.headers.get('x-aop-enriched'), null);
  }
});

it('enrichResponse skips oversize declared-length documents without buffering', async () => {
  const big = htmlResponse('<html></html>', { 'content-length': String(MAX_ENRICHABLE_BYTES + 1) });
  const out = await enrichResponse({ request: GET, response: big, jsonld: JSONLD });
  assert.equal(out, big);
});

it('enrichResponse bounds a chunked/undeclared-length oversize body (no injection, full body preserved)', async () => {
  // A ReadableStream with NO content-length whose total exceeds the cap.
  const chunk = new TextEncoder().encode('<div>' + 'a'.repeat(64 * 1024) + '</div>');
  let emitted = 0;
  const target = MAX_ENRICHABLE_BYTES + chunk.byteLength; // guarantee overflow
  const body = new ReadableStream({
    pull(controller) {
      if (emitted >= target) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
      emitted += chunk.byteLength;
    },
  });
  const response = new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
  const out = await enrichResponse({ request: GET, response, jsonld: JSONLD });
  assert.equal(out.headers.get('x-aop-enriched'), null, 'oversize body not enriched');
  const text = await out.text();
  assert.ok(!text.includes('data-aop-enriched'));
  assert.ok(text.length >= target, 'full body preserved through the passthrough stream');
});

// ---------------------------------------------------------------------------
// Reply path: NEVER fetches; enrichment rides the routing lookup's cache
// ---------------------------------------------------------------------------

/**
 * Dynamic-merchant env: the test hostname is NOT in MERCHANT_ROUTES, so the
 * worker resolves its origin via /routes/resolve — the same call that now
 * carries the enrichment payload.
 */
function dynamicEnv() {
  return {
    MERCHANT_ROUTES: JSON.stringify({}),
    INGEST_API_URL: 'https://ingest.example',
    INGEST_API_TOKEN: 'tok-edge',
    EDGE_LOG_QUEUE: { send: async () => {} },
  };
}
const DYN_HOST = 'agents.dyn.example';

it('dynamic merchant enriches on the FIRST request via the SAME routing lookup (one round trip)', async () => {
  const env = dynamicEnv();
  const calls = stubFetch({
    resolveBody: { origin: 'https://origin.example', enrichment: JSONLD },
    originResponse: () => htmlResponse('<html><head><title>s</title></head><body>store</body></html>'),
  });
  const response = await worker.fetch(
    new Request(`https://${DYN_HOST}/products/tee`, { method: 'GET' }),
    env,
    { waitUntil() {} },
  );
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.ok(body.includes('application/ld+json'));
  assert.ok(body.includes('"@type":"Organization"'));
  assert.equal(response.headers.get('x-aop-enriched'), '1');
  // Exactly ONE control-plane call served BOTH routing and enrichment.
  assert.equal(calls.filter((u) => u.includes('/routes/resolve')).length, 1, 'one round trip for both features');
  assert.ok(body.indexOf('data-aop-enriched') < body.indexOf('</head>'));
});

it('statically-routed merchant is never enriched and makes ZERO control-plane calls', async () => {
  // agents.shop.example IS in MERCHANT_ROUTES -> synchronous origin, no
  // /routes/resolve. Enrichment never fires for it, so a down control plane
  // cannot affect the reply at all.
  const env = makeEnv();
  const calls = stubFetch({
    resolveStatus: 500,
    originResponse: () => htmlResponse('<html><head></head><body>store</body></html>'),
  });
  const start = Date.now();
  const response = await worker.fetch(
    new Request('https://agents.shop.example/', { method: 'GET' }),
    env,
    { waitUntil() {} },
  );
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.ok(!body.includes('data-aop-enriched'));
  assert.equal(response.headers.get('x-aop-enriched'), null);
  assert.equal(calls.filter((u) => u.includes('/routes/resolve')).length, 0, 'static routing makes no control-plane call');
  assert.ok(Date.now() - start < 500, 'reply prompt despite control-plane outage');
});

it('dynamic merchant with enrichment DISABLED enriches nothing; JSON APIs stay byte-identical', async () => {
  const env = dynamicEnv();
  stubFetch({
    resolveBody: { origin: 'https://origin.example', enrichment: null }, // disabled
    originResponse: () =>
      new Response('{"sku":"TEE","available":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  const response = await worker.fetch(
    new Request(`https://${DYN_HOST}/availability?sku=TEE`, { method: 'GET' }),
    env,
    { waitUntil() {} },
  );
  assert.equal(await response.text(), '{"sku":"TEE","available":true}');
  assert.equal(response.headers.get('x-aop-enriched'), null);
  assert.equal(getCachedEnrichment(DYN_HOST).jsonld, null, 'disabled cached as null');
});
