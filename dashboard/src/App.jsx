/**
 * App.jsx — shell of the AOP merchant dashboard.
 *
 * Role in the AOP data flow: hosts the three screens over the two backends:
 *   Loss Diagnosis  <- ingestion /analytics/* (bearer-gated reads)
 *   Data Optimizer  <- optimizer microservice /rewrite
 *   Settings        -> localStorage connection config for both
 *
 * Tab state is plain useState — three screens do not justify a router
 * dependency, and the SPA's whole dependency surface stays react+react-dom.
 */

import React, { useState } from 'react';
import LossDiagnosis from './components/LossDiagnosis.jsx';
import AgentTraffic from './components/AgentTraffic.jsx';
import DataOptimizer from './components/DataOptimizer.jsx';
import Simulator from './components/Simulator.jsx';
import Settings from './components/Settings.jsx';
import { loadSettings } from './api.js';

const TABS = [
  { id: 'loss', label: 'Loss Diagnosis' },
  { id: 'traffic', label: 'Agent Traffic' },
  { id: 'optimizer', label: 'Data Optimizer' },
  { id: 'simulator', label: 'What-If Simulator' },
  { id: 'settings', label: 'Settings' },
];

export default function App() {
  const [tab, setTab] = useState('loss');
  const [settings, setSettings] = useState(loadSettings);

  return (
    <div>
      <header className="topbar">
        <div className="brand">
          [<span>AOP</span>] Agent Optimization Platform
        </div>
        <div className="store">merchant analytics · agent commerce (ACP / AP2)</div>
      </header>

      <nav className="tabs" aria-label="dashboard sections">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={tab === entry.id ? 'active' : ''}
            onClick={() => setTab(entry.id)}
          >
            {tab === entry.id ? `*${entry.label}*` : entry.label}
          </button>
        ))}
      </nav>

      {tab === 'loss' ? <LossDiagnosis settings={settings} /> : null}
      {tab === 'traffic' ? <AgentTraffic settings={settings} /> : null}
      {tab === 'optimizer' ? <DataOptimizer settings={settings} /> : null}
      {tab === 'simulator' ? <Simulator settings={settings} /> : null}
      {tab === 'settings' ? <Settings settings={settings} onChange={setSettings} /> : null}

      <p className="footnote">
        Data: edge intent telemetry (PII-redacted at the edge) reconciled against Shopify order
        webhooks · commission math enforced by the database schema · retention capped at 90 days.
      </p>
    </div>
  );
}
