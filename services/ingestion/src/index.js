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
 * Shutdown ordering rationale (reverse of startup, and it matters):
 *   sweep first (stop generating new DB work), then the HTTP server (stop
 *   accepting new requests while in-flight ones finish), then the pool
 *   (drain once nothing can need a connection). Draining the pool first
 *   would strand in-flight webhook requests mid-INSERT — exactly the kind of
 *   half-processed order the ON CONFLICT idempotency exists to survive, but
 *   there is no reason to invoke it on every deploy.
 */

import { loadConfig, ConfigError } from './config.js';
import { createDbPool } from './db.js';
import { buildApp } from './app.js';
import { startLossSweep } from './jobs/loss-sweep.js';
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
      // (a) stop generating DB work; awaits any in-flight sweep pass.
      await sweep.stop();

      // (b) stop accepting connections; resolves when in-flight requests end.
      await new Promise((resolve) => {
        server.close((err) => {
          if (err) logger.warn('http server close reported an error', { err });
          resolve();
        });
      });

      // (c) drain the pool last — nothing can need a connection anymore.
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
