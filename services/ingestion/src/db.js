/**
 * db.js — PostgreSQL pool wrapper for the AOP ingestion service.
 *
 * Role in the AOP data flow:
 *   Every persistent effect of this service flows through here:
 *     - agent_intent_logs INSERTs (edge telemetry firehose),
 *     - reconciled_agent_orders INSERTs (Shopify webhook attribution),
 *     - loss_diagnostics INSERTs (sweep job),
 *     - merchant_profiles lookups (tenant resolution).
 *   All SQL text lives in src/repositories.js; this module only owns the
 *   connection lifecycle so pooling/retry/shutdown policy is decided in
 *   exactly one place.
 *
 * Resilience contract (prime directive: analytics must never break live
 * merchant traffic):
 *   - The pool 'error' event IS handled. node-postgres emits it when an IDLE
 *     client's backend connection drops (DB restart, failover, idle timeout
 *     at a proxy). Without a listener that event crashes the Node process —
 *     which would take down webhook receiving because a *idle* socket died.
 *     We log and let the pool replace the client on next checkout.
 *   - query() rethrows to its caller (routes/jobs decide how to degrade),
 *     but always logs first so a swallowed downstream error still leaves a
 *     forensic trail.
 */

import pg from 'pg';

/**
 * Create the pool wrapper.
 *
 * @param {{databaseUrl: string}} config  from src/config.js
 * @param {{info:Function, warn:Function, error:Function}} logger
 * @returns {{query: Function, end: Function, pool: pg.Pool}}
 */
export function createDbPool(config, logger) {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    // Modest ceiling: this service's workload is many small statements, and
    // the ingest path batches rows into single INSERTs, so 10 connections
    // comfortably outruns the edge queue consumer without starving the
    // merchant dashboard's read replica budget on shared plans.
    max: 10,
    // Recycle idle clients before typical cloud LB/proxy idle-kill windows
    // (often 60s) so we drop them gracefully instead of eating pool 'error's.
    idleTimeoutMillis: 30_000,
    // Fail checkout fast when the DB is unreachable: a hung webhook request
    // would make Shopify's delivery time out and count against the merchant's
    // webhook health; a fast 500 lets Shopify's retry machinery do its job.
    connectionTimeoutMillis: 5_000,
    // Statement safety net: no query in this service legitimately runs this
    // long; a runaway sweep query must not pin a connection forever.
    statement_timeout: 15_000,
  });

  // CRITICAL: without this listener, a dropped idle client emits an
  // unhandled 'error' event and crashes the entire process. The pool
  // discards the broken client automatically; we only need to observe.
  pool.on('error', (err) => {
    logger.error('postgres idle client error (pool will replace the client; process continues)', {
      err,
    });
  });

  /**
   * Parameterized query helper. Thin by design — transactions and SQL text
   * belong to repositories.js — but it centralizes error logging so every
   * failed statement is visible even when the caller degrades gracefully.
   *
   * @param {string} text   SQL with $1..$n placeholders
   * @param {Array}  [params]
   * @returns {Promise<pg.QueryResult>}
   */
  async function query(text, params = []) {
    try {
      return await pool.query(text, params);
    } catch (err) {
      // Log the statement head only (first 120 chars): enough to identify the
      // query in logs without ever echoing payload-sized SQL or parameters
      // (params may contain merchant/order data and must not leak into logs).
      logger.error('postgres query failed', {
        err,
        statement: String(text).replace(/\s+/g, ' ').slice(0, 120),
        paramCount: Array.isArray(params) ? params.length : 0,
      });
      throw err;
    }
  }

  /**
   * Graceful shutdown: waits for checked-out clients to be released, then
   * closes every connection. Idempotent-ish guard because both the SIGTERM
   * and SIGINT paths (plus test teardown) may race to call it.
   */
  let ended = false;
  async function end() {
    if (ended) return;
    ended = true;
    try {
      await pool.end();
      logger.info('postgres pool drained and closed');
    } catch (err) {
      // Failing to close cleanly at shutdown is worth a log line, never a
      // non-zero exit by itself.
      logger.warn('postgres pool close reported an error during shutdown', { err });
    }
  }

  return { query, end, pool };
}
