/**
 * jobs/retention-sweep.js — automated telemetry retention (compliance).
 *
 * Role in the AOP data flow:
 *   setInterval -> SELECT * FROM purge_expired_telemetry($days, $batch)
 *     -> agent_intent_logs older than the retention cap deleted (their
 *        loss_diagnostics cascade); reconciled_agent_orders (billing) are
 *        never touched — see db/migrations/0006.
 *
 * Why in-process (vs pg_cron): the compliance memo's 90-day cap is a hard
 * platform obligation, not an optional ops nicety — the default deployment
 * must enforce it without requiring an extra scheduler to be installed and
 * wired. pg_cron remains a fine alternative; running both is harmless (the
 * purge is idempotent — the second pass finds nothing).
 *
 * Cadence: default every 6 hours. The purge function itself batches by ctid
 * (bounded lock/WAL per transaction), so a long-idle deployment catching up
 * on a large backlog still cannot stall the ingest hot path.
 *
 * Same lifecycle contract as jobs/loss-sweep.js: injected deps, overlap
 * guard, never-rejecting passes, stop() drains the in-flight pass.
 *
 * @param {{
 *   db: object,
 *   config: {retentionDays: number, retentionSweepIntervalMs: number},
 *   logger: object,
 * }} deps
 * @returns {{stop: () => Promise<void>, runOnce: () => Promise<object>}}
 */

import { deleteExpiredDeadLetters } from '../repositories.js';

/** Rows deleted per inner purge transaction (see purge_expired_telemetry). */
const PURGE_BATCH_SIZE = 10_000;

/** Advisory-lock key (unique among AOP jobs; see loss-sweep's 815001). */
export const RETENTION_SWEEP_LOCK_KEY = 815002;

export function startRetentionSweep({ db, config, logger }) {
  let running = false; // overlap guard
  let stopped = false;
  let inFlight = Promise.resolve();

  // Cross-replica guard (same rationale as loss-sweep): the purge is
  // idempotent, so the lock removes duplicate ctid-batch scans across
  // scaled-out replicas rather than preventing corruption.
  const withLock =
    typeof db.withAdvisoryLock === 'function'
      ? (fn) => db.withAdvisoryLock(RETENTION_SWEEP_LOCK_KEY, fn)
      : async (fn) => ({ ran: true, result: await fn() });

  async function purgePass() {
    const summary = { intents_deleted: 0, dead_letters_deleted: 0, batches: 0, failed: false };
    // The SQL function deletes ONE ctid-batch per call (migration 0012) and
    // THIS loop drains the backlog: every iteration is its own statement /
    // transaction, so no backlog size can ever hit statement_timeout, and
    // batches already deleted stay deleted if a later one fails. (The 0006
    // version looped inside one plpgsql call = one 15s-bounded transaction —
    // any real backlog rolled back wholesale, forever.)
    try {
      for (;;) {
        if (stopped) break; // shutdown: finish mid-backlog gracefully
        const result = await db.query('SELECT * FROM purge_expired_telemetry($1, $2)', [
          config.retentionDays,
          PURGE_BATCH_SIZE,
        ]);
        const deleted = Number(result.rows[0]?.intents_deleted ?? 0);
        summary.intents_deleted += deleted;
        summary.batches += 1;
        if (deleted < PURGE_BATCH_SIZE) break; // backlog drained
      }
      // Dead letters (migration 0016) follow the same retention bound —
      // preserved evidence, not a second archive. Same bounded-batch loop.
      for (;;) {
        if (stopped) break;
        const { deleted } = await deleteExpiredDeadLetters(db, {
          retentionDays: config.retentionDays,
          limit: PURGE_BATCH_SIZE,
        });
        summary.dead_letters_deleted += deleted;
        if (deleted < PURGE_BATCH_SIZE) break;
      }
      if (summary.intents_deleted > 0 || summary.dead_letters_deleted > 0) {
        logger.info('retention purge completed', {
          intents_deleted: summary.intents_deleted,
          dead_letters_deleted: summary.dead_letters_deleted,
          batches: summary.batches,
          retention_days: config.retentionDays,
        });
      }
    } catch (err) {
      // DB down or migration not applied — log loudly, retry next tick.
      // The cap is a compliance obligation: silence here would hide drift.
      // Batches deleted before the failure remain deleted (progress holds).
      summary.failed = true;
      logger.error('retention purge failed; will retry next tick', { err });
    }
    return summary;
  }

  async function runOnce() {
    try {
      const { ran, result } = await withLock(purgePass);
      if (!ran) return { intents_deleted: 0, failed: false, skipped: true };
      return result;
    } catch (err) {
      logger.error('retention purge could not acquire/release the advisory lock; will retry next tick', { err });
      return { intents_deleted: 0, failed: true, skipped: true };
    }
  }

  const timer = setInterval(() => {
    if (running || stopped) return; // skip ticks while a pass is in flight
    running = true;
    inFlight = runOnce().finally(() => {
      running = false;
    });
  }, config.retentionSweepIntervalMs);
  // Do not hold the event loop open for the sweep alone.
  timer.unref?.();

  // First pass shortly after boot (not immediately: let the pool warm up and
  // healthz go green first) so a long-stopped deployment catches up fast.
  const kickoff = setTimeout(() => {
    if (running || stopped) return;
    running = true;
    inFlight = runOnce().finally(() => {
      running = false;
    });
  }, 5_000);
  kickoff.unref?.();

  return {
    runOnce,
    async stop() {
      stopped = true;
      clearInterval(timer);
      clearTimeout(kickoff);
      await inFlight; // drain any in-flight pass before the pool closes
    },
  };
}
