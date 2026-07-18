/**
 * telemetry.test.mjs — unit tests for the pure telemetry helpers
 * (src/telemetry.js) of the AOP edge proxy.
 *
 * Role in the AOP data flow: these helpers turn a raw agent request into the
 * intent-telemetry record that drives attribution (token stitching against
 * Shopify order webhooks), commission math, and loss_diagnostics downstream —
 * so this suite pins down header fallbacks, the 32KB bounded body snapshot,
 * SKU extraction precedence, and above all the "never throws" contract.
 *
 * Runs on plain Node 22 (node --test): Request/Response/URL come from undici's
 * globals; no network, no wrangler.
 */

import { it } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractAgentSignature,
  buildTelemetryRecord,
  MAX_BODY_SNAPSHOT_BYTES,
} from '../src/telemetry.js';

// ---------------------------------------------------------------------------
// extractAgentSignature
// ---------------------------------------------------------------------------

it('extractAgentSignature reads both agent headers when present', () => {
  const request = new Request('https://x.example/availability', {
    headers: {
      'X-Agent-Transaction-Token': 'tok_777',
      'X-Agent-Protocol': 'AP2',
    },
  });
  assert.deepEqual(extractAgentSignature(request), { token: 'tok_777', protocol: 'AP2', geo: null });
});

it('extractAgentSignature falls back for missing headers', () => {
  const request = new Request('https://x.example/availability');
  assert.deepEqual(extractAgentSignature(request), {
    token: 'headless_anonymous',
    protocol: 'UNKNOWN_PROTOCOL',
    geo: null,
  });
});

it('extractAgentSignature treats blank/whitespace headers as missing and trims real values', () => {
  const request = new Request('https://x.example/availability', {
    headers: {
      'X-Agent-Transaction-Token': '   ',
      'X-Agent-Protocol': '  ACP  ',
    },
  });
  assert.deepEqual(extractAgentSignature(request), {
    token: 'headless_anonymous',
    protocol: 'ACP',
    geo: null,
  });
});

it('extractAgentSignature never throws on garbage inputs', () => {
  assert.deepEqual(extractAgentSignature(null), {
    token: 'headless_anonymous',
    protocol: 'UNKNOWN_PROTOCOL',
    geo: null,
  });
  assert.deepEqual(extractAgentSignature(undefined), {
    token: 'headless_anonymous',
    protocol: 'UNKNOWN_PROTOCOL',
    geo: null,
  });
  // A hostile headers object that throws on .get() must still yield fallbacks.
  const hostile = {
    headers: {
      get() {
        throw new Error('boom');
      },
    },
  };
  assert.deepEqual(extractAgentSignature(hostile), {
    token: 'headless_anonymous',
    protocol: 'UNKNOWN_PROTOCOL',
    geo: null,
  });
});

// ---------------------------------------------------------------------------
// buildTelemetryRecord: happy paths
// ---------------------------------------------------------------------------

const META = {
  token: 'tok_meta',
  protocol: 'ACP',
  shopDomain: 'redthreadapparel.com',
  status: 200,
  latencyMs: 12,
};

it('buildTelemetryRecord captures a GET availability probe with ?sku=', async () => {
  const url = new URL('https://agents.redthread.aop.network/availability?sku=SKU-1&qty=3');
  const request = new Request(url);
  const record = await buildTelemetryRecord(request, url, META);

  assert.equal(record.token, 'tok_meta');
  assert.equal(record.protocol, 'ACP');
  assert.equal(record.method, 'GET');
  assert.equal(record.path, '/availability');
  assert.equal(record.query, '?sku=SKU-1&qty=3');
  assert.equal(record.target_sku, 'SKU-1');
  assert.equal(record.shop_domain, 'redthreadapparel.com');
  assert.equal(record.inbound_payload, null);
  assert.equal(record.status, 200);
  assert.equal(record.latency_ms, 12);
  // observed_at must be a real ISO timestamp (round-trips through Date).
  assert.equal(new Date(record.observed_at).toISOString(), record.observed_at);
});

it('buildTelemetryRecord parses a JSON POST body and extracts sku from it', async () => {
  const payload = { sku: 'SKU-BODY-1', quantity: 2 };
  const url = new URL('https://agents.redthread.aop.network/shipping_quote');
  const request = new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const record = await buildTelemetryRecord(request, url, META);

  assert.equal(record.method, 'POST');
  assert.deepEqual(record.inbound_payload, payload);
  assert.equal(record.target_sku, 'SKU-BODY-1');
});

// ---------------------------------------------------------------------------
// buildTelemetryRecord: SKU extraction precedence
// ---------------------------------------------------------------------------

it('query ?sku= takes precedence over any body field', async () => {
  const url = new URL('https://x.example/availability?sku=FROM-QUERY');
  const request = new Request(url, {
    method: 'POST',
    body: JSON.stringify({ sku: 'FROM-BODY' }),
  });
  const record = await buildTelemetryRecord(request, url, META);
  assert.equal(record.target_sku, 'FROM-QUERY');
});

it('body field precedence: sku > product_sku > variant_sku > items[0].sku', async () => {
  const url = new URL('https://x.example/shipping_quote');
  const make = (body) =>
    new Request(url, { method: 'POST', body: JSON.stringify(body) });

  let record = await buildTelemetryRecord(
    make({ sku: 'A', product_sku: 'B', variant_sku: 'C', items: [{ sku: 'D' }] }),
    url,
    META,
  );
  assert.equal(record.target_sku, 'A');

  record = await buildTelemetryRecord(
    make({ product_sku: 'B', variant_sku: 'C', items: [{ sku: 'D' }] }),
    url,
    META,
  );
  assert.equal(record.target_sku, 'B');

  record = await buildTelemetryRecord(
    make({ variant_sku: 'C', items: [{ sku: 'D' }] }),
    url,
    META,
  );
  assert.equal(record.target_sku, 'C');

  record = await buildTelemetryRecord(make({ items: [{ sku: 'D' }] }), url, META);
  assert.equal(record.target_sku, 'D');

  record = await buildTelemetryRecord(make({ note: 'no sku anywhere' }), url, META);
  assert.equal(record.target_sku, null);
});

it('numeric SKUs are stringified', async () => {
  const url = new URL('https://x.example/shipping_quote');
  const request = new Request(url, { method: 'POST', body: JSON.stringify({ sku: 98765 }) });
  const record = await buildTelemetryRecord(request, url, META);
  assert.equal(record.target_sku, '98765');
});

// ---------------------------------------------------------------------------
// buildTelemetryRecord: defensive paths (the "never throws" contract)
// ---------------------------------------------------------------------------

it('malformed JSON body yields a partial record (inbound_payload null) without throwing', async () => {
  const url = new URL('https://x.example/shipping_quote?sku=STILL-HERE');
  const request = new Request(url, {
    method: 'POST',
    body: '{definitely not json',
  });
  const record = await buildTelemetryRecord(request, url, META);

  assert.equal(record.inbound_payload, null);
  // Query-derived fields survive the body parse failure.
  assert.equal(record.target_sku, 'STILL-HERE');
  assert.equal(record.path, '/shipping_quote');
  assert.equal(record.status, 200);
});

it('bodies over the 32KB cap are treated as unparseable (bounded snapshot, no throw)', async () => {
  // A valid-JSON body that exceeds the cap: must NOT be parsed (truncation
  // would mangle it) and must NOT be buffered past the bound.
  const oversized = JSON.stringify({ sku: 'HIDDEN', pad: 'x'.repeat(MAX_BODY_SNAPSHOT_BYTES + 4096) });
  assert.ok(oversized.length > MAX_BODY_SNAPSHOT_BYTES);

  const url = new URL('https://x.example/shipping_quote');
  const request = new Request(url, { method: 'POST', body: oversized });
  const record = await buildTelemetryRecord(request, url, META);

  assert.equal(record.inbound_payload, null);
  assert.equal(record.target_sku, null, 'sku hidden inside an oversized body is not extracted');
  assert.equal(record.method, 'POST');
  assert.equal(record.status, 200, 'rest of the record still ships');
});

it('a body at exactly the cap is still parsed', async () => {
  // Construct JSON whose byte length is exactly MAX_BODY_SNAPSHOT_BYTES.
  const skeleton = JSON.stringify({ sku: 'EDGE-1', pad: '' });
  const padLen = MAX_BODY_SNAPSHOT_BYTES - skeleton.length;
  const body = JSON.stringify({ sku: 'EDGE-1', pad: 'y'.repeat(padLen) });
  assert.equal(body.length, MAX_BODY_SNAPSHOT_BYTES);

  const url = new URL('https://x.example/shipping_quote');
  const request = new Request(url, { method: 'POST', body });
  const record = await buildTelemetryRecord(request, url, META);
  assert.equal(record.target_sku, 'EDGE-1');
  assert.ok(record.inbound_payload !== null);
});

it('an already-consumed body degrades to a partial record without throwing', async () => {
  const url = new URL('https://x.example/shipping_quote');
  const request = new Request(url, { method: 'POST', body: JSON.stringify({ sku: 'GONE' }) });
  await request.text(); // drain the body before telemetry gets to it
  const record = await buildTelemetryRecord(request, url, META);
  assert.equal(record.inbound_payload, null);
  assert.equal(record.method, 'POST');
});

it('a null cloned request still yields a record built from meta alone', async () => {
  const record = await buildTelemetryRecord(
    null,
    'https://x.example/availability?sku=NO-CLONE',
    { ...META, method: 'POST' },
  );
  assert.equal(record.method, 'POST', 'method falls back to meta when clone is null');
  assert.equal(record.path, '/availability');
  assert.equal(record.target_sku, 'NO-CLONE');
  assert.equal(record.inbound_payload, null);
  assert.equal(record.shop_domain, 'redthreadapparel.com');
});

it('garbage url and meta inputs still produce a well-shaped record', async () => {
  const record = await buildTelemetryRecord(null, 'not a url at all', undefined);
  assert.equal(record.token, 'headless_anonymous');
  assert.equal(record.protocol, 'UNKNOWN_PROTOCOL');
  assert.equal(record.method, 'UNKNOWN');
  assert.equal(record.path, null);
  assert.equal(record.query, '');
  assert.equal(record.target_sku, null);
  assert.equal(record.shop_domain, null);
  assert.equal(record.inbound_payload, null);
  assert.equal(record.status, null);
  assert.equal(record.latency_ms, null);
  assert.ok(!Number.isNaN(Date.parse(record.observed_at)));
});

it('non-integer status and non-finite latency are nulled rather than shipped dirty', async () => {
  const record = await buildTelemetryRecord(null, 'https://x.example/availability', {
    status: 'two hundred',
    latencyMs: Number.NaN,
  });
  assert.equal(record.status, null);
  assert.equal(record.latency_ms, null);
});

it('a JSON array body is preserved as the payload (and yields no sku)', async () => {
  const url = new URL('https://x.example/shipping_quote');
  const request = new Request(url, { method: 'POST', body: JSON.stringify([1, 2, 3]) });
  const record = await buildTelemetryRecord(request, url, META);
  assert.deepEqual(record.inbound_payload, [1, 2, 3]);
  assert.equal(record.target_sku, null);
});

// ---------------------------------------------------------------------------
// Compliance: PII redaction + data residency (redact.js integration)
// ---------------------------------------------------------------------------

it('extractAgentSignature reads X-User-Geo (uppercased) and falls back to request.cf.country', () => {
  const withHeader = new Request('https://x.example/shipping_quote', {
    headers: { 'X-User-Geo': 'de' },
  });
  assert.equal(extractAgentSignature(withHeader).geo, 'DE');

  // Cloudflare populates request.cf; plain undici Requests have no .cf, so we
  // simulate it with a minimal object exposing the same surface.
  const cfOnly = {
    headers: { get: () => null },
    cf: { country: 'us' },
  };
  assert.equal(extractAgentSignature(cfOnly).geo, 'US');
});

it('buildTelemetryRecord strips consumer PII from the payload, keeping zip/state/country', async () => {
  const body = JSON.stringify({
    items: [{ sku: 'SKU-PII-1', quantity: 1 }],
    shipping_address: {
      name: 'John Doe',
      email: 'john.doe@example.com',
      phone: '+1 (415) 555-0134',
      address1: '123 Main St',
      city: 'San Francisco',
      province: 'CA',
      zip: '94107',
      country: 'US',
    },
    notes: 'Ring bell at 123 Main St or email john.doe@example.com',
  });
  const request = new Request('https://x.example/shipping_quote', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });

  const record = await buildTelemetryRecord(request, request.url, {
    token: 'tok_pii',
    protocol: 'ACP',
    userGeo: 'US',
  });

  const addr = record.inbound_payload.shipping_address;
  // PII fields replaced with the sentinel...
  assert.equal(addr.name, '[REDACTED]');
  assert.equal(addr.email, '[REDACTED]');
  assert.equal(addr.phone, '[REDACTED]');
  assert.equal(addr.address1, '[REDACTED]');
  assert.equal(addr.city, '[REDACTED]');
  // ...coarse geo allowlist preserved verbatim...
  assert.equal(addr.province, 'CA');
  assert.equal(addr.zip, '94107');
  assert.equal(addr.country, 'US');
  // ...and free-text is value-scrubbed too (unanticipated keys).
  assert.ok(record.inbound_payload.notes.includes('[REDACTED_ADDRESS]'));
  assert.ok(record.inbound_payload.notes.includes('[REDACTED_EMAIL]'));
  assert.ok(!JSON.stringify(record.inbound_payload).includes('John Doe'));
  assert.ok(!JSON.stringify(record.inbound_payload).includes('john.doe@example.com'));

  // SKU extraction ran before redaction and still works.
  assert.equal(record.target_sku, 'SKU-PII-1');
  // Audit counter recorded on the record.
  assert.ok(record.pii_redactions >= 5, `expected >=5 redactions, got ${record.pii_redactions}`);
  // Residency fields present.
  assert.equal(record.user_geo, 'US');
  assert.equal(record.data_region, 'row');
});

it('buildTelemetryRecord flags EU traffic for EU data residency', async () => {
  const record = await buildTelemetryRecord(null, 'https://x.example/availability?sku=EU-1', {
    token: 'tok_eu',
    protocol: 'AP2',
    userGeo: 'FR',
  });
  assert.equal(record.user_geo, 'FR');
  assert.equal(record.data_region, 'eu');

  const unknown = await buildTelemetryRecord(null, 'https://x.example/availability', {});
  assert.equal(unknown.user_geo, null);
  assert.equal(unknown.data_region, null);
});
