/**
 * Simulator.jsx — the Pricing & Policy What-If Simulator tab.
 *
 * Role in the AOP data flow: posts policy text to the optimizer service's
 * /simulate endpoint and renders the baseline Agent Match Score alongside a
 * ranked table of counterfactual scenarios (extend returns, guarantee faster
 * shipping, drop each penalty clause, free shipping, and the all-at-once
 * ceiling) — each with the score and selection-probability lift it would
 * produce. This is the product's "run what-if models before you change real
 * operations" lever.
 */

import React, { useState } from 'react';
import { simulatePolicy } from '../api.js';
import { formatPct } from '../format.js';

const SAMPLE_POLICY =
  'We charge a 15% restocking fee for items sent back. All sales are eligible ' +
  'for standard returns within 14 days of delivery. Orders typically process ' +
  'slowly and ship in 4-6 business days.';

function deltaTone(delta) {
  if (delta > 0) return 'score-good';
  if (delta < 0) return 'score-bad';
  return '';
}

export default function Simulator({ settings }) {
  const [policyText, setPolicyText] = useState(SAMPLE_POLICY);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const runSimulation = async () => {
    if (!policyText.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await simulatePolicy(settings, policyText));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {error ? (
        <div className="error-banner">
          Simulator unreachable: {error} — is the optimizer microservice running? (Settings tab →
          Optimizer URL; start it with: python3 -m aop_optimizer.server)
        </div>
      ) : null}

      <div className="panel">
        <h2>Pricing &amp; Policy What-If Simulator</h2>
        <p className="sub">
          Model how a policy change would move your selection probability with AI shopping agents
          — before you change real operations. Paste your current policy and run the scenarios.
        </p>
        <textarea
          value={policyText}
          onChange={(e) => setPolicyText(e.target.value)}
          spellCheck={false}
          aria-label="store policy text"
        />
        <button className="btn" type="button" onClick={runSimulation} disabled={busy || !policyText.trim()}>
          {busy ? 'Simulating…' : 'Run What-If Simulation'}
        </button>
      </div>

      {result ? (
        <div className="panel">
          <h2>Scenarios</h2>
          <div className="score-row">
            <div>
              Baseline: <strong className="score-big" style={{ fontSize: '1.6rem' }}>
                {result.baseline.agent_match_score}
              </strong>
              <span style={{ color: 'var(--muted)' }}> / 100</span>
            </div>
            <div>
              Baseline selection probability:{' '}
              <strong>{formatPct(result.baseline.selection_probability * 100)}</strong>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Scenario</th>
                <th>Change</th>
                <th className="num">New Score</th>
                <th className="num">Score Δ</th>
                <th className="num">Selection Prob.</th>
                <th className="num">Prob. Δ</th>
              </tr>
            </thead>
            <tbody>
              {result.scenarios.map((scenario) => (
                <tr
                  key={scenario.code}
                  style={scenario.code === 'FULLY_OPTIMIZED' ? { borderTop: '2px solid var(--accent)' } : undefined}
                >
                  <td>{scenario.description}</td>
                  <td style={{ color: 'var(--muted)', fontSize: '0.78rem' }}>
                    {scenario.changes.join(', ')}
                  </td>
                  <td className="num">{scenario.agent_match_score}</td>
                  <td className={`num ${deltaTone(scenario.score_delta)}`}>
                    {scenario.score_delta > 0 ? '+' : ''}
                    {scenario.score_delta}
                  </td>
                  <td className="num">{formatPct(scenario.selection_probability * 100)}</td>
                  <td className={`num ${deltaTone(scenario.probability_delta)}`}>
                    {scenario.probability_delta > 0 ? '+' : ''}
                    {formatPct(scenario.probability_delta * 100)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="sub" style={{ marginTop: 12 }}>
            Scenarios are ranked by score lift; the final row applies every change at once (the
            achievable ceiling).
          </p>
        </div>
      ) : null}
    </div>
  );
}
