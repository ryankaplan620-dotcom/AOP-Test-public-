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
