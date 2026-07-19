/**
 * app.js — express application assembly for the AOP ingestion service.
 *
 * Role in the AOP data flow:
 *   Wires the two inbound engines onto one HTTP surface:
 *     POST /webhooks/shopify/orders-create  (Webhook Receiver Engine)
 *     POST /ingest/telemetry                (Worker Ingestion Engine)
 *     GET  /healthz                         (load balancer / uptime probe)
 *
 * MOUNT ORDER IS LOAD-BEARING: the webhook router is mounted BEFORE
 * express.json(). Shopify's HMAC signs the raw request bytes, so the webhook
 * route must own body reading via express.raw() — if the global JSON parser
 * consumed the stream first, the raw bytes would be gone and every webhook
 * would fail signature verification. Do not reorder.
 *
 * Exported as a builder (no listen()) so tests can drive it with supertest-
 * style tooling and src/index.js owns the socket lifecycle.
 */

import express from 'express';
import { buildTelemetryRouter } from './routes/telemetry.js';
import { buildWebhooksRouter } from './routes/webhooks.js';
import { buildAnalyticsRouter } from './routes/analytics.js';
import { buildOAuthRouter } from './routes/oauth.js';

/**
 * @param {{config: object, db: object, logger: object}} deps
 * @returns {express.Express}
 */
export function buildApp({ config, db, logger }) {
  const app = express();

  // Header hygiene: no framework fingerprinting for whoever port-scans us.
  app.disable('x-powered-by');
  // Behind Cloudflare/ALB in production; trust one proxy hop so req.ip is the
  // real client for log forensics (never used for auth decisions).
  app.set('trust proxy', 1);

  // ---- 1. RAW-body webhook route (BEFORE any JSON parsing — see header) --
  app.use('/webhooks', buildWebhooksRouter({ config, db, logger: logger.child('webhooks') }));

  // ---- 2. JSON parsing for everything else -------------------------------
  // 2mb limit: a full 500-record telemetry batch with 32KB-capped payloads
  // stays well under this only in the aggregate-typical case; genuinely
  // oversized batches surface as 413 via the central error handler.
  app.use(express.json({ limit: '2mb' }));

  // ---- 3. Worker Ingestion Engine ---------------------------------------
  app.use('/ingest', buildTelemetryRouter({ config, db, logger: logger.child('telemetry') }));

  // ---- 3b. Dashboard analytics reads (bearer-gated; 503 until the
  // DASHBOARD_API_TOKEN feature gate is configured) -----------------------
  app.use('/analytics', buildAnalyticsRouter({ config, db, logger: logger.child('analytics') }));

  // ---- 3c. Merchant onboarding: Shopify OAuth install flow (503 until the
  // SHOPIFY_API_KEY/SECRET + TOKEN_ENCRYPTION_KEY + APP_URL group is set) --
  app.use('/auth', buildOAuthRouter({ config, db, logger: logger.child('oauth') }));

  // ---- 4. Health probe ---------------------------------------------------
  // SELECT 1 proves the full path to PostgreSQL (pool checkout + round-trip),
  // not just that the event loop is alive. 503 (not 500) on failure: load
  // balancers treat 503 as "back off, retry later" — which is exactly right
  // while the DB reconnects. The merchant's live storefront traffic does not
  // pass through this service, so a degraded healthz never gates commerce.
  app.get('/healthz', async (_req, res) => {
    try {
      await db.query('SELECT 1');
      res.status(200).json({ status: 'ok' });
    } catch (err) {
      logger.error('healthz database ping failed', { err });
      res.status(503).json({ status: 'degraded', reason: 'database unreachable' });
    }
  });

  // ---- 5. 404 (after all routes) -----------------------------------------
  app.use((req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  // ---- 6. Central error handler (must be last; 4-arg signature) ----------
  // Every route funnels unexpected errors here via next(err). The response
  // is deliberately opaque: internals (stack traces, SQL, connection
  // strings) go to logs only — never to a caller who might be an attacker
  // probing the ingest surface.
  //
  // Body-parser errors are mapped to honest 4xx codes so misbehaving
  // producers get actionable feedback instead of a lying 500:
  //   entity.too.large  -> 413 (payload over the configured limit)
  //   entity.parse.failed -> 400 (malformed JSON)
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const type = err?.type;
    if (type === 'entity.too.large') {
      res.status(413).json({ error: 'payload too large' });
      return;
    }
    if (type === 'entity.parse.failed' || type === 'charset.unsupported') {
      res.status(400).json({ error: 'malformed request body' });
      return;
    }

    logger.error('unhandled request error', {
      err,
      method: req.method,
      path: req.path,
    });

    // Guard against "headers already sent" double-write crashes.
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
