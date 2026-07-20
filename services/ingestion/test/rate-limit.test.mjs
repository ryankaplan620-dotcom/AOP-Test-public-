/**
 * Tests for src/lib/rate-limit.js — the per-IP fixed-window abuse bound.
 *
 * PURE module: no express needed — the middleware is exercised with hand-
 * rolled req/res/next fakes, and time is injected so windows advance
 * deterministically.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRateLimiter, MAX_TRACKED_CLIENTS, WINDOW_MS } from '../src/lib/rate-limit.js';

/** Minimal req/res pair capturing what the limiter does. */
function drive(middleware, { ip = '10.0.0.1' } = {}) {
  const out = { statusCode: null, body: null, headers: {}, nexted: false };
  const req = { ip };
  const res = {
    set(name, value) {
      out.headers[name] = value;
      return res;
    },
    status(code) {
      out.statusCode = code;
      return res;
    },
    json(payload) {
      out.body = payload;
      return res;
    },
  };
  middleware(req, res, () => {
    out.nexted = true;
  });
  return out;
}

test('requests under the limit pass through', () => {
  let ts = 1_000_000;
  const limiter = buildRateLimiter({ limitPerMinute: 3, now: () => ts });
  for (let i = 0; i < 3; i++) {
    const out = drive(limiter);
    assert.equal(out.nexted, true, `request ${i + 1} should pass`);
    assert.equal(out.statusCode, null);
  }
});

test('request over the limit gets 429 with Retry-After', () => {
  let ts = 1_000_000;
  const limiter = buildRateLimiter({ limitPerMinute: 2, now: () => ts });
  drive(limiter);
  drive(limiter);
  const out = drive(limiter);
  assert.equal(out.nexted, false);
  assert.equal(out.statusCode, 429);
  assert.equal(out.body.error, 'rate limit exceeded');
  const retryAfter = Number(out.headers['Retry-After']);
  assert.ok(retryAfter >= 1 && retryAfter <= 60, `Retry-After ${retryAfter} in (0, 60]`);
});

test('window expiry resets the counter', () => {
  let ts = 1_000_000;
  const limiter = buildRateLimiter({ limitPerMinute: 1, now: () => ts });
  assert.equal(drive(limiter).nexted, true);
  assert.equal(drive(limiter).statusCode, 429);
  ts += WINDOW_MS; // next window
  assert.equal(drive(limiter).nexted, true);
});

test('limits are per client IP', () => {
  let ts = 1_000_000;
  const limiter = buildRateLimiter({ limitPerMinute: 1, now: () => ts });
  assert.equal(drive(limiter, { ip: '10.0.0.1' }).nexted, true);
  assert.equal(drive(limiter, { ip: '10.0.0.1' }).statusCode, 429);
  // A different client is not affected by the first one's exhaustion.
  assert.equal(drive(limiter, { ip: '10.0.0.2' }).nexted, true);
});

test('missing req.ip buckets under a shared unknown key instead of throwing', () => {
  let ts = 1_000_000;
  const limiter = buildRateLimiter({ limitPerMinute: 1, now: () => ts });
  assert.equal(drive(limiter, { ip: undefined }).nexted, true);
  assert.equal(drive(limiter, { ip: undefined }).statusCode, 429);
});

test('limitPerMinute <= 0 disables the limiter entirely', () => {
  for (const limit of [0, -5, NaN, undefined]) {
    const limiter = buildRateLimiter({ limitPerMinute: limit });
    for (let i = 0; i < 50; i++) {
      assert.equal(drive(limiter).nexted, true);
    }
  }
});

test('tracked-client map is hard-capped (spoofed-IP flood cannot grow memory unboundedly)', () => {
  let ts = 1_000_000;
  const limiter = buildRateLimiter({ limitPerMinute: 10, now: () => ts });
  // One more unique IP than the cap; the limiter must keep serving (eviction,
  // not failure) and every request still passes.
  for (let i = 0; i <= MAX_TRACKED_CLIENTS; i++) {
    const out = drive(limiter, { ip: `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}` });
    assert.equal(out.nexted, true);
  }
});

test('a hostile res object cannot crash the request path', () => {
  const limiter = buildRateLimiter({ limitPerMinute: 1, now: () => 1 });
  const hostileRes = {
    set() {
      throw new Error('boom');
    },
    status() {
      throw new Error('boom');
    },
    json() {
      throw new Error('boom');
    },
  };
  let nexted = false;
  limiter({ ip: 'x' }, hostileRes, () => {
    nexted = true;
  });
  // First request passes normally.
  assert.equal(nexted, true);
  // Second would 429 — the hostile res throws, the limiter falls through to
  // next() rather than taking down the route.
  nexted = false;
  limiter({ ip: 'x' }, hostileRes, () => {
    nexted = true;
  });
  assert.equal(nexted, true);
});
