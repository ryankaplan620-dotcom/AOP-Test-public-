/**
 * ClaimInjector.jsx — the Structured Claim Injector section (Data Optimizer
 * tab; spec feature C, "Agent SEO").
 *
 * Role in the AOP data flow: posts a raw product record to the optimizer
 * service's /claims endpoint and renders the audit — which agent-favored
 * claim classes (precise dimensions, certifications, durability, GTIN, ...)
 * are present vs. missing — plus the copyable schema.org Product JSON-LD
 * with every verified claim injected, and directives for the gaps.
 *
 * Honesty note surfaced in the UI: the injector structures facts found in
 * the merchant's own data; it never invents claims.
 */

import React, { useState } from 'react';
import { auditClaims } from '../api.js';

const SAMPLE_PRODUCT = JSON.stringify(
  {
    title: 'Red Thread Sweater',
    sku: 'RT-SWTR-RD',
    description:
      'GOTS certified organic cotton, made in Portugal. Comes with a 5-year warranty.',
    dimensions: { width: 55, height: 70, unit: 'cm' },
    material: '100% organic cotton',
    weight: 0.4,
    weight_unit: 'kg',
    gtin: '0012345678905',
  },
  null,
  2,
);

const CLAIM_LABELS = {
  PRECISE_DIMENSIONS: 'Precise dimensions',
  WEIGHT: 'Shipping weight',
  MATERIALS: 'Material composition',
  CERTIFICATIONS: 'Third-party certifications',
  DURABILITY: 'Durability / warranty',
  IDENTIFIER_GTIN: 'GTIN / barcode',
  COUNTRY_OF_ORIGIN: 'Country of origin',
};

export default function ClaimInjector({ settings }) {
  const [productJson, setProductJson] = useState(SAMPLE_PRODUCT);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  const runAudit = async () => {
    if (busy) return;
    let product;
    try {
      product = JSON.parse(productJson);
    } catch {
      setError('Product data must be valid JSON');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setResult(await auditClaims(settings, product));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const copyJsonLd = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(result.product_jsonld, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — block is still selectable */
    }
  };

  return (
    <div className="panel">
      <h2>Structured Claim Injector</h2>
      <p className="sub">
        Paste a product record (JSON). The injector audits the structural signals agents favor
        and emits a schema.org Product block with every <em>verified</em> claim injected — it
        structures your existing facts, it never invents them.
      </p>
      {error ? <div className="error-banner">{error}</div> : null}
      <textarea
        value={productJson}
        onChange={(e) => setProductJson(e.target.value)}
        spellCheck={false}
        style={{ minHeight: 180 }}
        aria-label="product record JSON"
      />
      <button className="btn" type="button" onClick={runAudit} disabled={busy}>
        {busy ? 'Auditing…' : 'Run Claims Audit'}
      </button>

      {result ? (
        <>
          <div className="score-row">
            <div
              className={`score-big ${result.claims_score >= 80 ? 'score-good' : result.claims_score >= 45 ? 'score-mid' : 'score-bad'}`}
            >
              {result.claims_score}
              <span style={{ fontSize: '1rem', color: 'var(--muted)' }}> / 100</span>
            </div>
            <div>structural-claims completeness</div>
          </div>

          <table>
            <thead>
              <tr>
                <th>Claim</th>
                <th>Status</th>
                <th>Detected</th>
                <th className="num">Weight</th>
              </tr>
            </thead>
            <tbody>
              {result.audit.map((row) => (
                <tr key={row.claim}>
                  <td>{CLAIM_LABELS[row.claim] ?? row.claim}</td>
                  <td className={row.status === 'present' ? 'outcome-WON' : 'outcome-LOST'}>
                    {row.status.toUpperCase()}
                  </td>
                  <td style={{ maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {row.detected === null
                      ? '—'
                      : typeof row.detected === 'string'
                        ? row.detected
                        : JSON.stringify(row.detected)}
                  </td>
                  <td className="num">{row.weight}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {result.injection_directives.length > 0 ? (
            <>
              <h2 style={{ marginTop: 18 }}>Missing-claim directives</h2>
              {result.injection_directives.map((directive) => (
                <div className="directive" key={directive.claim}>
                  <div>
                    <strong>[{CLAIM_LABELS[directive.claim] ?? directive.claim}]</strong>{' '}
                    {directive.action}
                  </div>
                  <div className="gain">+{directive.weight} pts when added</div>
                </div>
              ))}
            </>
          ) : null}

          <h2 style={{ marginTop: 18 }}>Injected Product JSON-LD</h2>
          <button className="btn" type="button" onClick={copyJsonLd}>
            {copied ? 'Copied ✓' : 'Copy JSON-LD'}
          </button>
          <pre className="jsonld">{JSON.stringify(result.product_jsonld, null, 2)}</pre>
        </>
      ) : null}
    </div>
  );
}
