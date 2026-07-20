/**
 * Billing.jsx — monthly commission statements.
 *
 * Role in the AOP data flow: renders GET /analytics/billing — statement
 * lines per (merchant, currency) for one calendar month: orders reconciled,
 * GMV, the 0.5% commission computed by the database's generated column,
 * minus refund/cancellation credits from the order_adjustments ledger —
 * plus per-currency totals. The numbers here ARE the billing truth: they
 * aggregate schema-generated commission_fee/commission_credit columns,
 * which no application code can write directly.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchBilling } from '../api.js';
import { formatCount, formatMoney } from '../format.js';

/** Last 12 months (UTC) for the picker, newest first. */
function recentMonths() {
  const months = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return months;
}

export default function Billing({ settings }) {
  const [month, setMonth] = useState(recentMonths()[0]);
  const [statement, setStatement] = useState(null);
  const [error, setError] = useState(null);
  // Stale-response guard: switching months fires overlapping fetches, and a
  // slow older response must never overwrite a newer selection's data (this
  // tab has no poll to self-heal — the wrong statement would stick).
  const requestSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const next = await fetchBilling(settings, month);
      if (seq !== requestSeq.current) return; // superseded by a newer request
      setStatement(next);
      setError(null);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setError(err.message);
    }
  }, [settings, month]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Older (pre-adjustments) services return totals as an OBJECT; rendering
  // must tolerate both shapes rather than blank-page the whole SPA on .map.
  const totals = Array.isArray(statement?.totals) ? statement.totals : [];

  return (
    <div>
      {error ? (
        <div className="error-banner">
          Analytics unavailable: {error} — check the Settings tab. Showing last known data.
        </div>
      ) : null}

      <div className="controls">
        <label htmlFor="billing-month">Statement month</label>
        <select id="billing-month" value={month} onChange={(e) => setMonth(e.target.value)}>
          {recentMonths().map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      <div className="panel">
        <h2>Commission statement — {statement?.month ?? month}</h2>
        <p className="sub">
          Flat 0.5% of reconciled agent-driven GMV, computed by the database schema (generated
          columns), net of refund/cancellation credits — these figures are the billing source of
          truth. Lines are per merchant per currency; different currencies never sum together.
        </p>
        {statement && statement.lines.length > 0 ? (
          <>
            <table>
              <thead>
                <tr>
                  <th>Merchant</th>
                  <th>Currency</th>
                  <th className="num">Orders</th>
                  <th className="num">Gross GMV</th>
                  <th className="num">Refunded</th>
                  <th className="num">Rate</th>
                  <th className="num">Commission</th>
                  <th className="num">Credits</th>
                  <th className="num">Net commission</th>
                </tr>
              </thead>
              <tbody>
                {statement.lines.map((line) => (
                  <tr key={`${line.merchant_id}:${line.currency}`}>
                    <td>{line.shop_domain}</td>
                    <td>{line.currency}</td>
                    <td className="num">{formatCount(line.orders)}</td>
                    <td className="num">{formatMoney(line.gmv, line.currency)}</td>
                    <td className="num">{formatMoney(line.adjusted_gmv, line.currency)}</td>
                    <td className="num">
                      {line.min_rate === null
                        ? '—'
                        : line.min_rate === line.max_rate
                          ? `${(Number(line.min_rate) * 100).toFixed(2)}%`
                          : `${(Number(line.min_rate) * 100).toFixed(2)}–${(Number(line.max_rate) * 100).toFixed(2)}%`}
                    </td>
                    <td className="num">{formatMoney(line.commission, line.currency)}</td>
                    <td className="num">{formatMoney(line.commission_credits, line.currency)}</td>
                    <td className="num" style={{ fontWeight: 700 }}>
                      {formatMoney(line.net_commission, line.currency)}
                    </td>
                  </tr>
                ))}
                {totals.map((total) => (
                  <tr
                    key={`total:${total.currency}`}
                    style={{ borderTop: '2px solid var(--accent)', fontWeight: 700 }}
                  >
                    <td>Total</td>
                    <td>{total.currency}</td>
                    <td className="num">{formatCount(total.orders)}</td>
                    <td className="num">{formatMoney(total.gmv, total.currency)}</td>
                    <td className="num">{formatMoney(total.adjusted_gmv, total.currency)}</td>
                    <td className="num" />
                    <td className="num">{formatMoney(total.commission, total.currency)}</td>
                    <td className="num">{formatMoney(total.commission_credits, total.currency)}</td>
                    <td className="num">{formatMoney(total.net_commission, total.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <p className="sub">
            {statement ? 'No reconciled agent orders in this month.' : 'Loading…'}
          </p>
        )}
      </div>
    </div>
  );
}
