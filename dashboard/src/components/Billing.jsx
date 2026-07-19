/**
 * Billing.jsx — monthly commission statements.
 *
 * Role in the AOP data flow: renders GET /analytics/billing — per-merchant
 * statement lines for one calendar month (orders reconciled, GMV, the 0.5%
 * commission computed by the database's generated column) plus totals. The
 * numbers here ARE the billing truth: they aggregate
 * reconciled_agent_orders.commission_fee, which no application code can
 * write directly.
 */

import React, { useCallback, useEffect, useState } from 'react';
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

  const refresh = useCallback(async () => {
    try {
      setStatement(await fetchBilling(settings, month));
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [settings, month]);

  useEffect(() => {
    refresh();
  }, [refresh]);

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
          column) — these figures are the billing source of truth.
        </p>
        {statement && statement.lines.length > 0 ? (
          <>
            <table>
              <thead>
                <tr>
                  <th>Merchant</th>
                  <th className="num">Orders</th>
                  <th className="num">Reconciled GMV</th>
                  <th className="num">Rate</th>
                  <th className="num">Commission</th>
                </tr>
              </thead>
              <tbody>
                {statement.lines.map((line) => (
                  <tr key={line.merchant_id}>
                    <td>{line.shop_domain}</td>
                    <td className="num">{formatCount(line.orders)}</td>
                    <td className="num">{formatMoney(line.gmv)}</td>
                    <td className="num">
                      {line.min_rate === line.max_rate
                        ? `${(Number(line.min_rate) * 100).toFixed(2)}%`
                        : `${(Number(line.min_rate) * 100).toFixed(2)}–${(Number(line.max_rate) * 100).toFixed(2)}%`}
                    </td>
                    <td className="num">{formatMoney(line.commission)}</td>
                  </tr>
                ))}
                <tr style={{ borderTop: '2px solid var(--accent)', fontWeight: 700 }}>
                  <td>Total</td>
                  <td className="num">{formatCount(statement.totals.orders)}</td>
                  <td className="num">{formatMoney(statement.totals.gmv)}</td>
                  <td className="num" />
                  <td className="num">{formatMoney(statement.totals.commission)}</td>
                </tr>
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
