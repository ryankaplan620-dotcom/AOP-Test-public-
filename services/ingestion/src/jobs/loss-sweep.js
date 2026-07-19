/**
 * jobs/loss-sweep.js — the loss-diagnostics sweep (drop-off classification).
 *
 * Role in the AOP data flow:
 *   Every LOSS_SWEEP_INTERVAL_MS this job asks PostgreSQL for
 *   agent_intent_logs rows whose INTENT_EXPIRY_SECONDS conversion window
 *   elapsed with no matching reconciled_agent_orders row (the anti-join in
 *   src/repositories.js), runs each through the pure heuristic classifier
 *   (src/lib/loss-classifier.js), and writes one loss_diagnostics row per
 *   intent — the data behind the merchant dashboard's "why agents drop off".
 *
 * Resilience contract:
 *   - Overlap guard: if a tick fires while the previous sweep is still
 *     running (slow DB, big backlog), the new tick is skipped — two
 *     concurrent sweeps would fetch overlapping batches and burn writes on
 *     ON CONFLICT no-ops.
 *   - Per-row try/catch: one hostile payload or one failed INSERT costs
 *     exactly one row this cycle (it will be retried next sweep because the
 *     anti-join still sees it); it never kills the loop or the process.
 *   - Whole-tick try/catch: a DB outage logs once per tick and the interval
 *     keeps ticking — the sweep self-heals when PostgreSQL returns.
 *   - stop() is awaitable and resolves only after any in-flight sweep
 *     finishes, so graceful shutdown (src/index.js) can drain the pool
 *     without yanking connections out from under a running sweep.
 */

import { classifyLoss } from '../lib/loss-classifier.js';
import { formatCentsAsDecimal } from '../lib/commission.js';
import { findExpiredUnreconciledIntents, insertLossDiagnostic } from '../repositories.js';

/**
 * Rows fetched per sweep tick. Bounds sweep latency and memory under
 * backlog; anything left over is picked up next tick (oldest-first ordering
 * in the repository guarantees no starvation).
 */
export const SWEEP_BATCH_SIZE = 200;

/**
 * Start the sweep.
 *
 * All dependencies are injected — no module-level state — so tests can drive
 * the sweep with fakes and multiple instances can never share globals.
 *
 * @param {{
 *   db: object,              // src/db.js wrapper
 *   config: {intentExpirySeconds: number, lossSweepIntervalMs: number},
 *   logger: object,          // src/lib/logger.js
 * }} deps
 * @returns {{stop: () => Promise<void>, runOnce: () => Promise<object>}}
 *   runOnce is exposed for observability/testing; stop() halts the interval
 *   and resolves after any in-flight sweep completes.
 */
/**
 * Advisory-lock key for this job (arbitrary but stable across replicas —
 * the value only has to be unique among AOP's jobs; see retention-sweep).
 */
export const LOSS_SWEEP_LOCK_KEY = 815001;

export function startLossSweep({ db, config, logger }) {
  let running = false; // overlap guard
  let stopped = false;
  let inFlight = Promise.resolve(); // last sweep's promise, awaited by stop()

  // Cross-REPLICA guard, complementing the in-process `running` flag: with
  // horizontally scaled ingestion, only the replica that wins the advisory
  // lock sweeps this tick; the SQL is idempotent anyway (ON CONFLICT), so
  // the lock removes wasted duplicate work rather than preventing
  // corruption. Fakes without withAdvisoryLock (unit tests) run unguarded.
  const withLock =
    typeof db.withAdvisoryLock === 'function'
      ? (fn) => db.withAdvisoryLock(LOSS_SWEEP_LOCK_KEY, fn)
      : async (fn) => ({ ran: true, result: await fn() });

  /**
   * One sweep pass: fetch -> classify -> insert, with per-row isolation.
   * Never rejects: every failure path is caught and logged.
   */
  async function sweepPass() {
    const summary = { fetched: 0, diagnosed: 0, conflicts: 0, rowErrors: 0 };
    let rows;
    try {
      rows = await findExpiredUnreconciledIntents(db, {
        expirySeconds: config.intentExpirySeconds,
        limit: SWEEP_BATCH_SIZE,
      });
    } catch (err) {
      // DB unavailable — nothing to do this tick; the interval retries.
      logger.error('loss sweep could not fetch expired intents; will retry next tick', { err });
      return summary;
    }
    summary.fetched = rows.length;

    for (const row of rows) {
      // PER-ROW isolation: classification is pure/never-throws by contract,
      // but the INSERT can fail (constraint edge cases, connection loss
      // mid-batch) and one bad row must never abort the remaining rows.
      try {
        const verdict = classifyLoss(row);

        // Integer cents -> NUMERIC-ready decimal string. classifyLoss
        // guarantees a non-negative safe integer, but the formatter's null
        // path is still handled — money code never assumes.
        const revenueDecimal = formatCentsAsDecimal(verdict.estimatedRevenueLost) ?? '0.00';

        const { inserted } = await insertLossDiagnostic(db, {
          merchantId: row.merchant_id,
          intentLogId: row.id,
          // Repository row carries the DB sentinel already; default again
          // defensively in case a foreign/older row shape sneaks through.
          targetSku: typeof row.target_sku === 'string' && row.target_sku !== '' ? row.target_sku : 'UNSPECIFIED',
          reason: verdict.reason,
          estimatedRevenueLost: revenueDecimal,
          competitorDelta: verdict.competitorDelta,
        });

        if (inserted) {
          summary.diagnosed += 1;
        } else {
          // ON CONFLICT no-op: another sweep instance (or a crash-restart
          // overlap) diagnosed this intent first. Expected, not an error.
          summary.conflicts += 1;
        }
      } catch (err) {
        summary.rowErrors += 1;
        logger.error('loss sweep failed on one intent row; continuing with the rest', {
          err,
          intent_log_id: row?.id ?? null,
        });
      }
    }

    if (summary.fetched > 0 || summary.rowErrors > 0) {
      logger.info('loss sweep completed', summary);
    }
    return summary;
  }

  /**
   * Lock-guarded pass. Never rejects: a failed lock checkout (pool
   * exhausted, DB down) is logged and the interval retries.
   */
  async function runOnce() {
    try {
      const { ran, result } = await withLock(sweepPass);
      if (!ran) {
        logger.info('loss sweep skipped: another replica holds the advisory lock');
        return { fetched: 0, diagnosed: 0, conflicts: 0, rowErrors: 0, skipped: true };
      }
      return result;
    } catch (err) {
      logger.error('loss sweep could not acquire/release the advisory lock; will retry next tick', { err });
      return { fetched: 0, diagnosed: 0, conflicts: 0, rowErrors: 0, skipped: true };
    }
  }

  /** Interval tick: skip when a sweep is already in flight. */
  function tick() {
    if (running || stopped) {
      if (running) logger.warn('loss sweep tick skipped: previous sweep still running');
      return;
    }
    running = true;
    inFlight = runOnce()
      .catch((err) => {
        // runOnce never rejects by design; this is the absolute backstop so
        // an unforeseen bug cannot become an unhandled rejection.
        logger.error('loss sweep tick crashed unexpectedly', { err });
      })
      .finally(() => {
        running = false;
      });
  }

  const timer = setInterval(tick, config.lossSweepIntervalMs);
  // unref(): the sweep must never be the thing keeping a dying process alive.
  if (typeof timer.unref === 'function') timer.unref();

  // Kick one immediate pass so a restart doesn't wait a full interval to
  // resume diagnosing an accumulated backlog.
  tick();

  logger.info('loss sweep started', {
    interval_ms: config.lossSweepIntervalMs,
    expiry_seconds: config.intentExpirySeconds,
    batch_size: SWEEP_BATCH_SIZE,
  });

  return {
    runOnce,
    /** Halt the interval; resolves after any in-flight sweep finishes. */
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight;
      logger.info('loss sweep stopped');
    },
  };
}
