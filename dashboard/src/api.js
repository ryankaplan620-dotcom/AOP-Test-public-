/**
 * api.js — fetch layer between the dashboard SPA and the two AOP backends.
 *
 * Role in the AOP data flow:
 *   [ingestion /analytics/*]  --> Loss Diagnosis screen data
 *   [optimizer /score,/rewrite] --> Data Optimizer panel results
 *
 * Connection settings (base URLs + the dashboard bearer token) live in
 * localStorage so the static SPA build is deployment-agnostic; the Settings
 * tab writes them. Defaults match the local-development walkthrough ports.
 *
 * Every call goes through request(): bounded by an AbortSignal timeout,
 * JSON-only, and errors normalized to Error objects with a user-renderable
 * message — components never see a raw fetch failure shape.
 */

const STORAGE_KEY = 'aop-dashboard-settings';

export const DEFAULT_SETTINGS = {
  analyticsUrl: 'http://localhost:8787',
  dashboardToken: '',
  optimizerUrl: 'http://localhost:8899',
};

/** Read persisted settings, merged over defaults; never throws. */
export function loadSettings() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Persist settings; never throws (private-mode storage failures are moot). */
export function saveSettings(settings) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable — session-only settings still work in memory */
  }
}

/** Strip trailing slashes so URL joins stay predictable. */
function baseOf(url) {
  return String(url ?? '').replace(/\/+$/, '');
}

/**
 * One bounded JSON request. 10s timeout: an analytics dashboard poll that
 * hangs must fail fast and retry on the next poll tick, not pile up.
 */
async function request(url, { method = 'GET', token = null, body = null } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== null) headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new Error(
      err?.name === 'TimeoutError' ? 'Request timed out' : `Cannot reach ${new URL(url).origin}`,
    );
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    /* non-JSON body — fall through; the checks below decide */
  }
  if (!response.ok) {
    throw new Error(payload?.error ?? `HTTP ${response.status}`);
  }
  // A 2xx with a non-JSON or non-object body (proxy splash page, empty 200)
  // must be an ERROR, not a silently-resolved null/string — callers would
  // either spin on 'Loading…' forever or crash rendering it. This honors
  // the module contract: every failure becomes a renderable Error.
  if (payload === null || typeof payload !== 'object') {
    throw new Error('Malformed response from server (expected JSON object)');
  }
  return payload;
}

// ---- Loss Diagnosis (ingestion /analytics) --------------------------------

export function fetchSummary(settings, days) {
  return request(`${baseOf(settings.analyticsUrl)}/analytics/summary?days=${days}`, {
    token: settings.dashboardToken,
  });
}

export function fetchLossReasons(settings, days) {
  return request(`${baseOf(settings.analyticsUrl)}/analytics/loss-reasons?days=${days}`, {
    token: settings.dashboardToken,
  });
}

export function fetchTraffic(settings, days) {
  return request(`${baseOf(settings.analyticsUrl)}/analytics/traffic?days=${days}`, {
    token: settings.dashboardToken,
  });
}

export function fetchBenchmark(settings, days) {
  return request(`${baseOf(settings.analyticsUrl)}/analytics/benchmark?days=${days}`, {
    token: settings.dashboardToken,
  });
}

export function fetchBilling(settings, month) {
  return request(`${baseOf(settings.analyticsUrl)}/analytics/billing?month=${month}`, {
    token: settings.dashboardToken,
  });
}

export function fetchActivity(settings, limit) {
  return request(`${baseOf(settings.analyticsUrl)}/analytics/activity?limit=${limit}`, {
    token: settings.dashboardToken,
  });
}

// ---- Data Optimizer (optimizer microservice) ------------------------------

/** Full rewrite pass: score + directives + the JSON-LD artifact. */
export function rewritePolicy(settings, policyText) {
  return request(`${baseOf(settings.optimizerUrl)}/rewrite`, {
    method: 'POST',
    body: { policy_text: policyText },
  });
}

/** Structured Claim Injector: audit a product record + inject JSON-LD. */
export function auditClaims(settings, product) {
  return request(`${baseOf(settings.optimizerUrl)}/claims`, {
    method: 'POST',
    body: { product },
  });
}

/** What-if pass: baseline + counterfactual scenarios with score/prob deltas. */
export function simulatePolicy(settings, policyText) {
  return request(`${baseOf(settings.optimizerUrl)}/simulate`, {
    method: 'POST',
    body: { policy_text: policyText },
  });
}
