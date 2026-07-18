#!/usr/bin/env bash
# =============================================================================
# demo/run-demo.sh — one-command AOP demo.
#
# Boots the full platform loop locally and streams synthetic agent traffic
# through it:
#
#   postgres (docker compose) -> migrations -> merchant seed
#     -> ingestion service (:8787, with the loss sweep)
#     -> optimizer microservice (:8899)
#     -> mock Shopify storefront (:9100, signs real orders/create webhooks)
#     -> agent traffic simulator (continuous WON/LOST sessions)
#     -> dashboard dev server (Vite prints its URL)
#
# Within ~90 seconds the Loss Diagnosis screen shows live impressions,
# reconciled orders (DB-computed 0.5% commission), and every loss reason.
#
# Usage:   ./demo/run-demo.sh            # uses docker compose for postgres
#          DATABASE_URL=... ./demo/run-demo.sh   # bring your own postgres
# Stop:    Ctrl-C (kills every child; postgres container keeps running).
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ---- demo credentials (LOCAL ONLY — never reuse in production) --------------
export INGEST_API_TOKEN="${INGEST_API_TOKEN:-dev-token}"
export SHOPIFY_WEBHOOK_SECRET="${SHOPIFY_WEBHOOK_SECRET:-dev-secret}"
export DASHBOARD_API_TOKEN="${DASHBOARD_API_TOKEN:-dev-dash-token}"
SHOP_DOMAIN="${SHOP_DOMAIN:-redthreadapparel.com}"

# ---- 1. PostgreSQL ----------------------------------------------------------
if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "[demo] starting postgres via docker compose..."
  docker compose up -d postgres
  export DATABASE_URL="postgres://aop:aop@localhost:5432/aop"
  # Wait for the healthcheck instead of sleeping blind.
  for _ in $(seq 1 30); do
    if docker compose exec -T postgres pg_isready -U aop -d aop >/dev/null 2>&1; then break; fi
    sleep 1
  done
fi

echo "[demo] applying migrations..."
(cd db && npm install --silent --no-audit --no-fund >/dev/null && npm run migrate)

echo "[demo] seeding merchant ${SHOP_DOMAIN}..."
node - <<SEED
import pg from './db/node_modules/pg/lib/index.js';
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
await client.query(
  "INSERT INTO merchant_profiles (shopify_shop_domain, access_token_encrypted) VALUES (\$1, 'enc:v1:demo') ON CONFLICT DO NOTHING",
  ['${SHOP_DOMAIN}']
);
await client.end();
console.error('[demo] merchant ready');
SEED

# ---- 2. child processes -----------------------------------------------------
PIDS=()
cleanup() {
  echo; echo "[demo] shutting down..."
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "[demo] starting ingestion service (:8787)..."
(cd services/ingestion && npm install --silent --no-audit --no-fund >/dev/null && \
  PORT=8787 node src/index.js) & PIDS+=($!)

echo "[demo] starting optimizer microservice (:8899)..."
(cd optimizer && python3 -m aop_optimizer.server) & PIDS+=($!)

echo "[demo] starting mock storefront (:9100)..."
PORT=9100 INGEST_URL=http://localhost:8787 SHOP_DOMAIN="$SHOP_DOMAIN" \
  node demo/mock-storefront.mjs & PIDS+=($!)

# Wait for the ingestion service before opening the traffic firehose.
for _ in $(seq 1 30); do
  if curl -sf http://localhost:8787/healthz >/dev/null 2>&1; then break; fi
  sleep 1
done

echo "[demo] starting agent traffic simulator..."
INGEST_URL=http://localhost:8787 STOREFRONT_URL=http://localhost:9100 SHOP_DOMAIN="$SHOP_DOMAIN" \
  node demo/agent-simulator.mjs & PIDS+=($!)

echo "[demo] starting dashboard (Vite dev server)..."
(cd dashboard && npm install --silent --no-audit --no-fund >/dev/null && npm run dev) & PIDS+=($!)

cat <<BANNER

=============================================================================
 AOP demo is running.

   Dashboard      : Vite prints its URL above (usually http://localhost:5173)
                    -> Settings tab:
                       ingestion URL  http://localhost:8787
                       token          ${DASHBOARD_API_TOKEN}
                       optimizer URL  http://localhost:8899
   Ingestion API  : http://localhost:8787  (healthz, /analytics/*)
   Optimizer      : http://localhost:8899  (/score, /rewrite)
   Mock storefront: http://localhost:9100

 Agent sessions stream continuously (~1 every 2s; ~30% convert). Losses
 appear after the 60s intent window + sweep tick. Ctrl-C stops everything.
=============================================================================
BANNER

wait
