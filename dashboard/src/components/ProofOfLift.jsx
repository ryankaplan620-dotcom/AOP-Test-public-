/**
 * ProofOfLift.jsx — the "Proof of Lift" tab.
 *
 * Role in the AOP data flow: renders GET /analytics/lift — the observed
 * evidence that agent conversion is moving: weekly conversion series, an
 * exact split-half comparison (recent half of the window vs the baseline
 * half before it), and which loss reasons shrank or grew between halves.
 *
 * Honesty contract (mirrors the API): every number on this screen is an
 * observed count. When the baseline half cannot support a relative
 * comparison (no traffic, zero conversions) the API sends
 * conversion_lift_pct: null and this screen says "not enough baseline
 * data" — it never renders an invented percentage.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { fetchLift } from '../api.js';
import { formatCount, formatPct, lossReasonLabel } from '../format.js';

const POLL_MS = 60_000;
const WINDOWS = [14, 28, 56, 90];

function StatCard({ label, value, note, tone }) {
  return (
    <div className={`stat${tone ? ` ${tone}` : ''}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      <div className="note">{note}</div>
    </div>
  );
}

export default function ProofOfLift({ settings }) {
  const [days, setDays] = useState(56);
  const [lift, setLift] = useState(null);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      setLift(await fetchLift(settings, days));
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [settings, days]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const weekly = lift?.weekly ?? [];
  const maxImpressions = Math.max(1, ...weekly.map((w) => w.impressions));
  const liftPct = lift?.conversion_lift_pct;

  return (
    <div>
      {error ? <div className="error-banner">{error}</div> : null}

      <div className="controls">
        <label htmlFor="lift-window">Window</label>
        <select id="lift-window" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {WINDOWS.map((w) => (
            <option key={w} value={w}>
              Last {w} days
            </option>
          ))}
        </select>
      </div>

      <div className="panel">
        <h2>Proof of Lift</h2>
        <p className="sub">
          Observed agent conversion: the recent {lift?.recent_days ?? '…'} days vs the{' '}
          {lift?.baseline_days ?? '…'} days before them. Every figure is a counted event — nothing
          modeled or projected.
        </p>

        <div className="stat-grid">
          <StatCard
            label="Conversion Lift"
            value={
              liftPct === null || liftPct === undefined
                ? lift
                  ? 'n/a'
                  : '…'
                : `${liftPct > 0 ? '+' : ''}${liftPct}%`
            }
            note={
              liftPct === null && lift
                ? 'not enough baseline data for a relative comparison'
                : 'relative change in agent conversion rate'
            }
            tone={typeof liftPct === 'number' && liftPct < 0 ? 'losses' : undefined}
          />
          <StatCard
            label="Recent Conversion"
            value={lift ? formatPct(lift.recent.conversion_rate_pct) : '…'}
            note={
              lift
                ? `${formatCount(lift.recent.orders_won)} orders / ${formatCount(lift.recent.impressions)} impressions`
                : ''
            }
          />
          <StatCard
            label="Baseline Conversion"
            value={lift ? formatPct(lift.baseline.conversion_rate_pct) : '…'}
            note={
              lift
                ? `${formatCount(lift.baseline.orders_won)} orders / ${formatCount(lift.baseline.impressions)} impressions`
                : ''
            }
          />
        </div>
      </div>

      <div className="panel">
        <h2>Weekly conversion</h2>
        <p className="sub">Impressions per ISO week (bar) with the week&apos;s conversion rate.</p>
        {weekly.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Week of</th>
                <th className="num">Impressions</th>
                <th className="num">Won</th>
                <th className="num">Lost</th>
                <th className="num">Conversion</th>
                <th style={{ width: '30%' }} aria-label="impressions bar" />
              </tr>
            </thead>
            <tbody>
              {weekly.map((week) => (
                <tr key={week.week_start}>
                  <td>{week.week_start.slice(0, 10)}</td>
                  <td className="num">{formatCount(week.impressions)}</td>
                  <td className="num">{formatCount(week.orders_won)}</td>
                  <td className="num">{formatCount(week.losses)}</td>
                  <td className="num">{formatPct(week.conversion_rate_pct)}</td>
                  <td>
                    <div className="share-bar">
                      <div style={{ width: `${Math.min(100, (week.impressions / maxImpressions) * 100)}%` }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="sub">{lift ? 'No traffic in this window.' : 'Loading…'}</p>
        )}
      </div>

      <div className="panel">
        <h2>Loss-reason shifts</h2>
        <p className="sub">
          Losses per reason, recent half vs baseline half. Negative delta = fewer losses of that kind
          (improvement).
        </p>
        {lift && lift.reason_shifts.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Reason</th>
                <th className="num">Baseline</th>
                <th className="num">Recent</th>
                <th className="num">Delta</th>
              </tr>
            </thead>
            <tbody>
              {lift.reason_shifts.map((shift) => (
                <tr key={shift.reason}>
                  <td>{lossReasonLabel(shift.reason)}</td>
                  <td className="num">{formatCount(shift.baseline_count)}</td>
                  <td className="num">{formatCount(shift.recent_count)}</td>
                  <td className="num">
                    {shift.delta > 0 ? `+${formatCount(shift.delta)}` : formatCount(shift.delta)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="sub">{lift ? 'No losses recorded in this window.' : 'Loading…'}</p>
        )}
      </div>
    </div>
  );
}
