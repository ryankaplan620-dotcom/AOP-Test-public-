/**
 * lib/analytics-params.js — pure parsing/clamping of /analytics query params.
 *
 * Role in the AOP data flow:
 *   [dashboard SPA] --GET /analytics/*?days=&limit=--> routes/analytics.js
 *     --(THIS module normalizes the window/limit)--> repositories queries.
 *
 * Dashboard inputs are attacker-reachable query strings; every value is
 * parsed defensively and CLAMPED (not rejected) to safe bounds — a hostile
 * ?days=999999 becomes the max window, never an unbounded table scan.
 *
 * PURE module: no express/pg imports — unit-tested pre-`npm install`.
 */

/** Analytics window bounds (days). 7 is the dashboard's default view. */
export const DEFAULT_WINDOW_DAYS = 7;
export const MAX_WINDOW_DAYS = 90; // matches the telemetry retention cap

/** Activity/loss-log page bounds. */
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;

/**
 * Parse an integer-ish query value and clamp it into [min, max].
 * Non-numeric / missing input yields the default — analytics reads should
 * degrade to sane defaults, never 400 on a mangled query string.
 *
 * @param {unknown} raw query-string value (string | string[] | undefined)
 * @param {{def: number, min: number, max: number}} bounds
 * @returns {number}
 */
export function clampInt(raw, { def, min, max }) {
  // express may hand back an array for repeated params (?days=1&days=2);
  // take the first occurrence, matching typical framework behavior.
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  const parsed = Number.parseInt(String(candidate ?? ''), 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) return def;
  return Math.min(max, Math.max(min, parsed));
}

/** Window-days param: ?days=N -> [1, 90], default 7. */
export function parseWindowDays(raw) {
  return clampInt(raw, { def: DEFAULT_WINDOW_DAYS, min: 1, max: MAX_WINDOW_DAYS });
}

/** Row-limit param: ?limit=N -> [1, 500], default 50. */
export function parseLimit(raw) {
  return clampInt(raw, { def: DEFAULT_LIMIT, min: 1, max: MAX_LIMIT });
}

/**
 * Percentage share with money-safe rounding to one decimal; 0 when the
 * denominator is 0 (an empty window must render as 0%, not NaN%).
 */
export function percentShare(part, total) {
  const p = Number(part);
  const t = Number(total);
  if (!Number.isFinite(p) || !Number.isFinite(t) || t <= 0) return 0;
  return Math.round((p / t) * 1000) / 10;
}
