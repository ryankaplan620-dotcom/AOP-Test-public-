/**
 * AgentTraffic.jsx — the "Agent Traffic" tab (Context Reconstruction).
 *
 * Role in the AOP data flow: renders GET /analytics/traffic — which agent
 * protocols are probing the store, which prompt categories drive that
 * traffic (classified at ingest by lib/intent-classifier.js), and the
 * most-probed SKUs. This is the "which buying moments is my catalog being
 * evaluated for?" screen from the product wireframe's tab bar.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { fetchTraffic } from '../api.js';
import { formatCount, formatPct } from '../format.js';

const POLL_MS = 30_000;

/** Human labels for the intent taxonomy (raw code passes through for novel values). */
const INTENT_LABELS = {
  GIFT_URGENT: 'Urgent gift',
  GIFT: 'Gift shopping',
  PRICE_SENSITIVE: 'Price-sensitive',
  ECO_CONSCIOUS: 'Eco-conscious',
  QUALITY_FOCUSED: 'Quality-focused',
  REPLENISHMENT: 'Replenishment',
  RESEARCH: 'Research / comparison',
  UNCLASSIFIED: 'Context seen, unclassified',
};

function ShareTable({ title, sub, rows, labelKey, labelMap, countKey }) {
  return (
    <div className="panel">
      <h2>{title}</h2>
      <p className="sub">{sub}</p>
      {rows && rows.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>{title.split(' ')[0]}</th>
              <th className="num">Count</th>
              <th className="num">Share</th>
              <th style={{ width: '35%' }} aria-label="share bar" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row[labelKey]}>
                <td>{labelMap ? labelMap[row[labelKey]] ?? row[labelKey] : row[labelKey]}</td>
                <td className="num">{formatCount(row[countKey])}</td>
                <td className="num">{formatPct(row.share_pct)}</td>
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
        <p className="sub">{rows ? 'No data in this window.' : 'Loading…'}</p>
      )}
    </div>
  );
}

export default function AgentTraffic({ settings }) {
  const [days, setDays] = useState(7);
  const [traffic, setTraffic] = useState(null);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      setTraffic(await fetchTraffic(settings, days));
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

  return (
    <div>
      {error ? (
        <div className="error-banner">
          Analytics unavailable: {error} — check the Settings tab. Showing last known data.
        </div>
      ) : null}

      <div className="controls">
        <label htmlFor="traffic-window">Window</label>
        <select id="traffic-window" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={1}>Last 24 hours</option>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>

      <ShareTable
        title="Protocol share"
        sub="Which agent-commerce protocols are probing your storefront."
        rows={traffic?.protocols}
        labelKey="protocol"
        countKey="count"
      />

      <ShareTable
        title="Prompt categories"
        sub='Context Reconstruction: the buying moments behind agent probes ("urgent anniversary gift", "cheapest eco-friendly …"), classified at ingest.'
        rows={traffic?.intent_categories}
        labelKey="category"
        labelMap={INTENT_LABELS}
        countKey="count"
      />

      <div className="panel">
        <h2>Most-probed SKUs</h2>
        <p className="sub">Where agent attention concentrates — the catalog entries agents evaluate most.</p>
        {traffic && traffic.top_skus.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Rank</th>
                <th>SKU</th>
                <th className="num">Probes</th>
              </tr>
            </thead>
            <tbody>
              {traffic.top_skus.map((row, index) => (
                <tr key={row.sku}>
                  <td>{String(index + 1).padStart(2, '0')}</td>
                  <td>{row.sku}</td>
                  <td className="num">{formatCount(row.probes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="sub">{traffic ? 'No probes in this window.' : 'Loading…'}</p>
        )}
      </div>
    </div>
  );
}
