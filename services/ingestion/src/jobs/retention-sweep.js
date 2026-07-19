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

/** Rows deleted per inner purge transaction (see purge_expired_telemetry). */
const PURGE_BATCH_SIZE = 10_000;

export function startRetentionSweep({ db, config, logger }) {
  let running = false; // overlap guard
  let stopped = false;
  let inFlight = Promise.resolve();

  async function runOnce() {
    const summary = { intents_deleted: 0, failed: false };
    try {
      const result = await db.query('SELECT * FROM purge_expired_telemetry($1, $2)', [
        config.retentionDays,
        PURGE_BATCH_SIZE,
      ]);
      summary.intents_deleted = Number(result.rows[0]?.intents_deleted ?? 0);
      if (summary.intents_deleted > 0) {
        logger.info('retention purge completed', {
          intents_deleted: summary.intents_deleted,
          retention_days: config.retentionDays,
        });
      }
    } catch (err) {
      // DB down or migration 0006 not applied — log loudly, retry next tick.
      // The cap is a compliance obligation: silence here would hide drift.
      summary.failed = true;
      logger.error('retention purge failed; will retry next tick', { err });
    }
    return summary;
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
