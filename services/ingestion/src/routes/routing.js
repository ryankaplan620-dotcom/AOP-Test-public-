/**
 * routes/routing.js — dynamic edge-routing resolution.
 *
 * Role in the AOP data flow:
 *   [edge worker fetch()] --(static MERCHANT_ROUTES miss)-->
 *   GET /routes/resolve?hostname=x --> merchant_profiles
 *   (proxy_hostname -> origin_url, populated by OAuth install) --> the
 *   worker caches the answer per isolate and proxies the agent request.
 *
 * This is the seam that makes onboarding end-to-end: the moment the OAuth
 * callback upserts a merchant with routing columns, their proxy hostname
 * resolves here — no worker config edit, no redeploy.
 *
 * Auth: the SAME bearer credential the edge already holds for its telemetry
 * drain (INGEST_API_TOKEN) — both calls originate from the worker, one trust
 * domain, no new secret to distribute. Timing-safe comparison as everywhere.
 *
 * Read-only, single-row, index-backed lookup — safe on the worker's
 * cold-path cadence (one call per unknown hostname per isolate per TTL).
 */

import express from 'express';
import { timingSafeTokenCheck } from '../lib/auth.js';
import { findRouteByProxyHostname } from '../repositories.js';

/** Hostname sanity bound: DB column width; anything longer cannot match. */
const MAX_HOSTNAME_LENGTH = 255;

/**
 * Build the routing router.
 *
 * @param {{config: object, db: object, logger: object}} deps
 * @returns {express.Router}
 */
export function buildRoutingRouter({ config, db, logger }) {
  const router = express.Router();

  router.get('/resolve', async (req, res, next) => {
    try {
      // --- auth (edge worker credential; uniform 401, no oracle) ----------
      const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') ?? '');
      const presented = match ? match[1].trim() : null;
      if (!timingSafeTokenCheck(presented, config.ingestApiToken)) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }

      const raw = req.query.hostname;
      const hostname = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
      if (hostname === '' || hostname.length > MAX_HOSTNAME_LENGTH) {
        res.status(400).json({ error: 'hostname (<=255 chars) is required' });
        return;
      }

      const route = await findRouteByProxyHostname(db, hostname);
      if (route === null) {
        // Unknown hostname is a normal outcome (scanner spray, not-yet-
        // onboarded merchant) — 404, no logging noise.
        res.status(404).json({ error: 'no route for hostname' });
        return;
      }

      res.json({ hostname, origin: route.origin });
    } catch (err) {
      logger.error('route resolution failed', { err, hostname: String(req.query.hostname ?? '') });
      next(err);
    }
  });

  return router;
}
