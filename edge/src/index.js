/**
 * index.js — the AOP zero-latency Cloudflare Worker edge proxy (entrypoint).
 *
 * Role in the AOP data flow:
 *   [AI Agent] -> fetch() below -> (sync passthrough) -> [Shopify/BigCommerce origin]
 *                     |
 *                     +--> ctx.waitUntil: telemetry record -> env.EDGE_LOG_QUEUE
 *                                                                 |
 *   queue() below <-- Cloudflare Queues batch delivery <-----------+
 *        |
 *        +--> HTTPS POST /ingest/telemetry -> [Node.js ingestion service] -> [PostgreSQL]
 *
 * Two handlers live in the default export:
 *   - fetch(request, env, ctx): the live proxy. The design driver is a <5ms
 *     added-latency budget, so the ONLY synchronous work before dispatching to
 *     the origin is: URL parse, header reads, origin resolution, and
 *     request.clone(). Body capture, record building, and the queue send are
 *     all deferred into ctx.waitUntil() and can never block or fail the
 *     merchant's response.
 *   - queue(batch, env): the telemetry drain. Batches from the
 *     "aop-edge-telemetry" queue are POSTed to the ingestion service; failures
 *     are retried by Queues (and eventually parked in the DLQ) so no record is
 *     silently lost to a transient ingest outage.
 *
 * PRIME DIRECTIVE: telemetry/analytics failures must NEVER affect live merchant
 * traffic. Every telemetry code path is double-wrapped (sync + async) and the
 * whole fetch handler has a final backstop that returns a well-formed error
 * response instead of ever throwing to the runtime.
 */

import { extractAgentSignature, buildTelemetryRecord } from './telemetry.js';
import { resolveOrigin, resolveOriginDynamic } from './routing.js';

/**
 * Intent endpoints we intercept for telemetry. Matched as the FINAL path
 * segment so both bare paths (/availability) and app-proxied paths
 * (/apps/acp/availability) produce telemetry. All other paths are proxied
 * transparently with zero telemetry work.
 */
const INTENT_SEGMENTS = new Set(['availability', 'shipping_quote']);

/** Methods that must not carry a request body per the fetch spec. */
const BODYLESS_METHODS = new Set(['GET', 'HEAD']);

/** Consumer-side timeout for the ingest POST; a hung ingest service must not
 * pin queue consumer invocations open indefinitely. */
const INGEST_POST_TIMEOUT_MS = 10_000;

/**
 * True when the pathname is an intent endpoint: exactly '/availability' or
 * '/shipping_quote', or either name as the final path segment.
 * Pure string work — safe on the synchronous hot path.
 */
function isInterceptedPath(pathname) {
  if (typeof pathname !== 'string' || pathname === '') return false;
  const segments = pathname.split('/').filter((s) => s !== '');
  if (segments.length === 0) return false;
  return INTENT_SEGMENTS.has(segments[segments.length - 1]);
}

/**
 * Well-formed JSON error response for proxy-level failures (unresolvable host,
 * unreachable origin). Agents get machine-readable structure instead of an
 * opaque connection error, which also feeds cleaner loss_diagnostics.
 */
function errorResponse(status, code, message, latencyMs) {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'x-aop-proxy-processed': 'true',
  });
  if (Number.isFinite(latencyMs)) {
    headers.set('x-aop-latency-ms', String(Math.max(0, Math.round(latencyMs))));
  }
  return new Response(
    JSON.stringify({ error: code, message, source: 'aop-edge-proxy' }),
    { status, headers },
  );
}

/**
 * request.clone() that can never throw into the hot path (e.g. body already
 * disturbed by an intermediary). A failed clone just means the telemetry
 * record ships without a body snapshot.
 */
function safeClone(request) {
  try {
    return request.clone();
  } catch {
    return null;
  }
}

/**
 * Defer telemetry work (bounded body read, record build, queue send) into
 * ctx.waitUntil so it runs after the response has been handed to the client.
 *
 * Double containment:
 *  - the async task catches ALL of its own errors (so the waitUntil promise
 *    always resolves and never surfaces a rejection);
 *  - the synchronous registration is itself try/caught (a broken ctx object
 *    must not break the response either).
 */
function scheduleTelemetry(ctx, env, params) {
  try {
    const task = (async () => {
      try {
        const {
          clonedRequest,
          url,
          signature,
          originBase,
          method,
          status,
          latencyMs,
        } = params;

        // shop_domain is the resolved origin's hostname — the ingestion
        // service maps it to a merchant_id. Derived here (off the hot path)
        // rather than in fetch() to keep pre-dispatch sync work minimal.
        let shopDomain = null;
        if (typeof originBase === 'string' && originBase !== '') {
          try {
            shopDomain = new URL(originBase).hostname;
          } catch {
            shopDomain = null;
          }
        }

        const record = await buildTelemetryRecord(clonedRequest, url, {
          token: signature?.token,
          protocol: signature?.protocol,
          method,
          shopDomain,
          status,
          latencyMs,
          // Consumer country (X-User-Geo header / Cloudflare geo-IP) for
          // data-residency routing — see redact.js dataResidencyRegion().
          userGeo: signature?.geo,
        });

        const queue = env?.EDGE_LOG_QUEUE;
        if (queue && typeof queue.send === 'function') {
          // Cloudflare Queues producer API is .send() (not .put()).
          await queue.send(record);
        } else {
          console.warn('AOP edge: EDGE_LOG_QUEUE binding missing; telemetry record dropped');
        }
      } catch (err) {
        // Telemetry is best-effort by contract: log and move on. This catch is
        // what guarantees a queue outage can never affect merchant traffic.
        console.warn('AOP edge: telemetry pipeline failure (ignored):', err?.message ?? err);
      }
    })();

    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(task);
    }
    // If ctx is unusable the task still runs detached; its internal catch
    // prevents any unhandled rejection.
  } catch {
    // Even scheduling itself must never throw into the request path.
  }
}

/**
 * Acknowledge every message in a queue batch, tolerating either the batch-level
 * ackAll() or per-message ack() API surface (and stub batches in tests).
 */
function ackBatch(batch) {
  try {
    if (typeof batch?.ackAll === 'function') {
      batch.ackAll();
      return;
    }
    for (const message of batch?.messages ?? []) {
      try {
        message?.ack?.();
      } catch {
        /* an un-ackable message will simply be redelivered — acceptable */
      }
    }
  } catch {
    /* never let ack bookkeeping crash the consumer */
  }
}

/**
 * Ask Queues to redeliver the whole batch: prefer batch.retryAll(); otherwise
 * throw so the runtime marks the invocation failed (same redelivery effect).
 * Redelivery + max_retries + the DLQ (see wrangler.toml) is what shields the
 * pipeline from poison messages.
 */
function retryBatch(batch, reason) {
  if (typeof batch?.retryAll === 'function') {
    try {
      batch.retryAll();
      return;
    } catch {
      /* fall through to throw */
    }
  }
  throw reason instanceof Error ? reason : new Error(String(reason));
}

/** AbortSignal.timeout guarded for runtimes/tests where it may be absent. */
function ingestTimeoutSignal() {
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return AbortSignal.timeout(INGEST_POST_TIMEOUT_MS);
    }
  } catch {
    /* no timeout support — proceed without */
  }
  return undefined;
}

export default {
  /**
   * Live proxy handler. See module header for the latency-budget contract.
   *
   * @param {Request} request inbound agent request
   * @param {object} env bindings/vars (EDGE_LOG_QUEUE, MERCHANT_ROUTES, ...)
   * @param {object} ctx execution context (waitUntil)
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    const startedAt = Date.now();
    try {
      // ---- Synchronous hot path: URL parse, header reads, origin resolution,
      // ---- clone. Nothing else happens before origin dispatch.
      const url = new URL(request.url);
      const signature = extractAgentSignature(request); // two header reads
      const intercepted = isInterceptedPath(url.pathname);
      let originBase = resolveOrigin(url.hostname, env); // memoized lookup

      // Clone BEFORE the origin consumes the body stream. Only intent
      // endpoints pay the clone cost; all other traffic skips it entirely.
      const telemetryClone = intercepted ? safeClone(request) : null;

      if (!originBase) {
        // Static table + DEFAULT_ORIGIN missed: fall back to the dynamic
        // (merchant_profiles-backed) resolver so OAuth-onboarded merchants
        // are routable with NO worker redeploy. This await runs only on a
        // per-isolate cache miss (see routing.js) — steady state stays on
        // the synchronous <5ms path above.
        originBase = await resolveOriginDynamic(url.hostname, env);
      }

      if (!originBase) {
        // Unknown hostname and no DEFAULT_ORIGIN (or the route would loop back
        // to this proxy itself): fail fast with a controlled 502. Still record
        // the intent attempt — "misrouted agent traffic" is itself a
        // drop-off diagnosis worth surfacing (shop_domain stays null).
        const latencyMs = Date.now() - startedAt;
        if (intercepted) {
          scheduleTelemetry(ctx, env, {
            clonedRequest: telemetryClone,
            url,
            signature,
            originBase: null,
            method: request.method,
            status: 502,
            latencyMs,
          });
        }
        return errorResponse(
          502,
          'no_origin_configured',
          `No merchant origin is configured for hostname "${url.hostname}".`,
          latencyMs,
        );
      }

      // Forward the same path + query onto the merchant origin. Build from the
      // origin base and ASSIGN pathname/search — never resolve the inbound path
      // against the base (new URL(path + search, base)): a path beginning with
      // "//" is protocol-relative there and would override the merchant host,
      // turning this worker into an open forward proxy that leaks the agent's
      // X-Agent-Transaction-Token to an attacker-chosen host. Assigning
      // .pathname can never change the host.
      const originUrl = new URL(originBase);
      originUrl.pathname = url.pathname;
      originUrl.search = url.search;

      // Copy inbound headers and mark the hop. Forbidden hop headers (Host,
      // Content-Length, ...) are overridden by the runtime's fetch itself, so a
      // straight copy is safe and preserves agent auth/context headers.
      const outboundHeaders = new Headers(request.headers);
      outboundHeaders.set('X-AOP-Proxy-Processed', 'true');

      const init = {
        method: request.method,
        headers: outboundHeaders,
        // Pass 3xx back to the agent untouched — a transparent proxy must not
        // follow redirects on the client's behalf.
        redirect: 'manual',
      };
      if (!BODYLESS_METHODS.has(request.method) && request.body) {
        // Stream the original body straight through — never buffer it at the
        // edge. (The telemetry clone reads its own tee'd copy later.)
        init.body = request.body;
        // Required by Node/undici for streamed bodies; ignored by workerd.
        init.duplex = 'half';
      }

      let originResponse;
      try {
        originResponse = await fetch(originUrl.toString(), init);
      } catch (err) {
        // Origin unreachable/DNS/TLS failure: well-formed 502, and the intent
        // is still recorded with status 502 so loss_diagnostics can classify
        // "origin down" drop-offs.
        const latencyMs = Date.now() - startedAt;
        if (intercepted) {
          scheduleTelemetry(ctx, env, {
            clonedRequest: telemetryClone,
            url,
            signature,
            originBase,
            method: request.method,
            status: 502,
            latencyMs,
          });
        }
        return errorResponse(
          502,
          'origin_unreachable',
          `Origin fetch failed: ${err?.message ?? 'unknown error'}`,
          latencyMs,
        );
      }

      const latencyMs = Date.now() - startedAt;

      // Stream the origin body straight back (no buffering); re-wrapping in a
      // new Response gives us mutable headers for the latency stamp while
      // preserving status/statusText/headers from the origin.
      const proxied = new Response(originResponse.body, originResponse);
      proxied.headers.set('X-AOP-Latency-Ms', String(latencyMs));

      // Telemetry is registered AFTER the response object exists and runs
      // AFTER it is returned — zero synchronous cost on the reply.
      if (intercepted) {
        scheduleTelemetry(ctx, env, {
          clonedRequest: telemetryClone,
          url,
          signature,
          originBase,
          method: request.method,
          status: originResponse.status,
          latencyMs,
        });
      }

      return proxied;
    } catch (err) {
      // Final backstop: the worker must never throw to the runtime — that
      // would surface a raw 1101 error page to the agent. Return structured
      // JSON instead so agent-side retry logic can react sanely.
      console.error('AOP edge: unexpected proxy failure:', err?.message ?? err);
      return errorResponse(
        500,
        'edge_proxy_internal_error',
        'The AOP edge proxy hit an unexpected internal error.',
        Date.now() - startedAt,
      );
    }
  },

  /**
   * Queue consumer: drain telemetry batches into the ingestion service.
   *
   * Contract:
   *  - 2xx from ingest  -> ack the batch (records are durably in PostgreSQL's
   *    ingest path; done).
   *  - non-2xx / thrown -> retry the whole batch via retryAll()/throw; Queues
   *    redelivery honors max_retries and parks poison batches in the DLQ.
   *  - INGEST_API_URL unset -> log loudly and ACK (drop) — retrying forever on
   *    a config gap would just wedge the queue and mask the real problem.
   *
   * @param {object} batch Cloudflare Queues MessageBatch
   * @param {object} env bindings/vars (INGEST_API_URL, INGEST_API_TOKEN)
   */
  async queue(batch, env) {
    const messages = Array.isArray(batch?.messages) ? batch.messages : [];
    if (messages.length === 0) {
      ackBatch(batch); // nothing to do; keep the queue moving
      return;
    }

    const base = typeof env?.INGEST_API_URL === 'string' ? env.INGEST_API_URL.trim() : '';
    if (base === '') {
      // Config gap guard: without a destination, retrying is pointless — the
      // batch would spin until max_retries on every delivery. Drop with a loud
      // log so operators see data loss immediately.
      console.error(
        `AOP edge queue: INGEST_API_URL is unset; dropping ${messages.length} telemetry record(s)`,
      );
      ackBatch(batch);
      return;
    }

    // Message bodies ARE the telemetry records pushed by fetch(); tolerate the
    // occasional null/undefined body without failing the whole batch.
    const records = [];
    for (const message of messages) {
      const body = message?.body;
      if (body !== undefined && body !== null) records.push(body);
    }

    let payload;
    try {
      payload = JSON.stringify({ records });
    } catch (err) {
      // Unserializable batch (should be impossible — queue messages are
      // structured-clone round-tripped) is poison by definition: drop it
      // rather than retry it into the DLQ forever.
      console.error('AOP edge queue: unserializable batch; dropping:', err?.message);
      ackBatch(batch);
      return;
    }

    // Trailing-slash tolerance so "https://ingest.aop.network/" in config
    // doesn't produce a "//ingest/telemetry" path.
    const endpoint = `${base.replace(/\/+$/, '')}/ingest/telemetry`;
    const headers = { 'content-type': 'application/json' };
    const token = env?.INGEST_API_TOKEN;
    if (typeof token === 'string' && token !== '') {
      headers['authorization'] = `Bearer ${token}`;
    }
    // Missing token is NOT dropped client-side: the ingest service owns auth
    // policy; a 401 response will flow through the normal retry/DLQ path.

    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: payload,
        signal: ingestTimeoutSignal(),
      });
    } catch (err) {
      console.error('AOP edge queue: ingest POST failed, retrying batch:', err?.message ?? err);
      retryBatch(batch, err);
      return;
    }

    // Release the response body either way — an unconsumed body would hold the
    // connection open for the rest of the invocation.
    try {
      response.body?.cancel?.()?.catch?.(() => {});
    } catch {
      /* ignore */
    }

    if (response.ok) {
      ackBatch(batch);
      return;
    }

    console.error(`AOP edge queue: ingest service responded ${response.status}; retrying batch`);
    retryBatch(batch, new Error(`AOP ingest service responded ${response.status}`));
  },
};
