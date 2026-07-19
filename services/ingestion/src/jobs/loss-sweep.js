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
import {
  findExpiredUnreconciledIntents,
  insertLossDiagnostic,
  getSweepWatermark,
  setSweepWatermark,
  getSweepFrontier,
} from '../repositories.js';

/**
 * Rows fetched per sweep tick. Bounds sweep latency and memory under
 * backlog; anything left over is picked up next tick (oldest-first ordering
 * in the repository guarantees no starvation).
 */
export const SWEEP_BATCH_SIZE = 200;

/** sweep_state.job_name key for this job's watermark (migration 0012). */
export const SWEEP_JOB_NAME = 'loss_sweep';

/**
 * Watermark overlap slack. The watermark advances to the newest FULLY
 * processed instant; the next scan starts this far below it so batch-µs
 * offsets, clock skew between now() evaluations, and rows committed with a
 * slightly older processed_at (in-flight inserts at watermark time) can
 * never be skipped past. 60s dwarfs every such effect.
 */
const WATERMARK_SLACK_MS = 60_000;

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
   *
   * Watermark protocol (sweep_state, migration 0012): without a lower bound
   * the sweep query re-VISITS the whole retention window every tick (the
   * anti-joins only exclude rows from the result), which outgrows
   * statement_timeout at firehose scale. The watermark advances only after
   * an error-free pass — to the batch's newest processed_at on a full batch,
   * or to (now - expiry) when the frontier is drained — and the next scan
   * starts WATERMARK_SLACK_MS below it. Rows in the overlap are cheap
   * anti-join no-ops; rows that errored keep being retried because the
   * watermark never moves past them.
   */
  async function sweepPass() {
    const summary = { fetched: 0, diagnosed: 0, conflicts: 0, rowErrors: 0 };

    let watermark = null;
    try {
      const stored = await getSweepWatermark(db, SWEEP_JOB_NAME);
      if (stored !== null) {
        const ms = Date.parse(stored instanceof Date ? stored.toISOString() : String(stored));
        if (Number.isFinite(ms)) watermark = new Date(ms - WATERMARK_SLACK_MS).toISOString();
      }
    } catch (err) {
      // Missing table (pre-0012) or transient failure: a full scan is
      // correct, just slower — proceed unbounded and say so.
      logger.warn('loss sweep watermark unavailable; scanning unbounded this tick', { err });
    }

    // Frontier captured from the DATABASE clock BEFORE the fetch: the
    // drained-branch watermark below must never advance past an instant
    // whose rows this pass could not have seen. Pre-fetch capture covers
    // slow passes (rows becoming eligible mid-pass stay above it); the DB
    // clock removes app-vs-DB skew from the safety argument.
    let frontier = null;
    try {
      frontier = await getSweepFrontier(db, config.intentExpirySeconds);
    } catch (err) {
      logger.warn('loss sweep could not read the DB frontier; watermark will not advance this tick', { err });
    }

    let rows;
    try {
      rows = await findExpiredUnreconciledIntents(db, {
        expirySeconds: config.intentExpirySeconds,
        limit: SWEEP_BATCH_SIZE,
        watermark,
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

    // Advance the watermark only when every fetched row resolved (diagnosed
    // or lost an idempotent conflict) — an errored row must stay above the
    // watermark so future ticks retry it.
    if (summary.rowErrors === 0) {
      try {
        const next =
          rows.length < SWEEP_BATCH_SIZE
            ? // Frontier drained: everything older than the PRE-FETCH DB
              // frontier is fully processed. null frontier (probe failed)
              // -> skip advancement rather than trust the app clock.
              frontier
            : // Full batch: processed through the newest row we actually saw
              // (rows are oldest-first, so the last one is the newest).
              new Date(rows[rows.length - 1].processed_at).toISOString();
        if (next !== null) await setSweepWatermark(db, SWEEP_JOB_NAME, next);
      } catch (err) {
        // Non-fatal: the next tick just rescans from the old watermark.
        logger.warn('loss sweep could not persist watermark', { err });
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
