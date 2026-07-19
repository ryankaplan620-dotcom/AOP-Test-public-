/**
 * lib/rate-limit.js — per-client request throttle for the ingestion service.
 *
 * Role in the AOP data flow:
 *   Mounted app-wide in src/app.js (before every route except /healthz).
 *   Every inbound surface is authenticated (bearer / HMAC / signed state),
 *   so the limiter's job is not access control — it bounds how much CPU an
 *   unauthenticated flood can burn on signature checks and how hard a
 *   misbehaving authenticated producer can hammer PostgreSQL.
 *
 * Fixed-window counter per client IP, in memory. Deliberately simple:
 *   - Fixed window (not sliding/token bucket): the worst-case burst is
 *     2x the limit across a window boundary, which is fine for an abuse
 *     bound (this is not a fairness scheduler).
 *   - In-memory (not Redis): the bound is per-replica; N replicas allow N x
 *     the limit, which still caps the blast radius. Cross-replica precision
 *     is not worth an infrastructure dependency at this stage.
 *
 * Memory bound: entries are pruned lazily on touch and hard-capped; past the
 * cap, oldest entries are evicted (Map preserves insertion order) — a spoofed-
 * IP flood degrades limiter precision, never process memory.
 *
 * PURE module: no express import (the middleware is (req,res,next)-shaped by
 * convention), no timers — unit-testable pre-`npm install`.
 */

/** Hard cap on tracked client entries (see memory bound above). */
export const MAX_TRACKED_CLIENTS = 10_000;

/** Window length. One minute matches the config knob's unit. */
export const WINDOW_MS = 60_000;

/**
 * Build the middleware.
 *
 * @param {{limitPerMinute: number, now?: () => number}} options
 *   limitPerMinute <= 0 disables the limiter (a pass-through middleware is
 *   returned so app.js never needs a conditional mount).
 *   now is injectable for tests; defaults to Date.now.
 * @returns {(req, res, next) => void}
 */
export function buildRateLimiter({ limitPerMinute, now = Date.now }) {
  if (!Number.isFinite(limitPerMinute) || limitPerMinute <= 0) {
    return (_req, _res, next) => next();
  }

  /** ip -> {count, windowStart} */
  const clients = new Map();

  return (req, res, next) => {
    try {
      const ip = typeof req.ip === 'string' && req.ip !== '' ? req.ip : 'unknown';
      const ts = now();

      let entry = clients.get(ip);
      if (!entry || ts - entry.windowStart >= WINDOW_MS) {
        entry = { count: 0, windowStart: ts };
        // Delete-then-set keeps recency in Map order so eviction below drops
        // the stalest window first.
        clients.delete(ip);
        clients.set(ip, entry);
      }

      entry.count += 1;
      if (entry.count > limitPerMinute) {
        // Standard header so well-behaved callers back off without parsing
        // the body. Whole windows only — precision is not the point.
        res.set('Retry-After', String(Math.ceil((entry.windowStart + WINDOW_MS - ts) / 1000)));
        res.status(429).json({ error: 'rate limit exceeded' });
        return;
      }

      if (clients.size > MAX_TRACKED_CLIENTS) {
        const oldest = clients.keys().next().value;
        if (oldest !== undefined) clients.delete(oldest);
      }

      next();
    } catch {
      // The limiter must never take down a legitimate request path.
      next();
    }
  };
}
