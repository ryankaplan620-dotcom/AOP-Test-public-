/**
 * DataOptimizer.jsx — the "Data Optimizer" tab (Sprint 6: the Semantic
 * Policy Rewriter surfaced in the app admin panel).
 *
 * Role in the AOP data flow: posts the merchant's raw policy text to the
 * optimizer microservice's /rewrite endpoint and renders the full result:
 * Agent Match Score + selection probability, applied deductions, ranked
 * optimization directives, the agent-parseable rewritten policy text, and
 * the copyable schema.org JSON-LD blocks (current + optimized).
 */

import React, { useState } from 'react';
import { rewritePolicy } from '../api.js';
import { formatPct } from '../format.js';

const SAMPLE_POLICY =
  'We charge a 15% restocking fee for items sent back. All sales are eligible ' +
  'for standard returns within 14 days of delivery. Orders typically process ' +
  'slowly and ship in 4-6 business days.';

function scoreTone(score) {
  if (score >= 80) return 'score-good';
  if (score >= 45) return 'score-mid';
  return 'score-bad';
}

function JsonLdBlock({ title, value }) {
  const [copied, setCopied] = useState(false);
  const text = JSON.stringify(value, null, 2);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (permissions) — the block is still selectable */
    }
  };
  return (
    <div>
      <h2>{title}</h2>
      <button className="btn" type="button" onClick={copy}>
        {copied ? 'Copied ✓' : 'Copy JSON-LD'}
      </button>
      <pre className="jsonld">{text}</pre>
    </div>
  );
}

export default function DataOptimizer({ settings }) {
  const [policyText, setPolicyText] = useState(SAMPLE_POLICY);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const runScan = async () => {
    if (!policyText.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await rewritePolicy(settings, policyText));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const artifact = result?.policy_jsonld;

  return (
    <div>
      {error ? (
        <div className="error-banner">
          Optimizer unreachable: {error} — is the optimizer microservice running? (Settings tab →
          Optimizer URL; start it with: python3 -m aop_optimizer.server)
        </div>
      ) : null}

      <div className="panel">
        <h2>Run AI Data Optimization Scan</h2>
        <p className="sub">
          Paste your store policy text exactly as agents see it (returns, shipping, warranty).
          The engine simulates an LLM buyer's evaluation and emits the exact rewrites needed to
          win future agent bids.
        </p>
        <textarea
          value={policyText}
          onChange={(e) => setPolicyText(e.target.value)}
          spellCheck={false}
          aria-label="store policy text"
        />
        <button className="btn" type="button" onClick={runScan} disabled={busy || !policyText.trim()}>
          {busy ? 'Scanning…' : 'Run AI Data Optimization Scan'}
        </button>
      </div>

      {result ? (
        <>
          <div className="panel">
            <h2>Agent Match Score</h2>
            <div className="score-row">
              <div className={`score-big ${scoreTone(result.agent_match_score)}`}>
                {result.agent_match_score}
                <span style={{ fontSize: '1rem', color: 'var(--muted)' }}> / 100</span>
              </div>
              <div>
                Selection probability vs. market baseline:{' '}
                <strong>{formatPct(result.selection_probability * 100)}</strong>
              </div>
            </div>
            {result.applied_deductions.length > 0 ? (
              <table>
                <thead>
                  <tr>
                    <th>Deduction</th>
                    <th className="num">Points</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {result.applied_deductions.map((deduction) => (
                    <tr key={deduction.code}>
                      <td>{deduction.code}</td>
                      <td className="num">-{deduction.points}</td>
                      <td>{deduction.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="sub">No deductions — this policy already parses clean for agents.</p>
            )}
          </div>

          {result.optimization_directives.length > 0 ? (
            <div className="panel">
              <h2>Optimization Directives</h2>
              <p className="sub">Exact semantic changes, ranked by recovered score.</p>
              {result.optimization_directives.map((directive) => (
                <div className="directive" key={directive.code}>
                  <div>
                    <strong>#{directive.priority}</strong> [{directive.field}] {directive.action}
                  </div>
                  <div className="gain">+{directive.projected_score_gain} pts projected</div>
                </div>
              ))}
            </div>
          ) : null}

          {artifact ? (
            <div className="panel">
              <h2>Semantic Policy Rewriter</h2>
              <p className="sub">
                Agent-parseable replacement policy text (verified to score 100 through the same
                engine):
              </p>
              <div className="rewrite-text">{artifact.rewritten_policy_text}</div>
              <p className="sub" style={{ marginTop: 14 }}>
                Publish the optimized JSON-LD only once your operations actually meet these terms
                — agents punish claims that checkout contradicts.
              </p>
              <JsonLdBlock title="Optimized policy (JSON-LD target)" value={artifact.optimized} />
              <JsonLdBlock title="Current policy (honest restatement)" value={artifact.current} />
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
