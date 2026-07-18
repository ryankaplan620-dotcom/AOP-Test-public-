/**
 * Settings.jsx — connection settings for the static SPA build.
 *
 * Role in the AOP data flow: the dashboard is deployment-agnostic static
 * assets; this tab wires it to a concrete ingestion /analytics API (URL +
 * dashboard bearer token) and optimizer microservice URL. Values persist in
 * localStorage (loadSettings/saveSettings in api.js).
 *
 * The token is a credential: the input uses type="password" so it never
 * shows on screen-shares, and it is stored only in this browser's
 * localStorage — never sent anywhere except the Authorization header of
 * analytics reads.
 */

import React, { useState } from 'react';
import { saveSettings } from '../api.js';

export default function Settings({ settings, onChange }) {
  const [draft, setDraft] = useState(settings);
  const [saved, setSaved] = useState(false);

  const update = (key) => (event) => {
    setDraft({ ...draft, [key]: event.target.value });
    setSaved(false);
  };

  const apply = () => {
    const cleaned = {
      analyticsUrl: draft.analyticsUrl.trim(),
      dashboardToken: draft.dashboardToken.trim(),
      optimizerUrl: draft.optimizerUrl.trim(),
    };
    saveSettings(cleaned);
    onChange(cleaned);
    setSaved(true);
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
          Dashboard API token (DASHBOARD_API_TOKEN)
          <input
            type="password"
            value={draft.dashboardToken}
            onChange={update('dashboardToken')}
            placeholder="paste the token configured on the ingestion service"
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
      {saved ? <span className="saved-note">Saved ✓</span> : null}
    </div>
  );
}
