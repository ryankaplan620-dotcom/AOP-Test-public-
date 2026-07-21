/**
 * index.js — boot + lifecycle for the AOP ingestion service.
 *
 * Role in the AOP data flow:
 *   The process entrypoint that stands up the entire server-side ingestion
 *   half of the platform:
 *     1. load + validate config (fail fast, src/config.js),
 *     2. open the PostgreSQL pool (src/db.js),
 *     3. start the HTTP surface (src/app.js: telemetry ingest + Shopify
 *        webhooks + healthz),
 *     4. start the loss-diagnostics sweep (src/jobs/loss-sweep.js),
 *     5. shut all of it down IN REVERSE ORDER on SIGTERM/SIGINT.
 *
 * Shutdown ordering rationale:
 *   jobs and the HTTP listener drain CONCURRENTLY (they only depend on the
 *   pool, not on each other, and the watchdog budget is shared — one slow
 *   drain must not starve the rest), then the pool last (drain once
 *   nothing can need a connection). Draining the pool first would strand
 *   in-flight webhook requests mid-INSERT — exactly the kind of
 *   half-processed order the ON CONFLICT idempotency exists to survive, but
 *   there is no reason to invoke it on every deploy.
 */

import { loadConfig, ConfigError } from './config.js';
import { createDbPool } from './db.js';
import { buildApp } from './app.js';
import { startLossSweep } from './jobs/loss-sweep.js';
import { startRetentionSweep } from './jobs/retention-sweep.js';
import { startDigestJob } from './jobs/digest.js';
import { createLogger } from './lib/logger.js';

const logger = createLogger('ingestion');

/** Hard deadline for graceful shutdown before we stop being polite. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main() {
  // ---- 1. config (fail fast with an operator-readable message) ----------
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      // Message only — a stack trace for a missing env var is noise that
      // buries the actual fix in the deploy logs.
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  // ---- 2. database pool ---------------------------------------------------
  const db = createDbPool(config, logger.child('db'));

  // ---- 3. HTTP server -----------------------------------------------------
  const app = buildApp({ config, db, logger });
  const server = app.listen(config.port, () => {
    logger.info('AOP ingestion service listening', {
      port: config.port,
      intent_expiry_seconds: config.intentExpirySeconds,
      loss_sweep_interval_ms: config.lossSweepIntervalMs,
    });
  });
  // Node defaults changed across versions; pin generous-but-bounded socket
  // timeouts so slow-loris connections cannot pile up on the webhook path.
  server.requestTimeout = 30_000;
  server.headersTimeout = 31_000;
  server.on('error', (err) => {
    // e.g. EADDRINUSE — nothing to gracefully drain yet; report and bail.
    logger.error('http server failed', { err });
    process.exit(1);
  });

  // ---- 4. loss sweep ------------------------------------------------------
  const sweep = startLossSweep({ db, config, logger: logger.child('loss-sweep') });
  // Compliance retention: enforce the 90-day telemetry cap in-process.
  const retention = startRetentionSweep({ db, config, logger: logger.child('retention') });
  // Weekly digest delivery (no-op when DIGEST_WEBHOOK_URL is unset).
  const digest = startDigestJob({ db, config, logger: logger.child('digest') });

  // ---- 5. graceful shutdown ----------------------------------------------
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return; // double Ctrl-C / duplicate signal
    shuttingDown = true;
    logger.info('shutdown initiated', { signal });

    // Deadline watchdog: if a wedged connection blocks the drain, exit
    // non-gracefully rather than hang the deploy forever. unref() so this
    // timer can never itself keep the process alive.
    const watchdog = setTimeout(() => {
      logger.error('graceful shutdown deadline exceeded; forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    watchdog.unref();

    try {
      // (a) stop the jobs AND the HTTP listener concurrently: both only
      // consume the pool, never each other, and serializing them would let
      // one slow drain (a hung digest webhook, a wedged request) eat the
      // entire watchdog budget before the other even starts. server.close()
      // stops NEW connections the moment it is called; in-flight requests
      // finish while the jobs drain alongside.
      await Promise.all([
        sweep.stop(),
        retention.stop(),
        digest.stop(),
        new Promise((resolve) => {
          server.close((err) => {
            if (err) logger.warn('http server close reported an error', { err });
            resolve();
          });
        }),
      ]);

      // (b) drain the pool last — nothing can need a connection anymore.
      await db.end();

      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error('error during graceful shutdown', { err });
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Last-resort observability. unhandledRejection is logged but does NOT
  // kill the process: this service's contract is that a stray analytics
  // failure never takes down webhook receiving. uncaughtException DOES exit
  // (state may be corrupt; the supervisor restarts us) — but through the
  // graceful path so in-flight webhook INSERTs get their chance to finish.
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled promise rejection (continuing)', { err: reason });
  });
  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception — shutting down', { err });
    shutdown('uncaughtException').catch(() => process.exit(1));
  });
}

main().catch((err) => {
  // Boot itself failed pre-listen: nothing to drain, just report honestly.
  console.error('AOP ingestion service failed to start:', err);
  process.exit(1);
});
