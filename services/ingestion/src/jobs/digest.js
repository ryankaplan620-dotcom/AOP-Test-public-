/**
 * jobs/digest.js — weekly digest delivery (PR13).
 *
 * Role in the AOP data flow:
 *   Every DIGEST_CHECK_INTERVAL the job asks "is a digest due?" against a
 *   durable watermark (sweep_state 'digest_last_sent', migration 0012's
 *   table) and, when DIGEST_INTERVAL_MS has elapsed, builds the platform
 *   digest (lib/digest.js) and POSTs it to DIGEST_WEBHOOK_URL. The operator
 *   points that webhook wherever their stack delivers — an email bridge,
 *   Slack, Zapier — so this service stays SMTP-free and dependency-free.
 *
 * Resilience contract (mirrors the sweeps):
 *   - OPTIONAL feature: no DIGEST_WEBHOOK_URL -> the job never starts.
 *   - Advisory lock (815003) so scaled-out replicas send ONE digest.
 *   - Durable watermark: restarts/redeploys never double-send; the check
 *     interval only polls "is it due yet?" — the cadence itself is
 *     DIGEST_INTERVAL_MS (default 7 days).
 *   - The watermark advances ONLY after a 2xx from the webhook; a failed
 *     delivery retries on the next check tick.
 *   - Never throws; stop() is awaitable for graceful shutdown.
 */

import { buildDigest } from '../lib/digest.js';
import { getSweepWatermark, setSweepWatermark } from '../repositories.js';

/** Advisory-lock key (unique among AOP jobs: 815001 loss, 815002 retention). */
export const DIGEST_LOCK_KEY = 815003;

/** sweep_state.job_name key for the last successful delivery. */
export const DIGEST_JOB_NAME = 'digest_last_sent';

/** How often the job CHECKS whether a digest is due (not the send cadence). */
export const DIGEST_CHECK_INTERVAL_MS = 15 * 60 * 1000;

/** Webhook POST timeout: a hung endpoint must not pin the job. */
const WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * Start the digest job. Returns a no-op handle when the feature is off.
 *
 * @param {{db: object, config: {digestWebhookUrl: string|null,
 *   digestIntervalMs: number}, logger: object}} deps
 * @returns {{stop: () => Promise<void>, runOnce: () => Promise<object>}}
 */
export function startDigestJob({ db, config, logger }) {
  if (!config.digestWebhookUrl) {
    logger.info('digest job disabled (DIGEST_WEBHOOK_URL not configured)');
    return { runOnce: async () => ({ sent: false, reason: 'disabled' }), stop: async () => {} };
  }

  let running = false;
  let stopped = false;
  let inFlight = Promise.resolve();
  // Abort handle for the in-flight webhook POST: stop() must not wait out a
  // hung endpoint (the 10s webhook timeout equals the process's entire
  // graceful-shutdown budget). An aborted send never advanced the
  // watermark, so it is simply retried after restart — the same asymmetric
  // choice as a failed watermark write: a rare duplicate beats a lost week.
  let webhookAbort = null;

  const withLock =
    typeof db.withAdvisoryLock === 'function'
      ? (fn) => db.withAdvisoryLock(DIGEST_LOCK_KEY, fn)
      : async (fn) => ({ ran: true, result: await fn() });

  /** One pass: due-check -> build -> deliver -> advance watermark. */
  async function digestPass() {
    // Due check against the DURABLE watermark (null = never sent -> due).
    let lastSent = null;
    try {
      const stored = await getSweepWatermark(db, DIGEST_JOB_NAME);
      if (stored !== null) {
        const ms = Date.parse(stored instanceof Date ? stored.toISOString() : String(stored));
        if (Number.isFinite(ms)) lastSent = ms;
      }
    } catch (err) {
      // Watermark unreadable: DO NOT send (an unreadable watermark plus a
      // send would risk double delivery on flapping DBs) — retry next tick.
      logger.warn('digest watermark unavailable; skipping this check', { err });
      return { sent: false, reason: 'watermark_unavailable' };
    }
    if (lastSent !== null && Date.now() - lastSent < config.digestIntervalMs) {
      return { sent: false, reason: 'not_due' };
    }

    let digest;
    try {
      digest = await buildDigest(db, { merchantId: null });
    } catch (err) {
      logger.error('digest build failed; will retry next check', { err });
      return { sent: false, reason: 'build_failed' };
    }

    // One controller serves both the timeout and shutdown abort.
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutTimer = controller ? setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS) : null;
    timeoutTimer?.unref?.();
    webhookAbort = controller;
    // stop() may have landed while this pass was still in its DB phase —
    // webhookAbort was null then, so its abort() was a no-op, and starting
    // a webhook POST now would outlive shutdown (the 10s webhook timeout
    // IS the whole watchdog budget). Assign the controller FIRST, then
    // re-check: whichever way stop() interleaves, either this check sees
    // `stopped` or stop() sees the controller.
    if (stopped) {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      webhookAbort = null;
      return { sent: false, reason: 'stopping' };
    }
    try {
      const response = await fetch(config.digestWebhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(digest),
        signal: controller?.signal,
      });
      if (!response.ok) {
        logger.error('digest webhook rejected delivery; will retry next check', {
          status: response.status,
        });
        return { sent: false, reason: `webhook_${response.status}` };
      }
    } catch (err) {
      logger.error('digest webhook unreachable; will retry next check', { err });
      return { sent: false, reason: 'webhook_unreachable' };
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      webhookAbort = null;
    }

    // Delivery confirmed -> advance the watermark. If THIS write fails the
    // worst case is one duplicate digest next tick — preferable to silently
    // never retrying a failed delivery (the asymmetric cost).
    try {
      await setSweepWatermark(db, DIGEST_JOB_NAME, new Date().toISOString());
    } catch (err) {
      logger.warn('digest sent but watermark write failed (may re-send next tick)', { err });
    }
    logger.info('weekly digest delivered', { webhook: true });
    return { sent: true };
  }

  async function runOnce() {
    try {
      const { ran, result } = await withLock(digestPass);
      if (!ran) return { sent: false, reason: 'lock_held_elsewhere' };
      return result;
    } catch (err) {
      logger.error('digest job could not acquire/release the advisory lock', { err });
      return { sent: false, reason: 'lock_error' };
    }
  }

  function tick() {
    if (running || stopped) return;
    running = true;
    inFlight = runOnce()
      .catch((err) => logger.error('digest tick crashed unexpectedly', { err }))
      .finally(() => {
        running = false;
      });
  }

  const timer = setInterval(tick, DIGEST_CHECK_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  tick(); // catch up immediately after a restart

  logger.info('digest job started', {
    interval_ms: config.digestIntervalMs,
    check_interval_ms: DIGEST_CHECK_INTERVAL_MS,
  });

  return {
    runOnce,
    async stop() {
      stopped = true;
      clearInterval(timer);
      // Cut a hung webhook POST loose instead of pinning shutdown on it.
      webhookAbort?.abort();
      await inFlight;
      logger.info('digest job stopped');
    },
  };
}
