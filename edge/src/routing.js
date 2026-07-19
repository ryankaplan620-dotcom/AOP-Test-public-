/**
 * routing.js — hostname -> merchant-origin resolution for the AOP edge proxy.
 *
 * Role in the AOP data flow:
 *   [AI Agent] hits a merchant's AOP proxy hostname (e.g.
 *   agents.redthread.aop.network); this module decides which real headless
 *   Shopify/BigCommerce origin (e.g. https://redthreadapparel.com) the fetch()
 *   handler forwards the request to. The resolved origin's hostname is also
 *   what telemetry records as shop_domain for merchant attribution downstream.
 *
 * Config comes from two worker vars (see wrangler.toml):
 *   - env.MERCHANT_ROUTES: JSON string {proxyHostname: originBaseUrl, ...}
 *   - env.DEFAULT_ORIGIN:  fallback origin when the hostname is unmapped
 *
 * Design constraints:
 *   - resolveOrigin() sits on the synchronous hot path of every single proxied
 *     request (the <5ms overhead budget), so the JSON parse is memoized per
 *     isolate and keyed on the raw string — after the first request it costs
 *     one string compare plus one Map lookup.
 *   - Malformed config must NEVER throw into the request path: bad JSON or bad
 *     URLs degrade to "no routes" / "no default", and the fetch handler turns
 *     an unresolvable host into a controlled 502 instead of an exception.
 *   - We never return an origin whose hostname equals the incoming hostname:
 *     that would make the worker proxy to itself in an infinite loop.
 */

// Per-isolate memo caches. Keyed on the RAW env string (not just "parsed once")
// so a config change deployed via `wrangler deploy` / dashboard edit is picked
// up naturally when new isolates spin up with the new env, and so unit tests
// that swap env values between cases still resolve correctly.
let cachedRoutesRaw;
let cachedRoutes = new Map();
let cachedDefaultRaw;
let cachedDefaultOrigin = null;

/**
 * Validate + normalize an origin value to "scheme://host[:port]".
 * Only http/https make sense as proxy targets; anything else (or a value that
 * is not a parseable absolute URL) is rejected as null. Normalizing to
 * URL.origin keeps downstream path joining predictable (the proxy always
 * forwards the inbound pathname + query verbatim onto the origin).
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function normalizeOrigin(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null; // relative / garbage URL in config — skip this entry
  }
}

/**
 * Parse env.MERCHANT_ROUTES into a Map(lowercased hostname -> origin), memoized
 * on the raw string. Tolerates: missing var, non-string var, malformed JSON,
 * non-object JSON, and individual entries with invalid origins (each entry is
 * validated independently so one bad row cannot poison the whole table).
 *
 * @param {object|undefined} env
 * @returns {Map<string, string>}
 */
function getRoutes(env) {
  const raw = typeof env?.MERCHANT_ROUTES === 'string' ? env.MERCHANT_ROUTES : '';
  if (raw === cachedRoutesRaw) return cachedRoutes; // hot path: memo hit

  const routes = new Map();
  if (raw.trim() !== '') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [hostname, target] of Object.entries(parsed)) {
          const origin = normalizeOrigin(target);
          if (typeof hostname === 'string' && hostname.trim() !== '' && origin) {
            // Hostnames are case-insensitive per RFC 4343 — normalize once here
            // so the per-request lookup is a plain Map.get.
            routes.set(hostname.trim().toLowerCase(), origin);
          }
        }
      } else {
        console.warn('AOP routing: MERCHANT_ROUTES is not a JSON object; ignoring it');
      }
    } catch (err) {
      // Malformed JSON in config must not take down live traffic — log once
      // per isolate (memoized) and continue with an empty route table so
      // DEFAULT_ORIGIN can still carry requests.
      console.warn('AOP routing: malformed MERCHANT_ROUTES JSON; ignoring it:', err?.message);
    }
  }
  cachedRoutesRaw = raw;
  cachedRoutes = routes;
  return routes;
}

/**
 * Validate env.DEFAULT_ORIGIN, memoized on the raw string. Empty/unset/invalid
 * -> null (meaning: unknown hostnames get a controlled 502 from the proxy).
 *
 * @param {object|undefined} env
 * @returns {string|null}
 */
function getDefaultOrigin(env) {
  const raw = typeof env?.DEFAULT_ORIGIN === 'string' ? env.DEFAULT_ORIGIN : '';
  if (raw === cachedDefaultRaw) return cachedDefaultOrigin;
  cachedDefaultRaw = raw;
  cachedDefaultOrigin = normalizeOrigin(raw);
  if (raw.trim() !== '' && cachedDefaultOrigin === null) {
    console.warn('AOP routing: DEFAULT_ORIGIN is not a valid http(s) URL; ignoring it');
  }
  return cachedDefaultOrigin;
}

/**
 * Resolve the merchant origin base URL for an incoming proxy hostname.
 *
 * Resolution order: exact MERCHANT_ROUTES entry (case-insensitive), then
 * DEFAULT_ORIGIN, then null. A resolved origin that points back at the
 * incoming hostname itself is treated as unresolvable — the fetch handler
 * turns null into a 502 rather than proxying to itself in a loop.
 *
 * Never throws.
 *
 * @param {string} hostname incoming request hostname (from new URL(request.url))
 * @param {object} env worker environment bindings/vars
 * @returns {string|null} normalized origin like "https://redthreadapparel.com"
 */
export function resolveOrigin(hostname, env) {
  try {
    const host = typeof hostname === 'string' ? hostname.trim().toLowerCase() : '';
    const origin = getRoutes(env).get(host) ?? getDefaultOrigin(env);
    if (!origin) return null;

    // Self-loop guard: never proxy back to the hostname we are serving.
    try {
      if (host !== '' && new URL(origin).hostname.toLowerCase() === host) {
        return null;
      }
    } catch {
      return null; // origin unexpectedly unparseable — treat as unresolvable
    }
    return origin;
  } catch {
    // Absolute backstop: routing failures become "no origin" (controlled 502),
    // never an exception on the merchant's live traffic path.
    return null;
  }
}

/* --------------------------------------------------------------------------
 * Dynamic (database-backed) resolution.
 *
 * Static MERCHANT_ROUTES requires a config edit + worker redeploy for every
 * merchant — which broke the promise of one-click OAuth onboarding. When the
 * static table (and DEFAULT_ORIGIN) miss, the worker asks the ingestion
 * service, whose /routes/resolve endpoint reads merchant_profiles
 * (proxy_hostname -> origin_url, populated at install).
 *
 * Latency contract: the lookup is an HTTPS round trip, so it runs ONLY on a
 * per-isolate cache miss — the first request for a hostname on a fresh
 * isolate pays it once; every subsequent request is a synchronous Map hit
 * (positive TTL 60s, negative TTL 30s), keeping steady state inside the
 * <5ms budget. In-flight lookups are deduplicated so a burst of first
 * requests costs one round trip, not N.
 *
 * Abuse bound: internet scanners spray arbitrary Host headers. When
 * env.PROXY_HOSTNAME_SUFFIX is set, only hostnames ending in that suffix are
 * ever looked up — everything else stays a local (cached-nothing) 502.
 * -------------------------------------------------------------------------- */

/** Cache TTLs (ms). Positive entries refresh routing changes within a
 * minute; negative entries stop repeat lookups for unknown hosts without
 * masking a just-onboarded merchant for long. */
const DYNAMIC_POSITIVE_TTL_MS = 60_000;
const DYNAMIC_NEGATIVE_TTL_MS = 30_000;

/** Resolve-call timeout: a slow control-plane lookup must fail fast into the
 * controlled-502 path, never hang an agent request. */
const RESOLVE_TIMEOUT_MS = 1_500;

/** hostname -> {origin: string|null, expiresAt: number} */
let dynamicCache = new Map();
/** hostname -> Promise<string|null> for in-flight dedup. */
let dynamicInFlight = new Map();

/** Test hook: reset dynamic-resolution state between unit tests. */
export function clearDynamicRouteCache() {
  dynamicCache = new Map();
  dynamicInFlight = new Map();
}

/**
 * Resolve a hostname via the ingestion service's /routes/resolve endpoint.
 *
 * Never throws; resolves to a normalized origin or null. null results are
 * ALSO cached (negative TTL) — the fetch handler turns them into the same
 * controlled 502 as before.
 *
 * @param {string} hostname incoming request hostname.
 * @param {object} env worker vars (INGEST_API_URL, INGEST_API_TOKEN,
 *   PROXY_HOSTNAME_SUFFIX optional).
 * @returns {Promise<string|null>}
 */
export async function resolveOriginDynamic(hostname, env) {
  try {
    const host = typeof hostname === 'string' ? hostname.trim().toLowerCase() : '';
    if (host === '') return null;

    // Suffix gate: bound lookups to our own proxy namespace when configured.
    const suffix =
      typeof env?.PROXY_HOSTNAME_SUFFIX === 'string' ? env.PROXY_HOSTNAME_SUFFIX.trim().toLowerCase() : '';
    if (suffix !== '' && !host.endsWith(suffix)) return null;

    const base = typeof env?.INGEST_API_URL === 'string' ? env.INGEST_API_URL.trim().replace(/\/+$/, '') : '';
    if (base === '') return null; // dynamic routing unconfigured — static only

    const cached = dynamicCache.get(host);
    if (cached && cached.expiresAt > Date.now()) return cached.origin;

    const inFlight = dynamicInFlight.get(host);
    if (inFlight) return inFlight;

    const lookup = (async () => {
      let origin = null;
      try {
        const headers = { accept: 'application/json' };
        const token = env?.INGEST_API_TOKEN;
        if (typeof token === 'string' && token !== '') headers.authorization = `Bearer ${token}`;

        const response = await fetch(`${base}/routes/resolve?hostname=${encodeURIComponent(host)}`, {
          headers,
          signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(RESOLVE_TIMEOUT_MS) : undefined,
        });
        if (response.ok) {
          const payload = await response.json().catch(() => null);
          origin = normalizeOrigin(payload?.origin);
          // Same self-loop guard as the static path.
          if (origin !== null && new URL(origin).hostname.toLowerCase() === host) origin = null;
        }
        // Non-2xx (404 unknown host, 401 misconfig, 5xx outage) -> null; the
        // negative TTL below keeps outages from hammering the control plane.
      } catch {
        origin = null; // network/timeout — controlled 502 downstream
      }
      dynamicCache.set(host, {
        origin,
        expiresAt: Date.now() + (origin !== null ? DYNAMIC_POSITIVE_TTL_MS : DYNAMIC_NEGATIVE_TTL_MS),
      });
      return origin;
    })();

    dynamicInFlight.set(host, lookup);
    try {
      return await lookup;
    } finally {
      dynamicInFlight.delete(host);
    }
  } catch {
    return null; // absolute backstop, same contract as resolveOrigin()
  }
}
