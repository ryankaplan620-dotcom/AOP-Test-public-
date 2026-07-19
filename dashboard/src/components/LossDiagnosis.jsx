/**
 * LossDiagnosis.jsx — the dashboard's core screen (product wireframe:
 * "Agent Loss Diagnosis").
 *
 * Role in the AOP data flow: renders the three /analytics reads —
 * summary stat cards + critical drop-off callout, the ranked loss-reason
 * table, and the interleaved WON/LOST live stream (polled).
 *
 * Polling model: summary/reasons refresh on window change and every 30s;
 * the activity stream every 5s (it is the "live" element of the wireframe).
 * A failed poll surfaces one banner and keeps the last good data on screen
 * — an analytics blip must never blank the merchant's numbers.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchSummary, fetchLossReasons, fetchActivity, fetchBenchmark } from '../api.js';
import { formatMoney, formatCount, formatPct, formatClock, lossReasonLabel } from '../format.js';

const SUMMARY_POLL_MS = 30_000;
const ACTIVITY_POLL_MS = 5_000;

function StatCard({ label, value, note, tone }) {
  return (
    <div className={`stat ${tone ?? ''}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {note ? <div className="note">{note}</div> : null}
    </div>
  );
}

export default function LossDiagnosis({ settings }) {
  const [days, setDays] = useState(7);
  const [summary, setSummary] = useState(null);
  const [reasons, setReasons] = useState(null);
  const [benchmark, setBenchmark] = useState(null);
  const [activity, setActivity] = useState(null);
  // SEPARATE error states: the 5s activity poller and the 30s headline
  // poller must not share one — a healthy activity poll would wipe the
  // banner within 5s while summary/reasons are still failing.
  const [headlineError, setHeadlineError] = useState(null);
  const [activityError, setActivityError] = useState(null);
  // Stale-response guard for window changes (24h -> 90d etc.).
  const headlineSeq = useRef(0);

  const refreshHeadline = useCallback(async () => {
    const seq = ++headlineSeq.current;
    // allSettled, not all: each endpoint lands independently. The benchmark
    // panel is auxiliary — its failure must never blank the summary cards
    // and loss-reasons table (previously a benchmark-only outage left the
    // whole screen at 'Loading…' forever).
    const [s, r, b] = await Promise.allSettled([
      fetchSummary(settings, days),
      fetchLossReasons(settings, days),
      fetchBenchmark(settings, days),
    ]);
    if (seq !== headlineSeq.current) return; // superseded by a newer window
    if (s.status === 'fulfilled') setSummary(s.value);
    if (r.status === 'fulfilled') setReasons(r.value);
    if (b.status === 'fulfilled') setBenchmark(b.value);
    const firstFailure = [s, r, b].find((outcome) => outcome.status === 'rejected');
    setHeadlineError(firstFailure ? firstFailure.reason?.message ?? 'request failed' : null);
  }, [settings, days]);

  const refreshActivity = useCallback(async () => {
    try {
      const a = await fetchActivity(settings, 50);
      setActivity(a);
      setActivityError(null);
    } catch (err) {
      setActivityError(err.message);
    }
  }, [settings]);

  useEffect(() => {
    refreshHeadline();
    const timer = setInterval(refreshHeadline, SUMMARY_POLL_MS);
    return () => clearInterval(timer);
  }, [refreshHeadline]);

  useEffect(() => {
    refreshActivity();
    const timer = setInterval(refreshActivity, ACTIVITY_POLL_MS);
    return () => clearInterval(timer);
  }, [refreshActivity]);

  return (
    <div>
      {headlineError || activityError ? (
        <div className="error-banner">
          Analytics unavailable: {headlineError ?? activityError} — check the Settings tab (URL +
          token). Showing last known data.
        </div>
      ) : null}

      <div className="controls">
        <label htmlFor="window-select">Window</label>
        <select id="window-select" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={1}>Last 24 hours</option>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>

      <div className="stat-grid">
        <StatCard
          label="Total Agent Impressions"
          value={summary ? formatCount(summary.impressions) : '…'}
          note="intent pings via edge proxy"
        />
        <StatCard
          label="Reconciled Orders Won"
          value={summary ? formatCount(summary.orders_won) : '…'}
          note={
            summary
              ? `Conv. rate: ${formatPct(summary.conversion_rate_pct)}` +
                // Per-currency net GMV — currencies never sum together, so a
                // multi-currency window renders one figure per currency.
                ((summary.currencies ?? []).length > 0
                  ? ` · Net GMV ${(summary.currencies ?? [])
                      .map((c) => formatMoney(c.net_gmv, c.currency))
                      .join(' + ')}`
                  : '') +
                (summary.adjustments > 0 ? ` (${formatCount(summary.adjustments)} refunds/cancels)` : '')
              : ''
          }
        />
        <StatCard
          label="Estimated Losses"
          // Heuristic estimate with no currency evidence — plain number, no
          // currency symbol (a wrong "$" would be fabrication).
          value={summary ? formatMoney(summary.estimated_losses, null) : '…'}
          note={summary ? `${formatCount(summary.losses)} lost intents (est., merchant currency)` : ''}
          tone="losses"
        />
      </div>

      {summary?.critical_dropoff ? (
        <div className="panel dropoff">
          <h2>Critical Drop-off Analysis</h2>
          <p className="headline">
            [!] {formatPct(summary.critical_dropoff.share_pct)} of agent drop-offs occurred during
            the '{summary.critical_dropoff.phase}' phase.
          </p>
          <p className="sub">
            Run the Data Optimizer scan to get the exact semantic changes that recover these
            losses.
          </p>
        </div>
      ) : null}

      <div className="panel">
        <h2>Top Reasons for Lost Agent Sales</h2>
        <p className="sub">Why autonomous AI buyers chose your competitors over your storefront.</p>
        {reasons && reasons.reasons.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Rank</th>
                <th>Reason</th>
                <th className="num">Share</th>
                <th className="num">Est. Revenue Lost</th>
                <th style={{ width: '30%' }} aria-label="share bar" />
              </tr>
            </thead>
            <tbody>
              {reasons.reasons.map((row, index) => (
                <tr key={row.reason}>
                  <td>{String(index + 1).padStart(2, '0')}</td>
                  <td>{lossReasonLabel(row.reason)}</td>
                  <td className="num">{formatPct(row.share_pct)}</td>
                  <td className="num">{formatMoney(row.estimated_revenue_lost, null)}</td>
                  <td>
                    <div className="share-bar">
                      <div style={{ width: `${Math.min(100, row.share_pct)}%` }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="sub">{reasons ? 'No losses recorded in this window.' : 'Loading…'}</p>
        )}
      </div>

      {benchmark && benchmark.price_losses > 0 ? (
        <div className="panel">
          <h2>Competitive Price Benchmark</h2>
          <p className="sub">
            When agents chose a competitor on price, you were undercut by an average of{' '}
            <strong>{formatMoney(benchmark.avg_undercut, null)}</strong> (your avg{' '}
            {formatMoney(benchmark.avg_our_price, null)} vs. their {formatMoney(benchmark.avg_competitor_price, null)}) —{' '}
            {formatMoney(benchmark.revenue_lost, null)} of walked-away baskets across{' '}
            {formatCount(benchmark.price_losses)} losses. Reprice worklist, biggest impact first:
          </p>
          <table>
            <thead>
              <tr>
                <th>SKU</th>
                <th className="num">Price Losses</th>
                <th className="num">Your Avg Price</th>
                <th className="num">Competitor Avg</th>
                <th className="num">Avg Undercut</th>
                <th className="num">Revenue Lost</th>
              </tr>
            </thead>
            <tbody>
              {benchmark.by_sku.map((row) => (
                <tr key={row.sku}>
                  <td>{row.sku}</td>
                  <td className="num">{formatCount(row.losses)}</td>
                  <td className="num">{formatMoney(row.avg_our_price, null)}</td>
                  <td className="num">{formatMoney(row.avg_competitor_price, null)}</td>
                  <td className="num" style={{ color: 'var(--lost)' }}>
                    -{formatMoney(row.avg_undercut, null)}
                  </td>
                  <td className="num">{formatMoney(row.revenue_lost, null)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="panel">
        <h2>Recent Loss Logs (Live Stream)</h2>
        <p className="sub">Interleaved agent outcomes, newest first — refreshes every 5 seconds.</p>
        {activity && activity.events.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Agent Protocol</th>
                <th>Target SKU</th>
                <th>Outcome</th>
                <th>Primary Trigger</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {activity.events.map((event, index) => (
                <tr key={`${event.occurred_at}-${index}`}>
                  <td>{formatClock(event.occurred_at)}</td>
                  <td>{event.protocol}</td>
                  <td>{event.target_sku}</td>
                  <td className={`outcome-${event.outcome}`}>{event.outcome}</td>
                  <td>{lossReasonLabel(event.detail)}</td>
                  {/* WON rows carry the order currency; LOST rows are
                      currency-less estimates and render unlabeled. */}
                  <td className="num">{formatMoney(event.amount, event.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="sub">{activity ? 'No agent activity yet.' : 'Loading…'}</p>
        )}
      </div>
    </div>
  );
}
