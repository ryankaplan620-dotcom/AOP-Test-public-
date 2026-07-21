/**
 * lib/digest.js — the weekly performance digest (PR13).
 *
 * Role in the AOP data flow:
 *   [repositories analytics reads] -> buildDigest() (THIS MODULE)
 *     -> GET /analytics/digest (on-demand, tenant-scoped)
 *     -> jobs/digest.js (weekly, POSTs the platform digest to
 *        DIGEST_WEBHOOK_URL — the operator wires that webhook to email,
 *        Slack, Zapier, whatever their stack delivers with)
 *
 * Honesty contract (mirrors /analytics/lift): every number is an observed
 * count from the ledger tables; conversion lift is raw-count math and null
 * when the prior week cannot support a comparison; money stays per-currency
 * with no cross-currency scalar totals; loss estimates render unlabeled.
 *
 * PURE composition: all queries go through the injected db handle via the
 * shared repository functions — no SQL of its own, no formatting locale
 * assumptions (ISO dates, plain decimal strings).
 */

import {
  getAnalyticsSummary,
  getLossReasonBreakdown,
  getLiftReport,
  getDeadLetterCount,
} from '../repositories.js';

/** The digest window: the product is a WEEKLY digest. */
export const DIGEST_WINDOW_DAYS = 7;

/**
 * Build the digest object for one scope.
 *
 * @param {object} db
 * @param {{merchantId?: string|null, scopeLabel?: string}} options
 *   merchantId null = platform-wide (includes the dead-letter ops alert);
 *   a merchant id scopes every read to that tenant (no ops internals).
 * @returns {Promise<object>} digest JSON (see shape below) — also carries a
 *   `text` rendering for webhook consumers that just forward plain text.
 */
export async function buildDigest(db, { merchantId = null, scopeLabel = null } = {}) {
  const windowDays = DIGEST_WINDOW_DAYS;
  const [summary, reasons, liftRaw, deadLetters] = await Promise.all([
    getAnalyticsSummary(db, { windowDays, merchantId }),
    getLossReasonBreakdown(db, { windowDays, merchantId }),
    // Lift over 14 days = this week vs last week (equal halves). Raw rows;
    // the rate/lift math below mirrors the /analytics/lift route exactly:
    // raw-count ratio, null when the prior week cannot support it.
    getLiftReport(db, { windowDays: 2 * windowDays, halfDays: windowDays, merchantId }),
    merchantId === null ? getDeadLetterCount(db, { windowDays }) : Promise.resolve(null),
  ]);

  const impThis = Number(liftRaw.split.imp_recent);
  const wonThis = Number(liftRaw.split.won_recent);
  const impLast = Number(liftRaw.split.imp_baseline);
  const wonLast = Number(liftRaw.split.won_baseline);
  const rate = (won, imp) => (imp > 0 ? Math.round((won / imp) * 1000) / 10 : 0);
  const liftPct =
    impLast > 0 && impThis > 0 && wonLast > 0
      ? Math.round(((wonThis / impThis) / (wonLast / impLast) - 1) * 1000) / 10
      : null;

  const digest = {
    kind: 'aop_weekly_digest',
    scope: merchantId === null ? 'platform' : 'merchant',
    scope_label: scopeLabel ?? (merchantId === null ? 'All merchants' : merchantId),
    window_days: windowDays,
    impressions: summary.impressions,
    orders_won: summary.orders_won,
    losses: summary.losses,
    // Per-currency money only — never summed across currencies.
    currencies: summary.currencies,
    estimated_losses: summary.estimated_losses,
    conversion: {
      this_week_pct: rate(wonThis, impThis),
      last_week_pct: rate(wonLast, impLast),
      lift_pct: liftPct, // null when unsupportable — never invented
    },
    top_loss_reasons: reasons.slice(0, 3),
    // Platform ops alert; null (not 0) on merchant scope.
    dead_letters: deadLetters,
  };
  digest.text = renderDigestText(digest);
  return digest;
}

/**
 * Plain-text rendering for webhook/email forwarding. Deterministic, no
 * locale formatting, states "n/a" instead of inventing a number.
 *
 * @param {object} digest
 * @returns {string}
 */
export function renderDigestText(digest) {
  const lines = [
    `AOP weekly digest — ${digest.scope_label} (last ${digest.window_days} days)`,
    `Agent impressions: ${digest.impressions}`,
    `Orders won: ${digest.orders_won}   Losses: ${digest.losses}`,
    `Conversion: ${digest.conversion.this_week_pct}% (last week ${digest.conversion.last_week_pct}%` +
      (digest.conversion.lift_pct === null
        ? ', lift n/a)'
        : `, lift ${digest.conversion.lift_pct > 0 ? '+' : ''}${digest.conversion.lift_pct}%)`),
  ];
  for (const c of digest.currencies ?? []) {
    lines.push(`${c.currency}: net GMV ${c.net_gmv}, net commission ${c.net_commission} (${c.orders} orders)`);
  }
  if ((digest.top_loss_reasons ?? []).length > 0) {
    lines.push(
      'Top loss reasons: ' +
        digest.top_loss_reasons.map((r) => `${r.reason} (${r.count})`).join(', ')
    );
  } else {
    lines.push('Top loss reasons: none recorded');
  }
  if (digest.dead_letters !== null && digest.dead_letters !== undefined) {
    lines.push(
      digest.dead_letters > 0
        ? `ALERT: ${digest.dead_letters} telemetry record(s) dead-lettered this week — inspect dead_letter_telemetry.`
        : 'Telemetry pipeline: no dead letters this week.'
    );
  }
  return lines.join('\n');
}
