/**
 * test/validate-telemetry.test.mjs — unit tests for src/lib/validate-telemetry.js.
 *
 * Role in the AOP data flow: pins the shape gate between the edge queue
 * consumer's POSTed records and the agent_intent_logs batch INSERT —
 * including the repair-vs-reject policy and the `_edge` transport-facts
 * enrichment the loss classifier depends on.
 *
 * PURE-module suite: imports nothing but node:test, node:assert and the
 * module under test — must pass BEFORE `npm install` (no express/pg).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTelemetryRecord, ALLOWED_METHODS } from '../src/lib/validate-telemetry.js';

/** A fully-populated, healthy wire record as the edge worker emits it. */
function wireRecord(overrides = {}) {
  return {
    token: 'tok_9f8e7d6c',
    protocol: 'STRIPE_ACP',
    method: 'POST',
    path: '/availability',
    query: '?sku=SKU-RED-42',
    target_sku: 'SKU-RED-42',
    shop_domain: 'red-thread-apparel.myshopify.com',
    inbound_payload: { sku: 'SKU-RED-42', quantity: 1 },
    status: 200,
    latency_ms: 84.6,
    observed_at: '2026-07-17T12:00:00.000Z',
    ...overrides,
  };
}

/* -------------------------------- happy path ------------------------------- */

test('normalizes a healthy record into insert-ready shape', () => {
  const verdict = validateTelemetryRecord(wireRecord());
  assert.equal(verdict.ok, true);
  const value = verdict.value;
  assert.equal(value.token, 'tok_9f8e7d6c');
  assert.equal(value.protocol, 'STRIPE_ACP');
  assert.equal(value.method, 'POST');
  assert.equal(value.path, '/availability');
  assert.equal(value.targetSku, 'SKU-RED-42');
  assert.equal(value.shopDomain, 'red-thread-apparel.myshopify.com');
  // Original agent fields preserved...
  assert.equal(value.payload.sku, 'SKU-RED-42');
  assert.equal(value.payload.quantity, 1);
  // ...and transport facts folded under _edge (latency rounded to integer ms).
  assert.deepEqual(value.payload._edge, {
    status: 200,
    latency_ms: 85,
    query: '?sku=SKU-RED-42',
    observed_at: '2026-07-17T12:00:00.000Z',
  });
});

test('every allowed method passes; casing is normalized', () => {
  for (const method of ALLOWED_METHODS) {
    const verdict = validateTelemetryRecord(wireRecord({ method: method.toLowerCase() }));
    assert.equal(verdict.ok, true, method);
    assert.equal(verdict.value.method, method);
  }
});

/* ------------------------------ repair policy ------------------------------ */

test('missing token degrades to the anonymous sentinel (matches edge fallback)', () => {
  for (const token of [undefined, null, '', '   ']) {
    const verdict = validateTelemetryRecord(wireRecord({ token }));
    assert.equal(verdict.ok, true);
    assert.equal(verdict.value.token, 'headless_anonymous');
  }
});

test('missing protocol degrades to UNKNOWN_PROTOCOL; long protocol truncates to 50', () => {
  assert.equal(validateTelemetryRecord(wireRecord({ protocol: undefined })).value.protocol, 'UNKNOWN_PROTOCOL');
  const long = validateTelemetryRecord(wireRecord({ protocol: 'X'.repeat(80) }));
  assert.equal(long.ok, true);
  assert.equal(long.value.protocol.length, 50);
});

test('missing/blank target_sku degrades to UNSPECIFIED; numeric SKUs stringify', () => {
  assert.equal(validateTelemetryRecord(wireRecord({ target_sku: undefined })).value.targetSku, 'UNSPECIFIED');
  assert.equal(validateTelemetryRecord(wireRecord({ target_sku: '  ' })).value.targetSku, 'UNSPECIFIED');
  assert.equal(validateTelemetryRecord(wireRecord({ target_sku: 4815162342 })).value.targetSku, '4815162342');
});

test('bare path is normalized to a leading slash; overlong path truncates to 255', () => {
  assert.equal(validateTelemetryRecord(wireRecord({ path: 'availability' })).value.path, '/availability');
  const long = validateTelemetryRecord(wireRecord({ path: '/' + 'a'.repeat(400) }));
  assert.equal(long.ok, true);
  assert.equal(long.value.path.length, 255);
});

/* ------------------------------ reject policy ------------------------------ */

test('rejects non-object records', () => {
  for (const record of [undefined, null, 'string', 42, [], true]) {
    const verdict = validateTelemetryRecord(record);
    assert.equal(verdict.ok, false, String(record));
    assert.equal(typeof verdict.error, 'string');
  }
});

test('rejects methods outside the DB CHECK set (including the edge\'s UNKNOWN)', () => {
  for (const method of ['UNKNOWN', 'TRACE', 'CONNECT', '', undefined, 'G E T']) {
    const verdict = validateTelemetryRecord(wireRecord({ method }));
    assert.equal(verdict.ok, false, String(method));
  }
});

test('rejects a missing path (endpoint_path is NOT NULL)', () => {
  for (const path of [undefined, null, '', '   ']) {
    assert.equal(validateTelemetryRecord(wireRecord({ path })).ok, false);
  }
});

test('rejects an oversized token instead of truncating (attribution safety)', () => {
  const verdict = validateTelemetryRecord(wireRecord({ token: 't'.repeat(256) }));
  assert.equal(verdict.ok, false);
  // Exactly at the limit is fine.
  assert.equal(validateTelemetryRecord(wireRecord({ token: 't'.repeat(255) })).ok, true);
});

test('rejects a missing or oversized shop_domain (tenant resolution key)', () => {
  for (const shop_domain of [undefined, null, '', '   ', 'd'.repeat(256)]) {
    assert.equal(validateTelemetryRecord(wireRecord({ shop_domain })).ok, false);
  }
});

/* ------------------------------ payload rules ------------------------------ */

test('null payload with transport facts still yields an _edge-only payload', () => {
  const verdict = validateTelemetryRecord(wireRecord({ inbound_payload: null }));
  assert.equal(verdict.ok, true);
  assert.equal(verdict.value.payload._edge.status, 200);
  assert.equal(Object.keys(verdict.value.payload).length, 1); // nothing but _edge
});

test('no payload and no usable transport facts stores NULL', () => {
  const verdict = validateTelemetryRecord(
    wireRecord({ inbound_payload: null, status: null, latency_ms: null, query: '', observed_at: null })
  );
  assert.equal(verdict.ok, true);
  assert.equal(verdict.value.payload, null);
});

test('non-object JSON bodies are wrapped under agent_body', () => {
  const verdict = validateTelemetryRecord(wireRecord({ inbound_payload: [1, 2, 3] }));
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.value.payload.agent_body, [1, 2, 3]);
  assert.equal(verdict.value.payload._edge.status, 200);
});

test('a hostile _edge field in the agent payload cannot mask transport truth', () => {
  const verdict = validateTelemetryRecord(
    wireRecord({ status: 500, inbound_payload: { _edge: { status: 200 }, sku: 'X' } })
  );
  assert.equal(verdict.ok, true);
  assert.equal(verdict.value.payload._edge.status, 500); // ours wins
});

test('bogus status / latency values are dropped, not stored', () => {
  const verdict = validateTelemetryRecord(
    wireRecord({ status: 'teapot', latency_ms: -5, query: null, observed_at: 42 })
  );
  assert.equal(verdict.ok, true);
  assert.equal(verdict.value.payload._edge, undefined); // no valid facts -> no _edge
  assert.equal(verdict.value.payload.sku, 'SKU-RED-42'); // agent payload intact
});

test('oversized payloads are dropped but the record (and _edge) survives', () => {
  const verdict = validateTelemetryRecord(
    wireRecord({ inbound_payload: { blob: 'x'.repeat(70 * 1024) } })
  );
  assert.equal(verdict.ok, true);
  assert.equal(verdict.value.payload.blob, undefined);
  assert.equal(verdict.value.payload.payload_dropped, 'oversize');
  assert.equal(verdict.value.payload._edge.status, 200);
});

test('never throws on hostile records (throwing getters)', () => {
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error('trap');
      },
    }
  );
  const verdict = validateTelemetryRecord(hostile);
  assert.equal(verdict.ok, false);
});

// ---------------------------------------------------------------------------
// Compliance fields: user_geo / data_region / pii_redactions -> _edge meta
// ---------------------------------------------------------------------------

test('persists edge compliance fields (user_geo, data_region, pii_redactions) into _edge meta', () => {
  const result = validateTelemetryRecord({
    token: 'tok_geo',
    method: 'POST',
    path: '/shipping_quote',
    shop_domain: 'shop.example.com',
    inbound_payload: { destination: { zip: '94107', country: 'US' } },
    status: 200,
    user_geo: 'fr',
    data_region: 'eu',
    pii_redactions: 4,
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.payload._edge.user_geo, 'FR', 'geo uppercased');
  assert.equal(result.value.payload._edge.data_region, 'eu');
  assert.equal(result.value.payload._edge.pii_redactions, 4);
});

test('ignores malformed compliance fields without rejecting the record', () => {
  const result = validateTelemetryRecord({
    token: 'tok_badgeo',
    method: 'GET',
    path: '/availability',
    shop_domain: 'shop.example.com',
    status: 200,
    user_geo: 'FRANCE',        // not a 2-letter code
    data_region: 'mars',       // not a known region
    pii_redactions: 'many',    // not an integer
  });
  assert.equal(result.ok, true, 'compliance fields are best-effort, never fatal');
  assert.equal(result.value.payload._edge.user_geo, undefined);
  assert.equal(result.value.payload._edge.data_region, undefined);
  assert.equal(result.value.payload._edge.pii_redactions, undefined);
  assert.equal(result.value.payload._edge.status, 200, 'other meta still captured');
});

test('records the edge redactor fail-safe sentinel (-1) but rejects nonsense counters', () => {
  const failSafe = validateTelemetryRecord({
    token: 'tok_rf',
    method: 'POST',
    path: '/shipping_quote',
    shop_domain: 'shop.example.com',
    pii_redactions: -1,
  });
  assert.equal(failSafe.ok, true);
  assert.equal(failSafe.value.payload._edge.pii_redactions, -1);

  const nonsense = validateTelemetryRecord({
    token: 'tok_rf2',
    method: 'POST',
    path: '/shipping_quote',
    shop_domain: 'shop.example.com',
    pii_redactions: -7,
  });
  assert.equal(nonsense.ok, true);
  assert.equal(nonsense.value.payload?._edge?.pii_redactions, undefined);
});
