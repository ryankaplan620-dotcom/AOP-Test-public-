/**
 * Settings.jsx — connection settings for the static SPA build.
 *
 * Role in the AOP data flow: the dashboard is deployment-agnostic static
 * assets; this tab wires it to a concrete ingestion /analytics API (URL +
 * bearer credential) and optimizer microservice URL. Values persist in
 * localStorage (loadSettings/saveSettings in api.js).
 *
 * The credential field accepts EITHER access class (multi-tenant auth,
 * migration 0014):
 *   - the platform DASHBOARD_API_TOKEN — sees every merchant, or
 *   - a merchant API key ('aop_live_…') — scoped to that one shop.
 * "Verify access" calls /analytics/whoami so the operator can see which
 * scope the pasted credential actually grants before trusting the numbers.
 *
 * The credential is exactly that: the input uses type="password" so it never
 * shows on screen-shares, and it is stored only in this browser's
 * localStorage — never sent anywhere except the Authorization header of
 * analytics reads.
 */

import React, { useState } from 'react';
import { saveSettings, fetchWhoami } from '../api.js';

export default function Settings({ settings, onChange }) {
  const [draft, setDraft] = useState(settings);
  const [saved, setSaved] = useState(false);
  const [scope, setScope] = useState(null); // {ok, text} after a verify

  const update = (key) => (event) => {
    setDraft({ ...draft, [key]: event.target.value });
    setSaved(false);
    setScope(null);
  };

  const cleanedDraft = () => ({
    analyticsUrl: draft.analyticsUrl.trim(),
    dashboardToken: draft.dashboardToken.trim(),
    optimizerUrl: draft.optimizerUrl.trim(),
  });

  const apply = () => {
    const cleaned = cleanedDraft();
    saveSettings(cleaned);
    onChange(cleaned);
    setSaved(true);
  };

  const verify = async () => {
    setScope({ ok: null, text: 'Checking…' });
    try {
      const who = await fetchWhoami(cleanedDraft());
      setScope({
        ok: true,
        text:
          who.role === 'platform'
            ? 'Platform credential — all merchants visible'
            : `Merchant credential — scoped to ${who.shop_domain ?? who.merchant_id}`,
      });
    } catch (err) {
      setScope({ ok: false, text: err?.message ?? 'Verification failed' });
    }
  };

  return (
    <div className="panel">
      <h2>Connection Settings</h2>
      <p className="sub">
        Saved in this browser only. Defaults match the local-development walkthrough
        (docs/local-development.md).
      </p>
      <div className="settings-grid">
        <label>
          Ingestion service URL (/analytics host)
          <input value={draft.analyticsUrl} onChange={update('analyticsUrl')} placeholder="http://localhost:8787" />
        </label>
        <label>
          Access credential (platform token or merchant API key)
          <input
            type="password"
            value={draft.dashboardToken}
            onChange={update('dashboardToken')}
            placeholder="DASHBOARD_API_TOKEN or aop_live_…"
          />
        </label>
        <label>
          Optimizer microservice URL
          <input value={draft.optimizerUrl} onChange={update('optimizerUrl')} placeholder="http://localhost:8899" />
        </label>
      </div>
      <button className="btn" type="button" onClick={apply}>
        Save settings
      </button>
      <button className="btn" type="button" onClick={verify}>
        Verify access
      </button>
      {saved ? <span className="saved-note">Saved ✓</span> : null}
      {scope ? (
        <p className="sub" role="status">
          {scope.ok === false ? '⚠ ' : ''}
          {scope.text}
        </p>
      ) : null}
    </div>
  );
}
