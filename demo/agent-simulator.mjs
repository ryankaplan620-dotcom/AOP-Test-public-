/**
 * demo/agent-simulator.mjs — synthetic AI shopping-agent traffic (demo only).
 *
 * Role in the AOP data flow (demo):
 *   Plays the queue-consumer's part of the pipeline: for each generated
 *   agent session (demo/lib/scenarios.js) it POSTs the intent telemetry
 *   batch to the ingestion service — records shaped exactly like the edge
 *   worker's queue drain would produce — and, for converting sessions, asks
 *   the mock storefront to deliver the signed Shopify orders/create webhook
 *   after a short "checkout" delay. Non-converting sessions simply go quiet
 *   and age into loss_diagnostics via the ingestion service's 60s sweep.
 *
 * Run:
 *   node demo/agent-simulator.mjs                # continuous, 1 session ~2s
 *   node demo/agent-simulator.mjs --sessions 40  # fixed count, then exit
 *   node demo/agent-simulator.mjs --fast         # 4x rate (demo screenshots)
 *
 * Env: INGEST_URL (http://localhost:8787), INGEST_API_TOKEN (dev-token),
 *      STOREFRONT_URL (http://localhost:9100), SHOP_DOMAIN
 *      (redthreadapparel.com — must match the seeded merchant).
 *
 * Plain Node stdlib — zero dependencies.
 */

import { buildScenario } from './lib/scenarios.js';

const INGEST_URL = (process.env.INGEST_URL ?? 'http://localhost:8787').replace(/\/+$/, '');
const INGEST_TOKEN = process.env.INGEST_API_TOKEN ?? 'dev-token';
const STOREFRONT_URL = (process.env.STOREFRONT_URL ?? 'http://localhost:9100').replace(/\/+$/, '');
const SHOP_DOMAIN = process.env.SHOP_DOMAIN ?? 'redthreadapparel.com';

const args = process.argv.slice(2);
const sessionsFlag = args.indexOf('--sessions');
const MAX_SESSIONS = sessionsFlag !== -1 ? Number(args[sessionsFlag + 1]) : Infinity;
const BASE_INTERVAL_MS = args.includes('--fast') ? 500 : 2000;
// Converting sessions "check out" 2-8s after the ping — inside the 60s
// window, so the sweep never mistakes a WON session for a loss.
const CHECKOUT_DELAY_MS = () => 2000 + Math.random() * 6000;

let sequence = 0;
let stats = { sessions: 0, won: 0, lost: 0, errors: 0 };

/** POST one session's probes as a telemetry batch (edge queue-drain shape). */
async function postTelemetry(scenario) {
  const records = scenario.probes.map((probe) => ({
    token: scenario.token,
    protocol: scenario.protocol,
    method: probe.method,
    path: probe.path,
    query: probe.method === 'GET' ? `?sku=${scenario.sku}` : '',
    target_sku: scenario.sku,
    shop_domain: SHOP_DOMAIN,
    inbound_payload: probe.payload,
    pii_redactions: 0,
    user_geo: 'US',
    data_region: 'row',
    status: probe.status,
    latency_ms: 2 + Math.floor(Math.random() * 4),
    observed_at: new Date().toISOString(),
  }));

  const response = await fetch(`${INGEST_URL}/ingest/telemetry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${INGEST_TOKEN}` },
    body: JSON.stringify({ records }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`telemetry ingest HTTP ${response.status}`);
  return response.json();
}

/** Ask the mock storefront (playing Shopify) to deliver the signed webhook. */
async function fireCheckout(scenario) {
  const response = await fetch(`${STOREFRONT_URL}/admin/fire-order-webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: scenario.token,
      order_total: scenario.orderTotal,
      sku: scenario.sku,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`webhook fire HTTP ${response.status}`);
}

async function runSession() {
  const scenario = buildScenario(++sequence, Math.random);
  stats.sessions += 1;
  try {
    // Touch the storefront like a real agent would (also proves the origin
    // is up); telemetry is what actually lands in the database.
    await fetch(`${STOREFRONT_URL}/availability?sku=${scenario.sku}`, {
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});

    await postTelemetry(scenario);

    if (scenario.converts) {
      stats.won += 1;
      setTimeout(() => {
        fireCheckout(scenario).catch((err) => {
          stats.errors += 1;
          console.error(`[agent-sim] checkout failed for ${scenario.token}: ${err.message}`);
        });
      }, CHECKOUT_DELAY_MS());
    } else {
      stats.lost += 1;
    }

    console.error(
      `[agent-sim] #${sequence} ${scenario.protocol} ${scenario.sku} -> ${scenario.converts ? 'WON (webhook pending)' : `walks (${scenario.outcome})`}`,
    );
  } catch (err) {
    stats.errors += 1;
    console.error(`[agent-sim] session #${sequence} failed: ${err.message}`);
  }
}

console.error(
  `[agent-sim] targeting ingest=${INGEST_URL} storefront=${STOREFRONT_URL} shop=${SHOP_DOMAIN} ` +
    `(${Number.isFinite(MAX_SESSIONS) ? MAX_SESSIONS + ' sessions' : 'continuous'}, ~${BASE_INTERVAL_MS}ms cadence)`,
);

const timer = setInterval(async () => {
  if (sequence >= MAX_SESSIONS) {
    clearInterval(timer);
    // Give pending checkout webhooks time to deliver before reporting.
    setTimeout(() => {
      console.error(`[agent-sim] done: ${JSON.stringify(stats)}`);
      process.exit(stats.errors > 0 ? 1 : 0);
    }, 10_000);
    return;
  }
  await runSession();
}, BASE_INTERVAL_MS);

process.on('SIGINT', () => {
  clearInterval(timer);
  console.error(`[agent-sim] stopped: ${JSON.stringify(stats)}`);
  process.exit(0);
});
