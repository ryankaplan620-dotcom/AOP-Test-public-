# AOP — Agent Optimization Platform

**The "Ahrefs + Google Analytics for AI Commerce."**

AI shopping agents (OpenAI/Stripe **ACP**, Google **AP2**) buy by querying merchant
endpoints directly — no browser, no pixel, no cookie. Merchants connected to these
protocols are flying blind: they can't see when an agent *considered* them and moved
on, why it chose a competitor, or which prompt drove an order.

AOP is an intelligent middleware proxy that sits between the agent protocols and a
headless Shopify/BigCommerce backend. It:

- **Intercepts intent** — every `GET /availability` and `POST /shipping_quote` probe
  is transparently proxied to the merchant origin while a telemetry record is fired
  into an async queue (adding <5ms of edge overhead).
- **Reconstructs cookie-less attribution** — the `X-Agent-Transaction-Token` header
  captured at the edge is stitched to Shopify `orders/create` webhooks, reconciling
  agent-driven orders and computing the platform's flat **0.5% commission on
  reconciled GMV** (enforced by a database generated column — billing math lives in
  the schema, not app code).
- **Diagnoses losses** — intents that expire without a conversion inside the
  60-second window are classified (`PRICE_DISCREPANCY`, `SHIPPING_LATENCY`,
  `STOCK_OUTAGE`, `POLICY_AMBIGUITY`, `PROTOCOL_ERROR`, `UNKNOWN_DROPOFF`) into a
  loss-diagnostics ledger.
- **Optimizes the merchant's data** — a Python engine simulates how an LLM evaluates
  raw policy text, produces an **Agent Match Score (0–100)** plus a normalized
  selection probability, and emits exact semantic rewrites that recover lost points.

## Data flow

```mermaid
flowchart LR
    A[AI Agent Client] -->|HTTPS| W[Cloudflare Worker<br/>aop-edge-proxy]
    W -->|sync passthrough| S[Shopify / BigCommerce origin]
    W -.->|ctx.waitUntil telemetry| Q[(Cloudflare Queue<br/>aop-edge-telemetry)]
    Q --> C[queue consumer<br/>same worker]
    C -->|POST /ingest/telemetry| I[Node.js ingestion service]
    S -->|orders/create webhook| I
    I --> P[(PostgreSQL)]
    P --> O[Python optimizer<br/>aop_optimizer]
```

```
[ AI Agent Client ]
        │  (HTTPS Request to Proxy URL)
        ▼
[ Cloudflare Workers Edge Node ]
        ├── (Async Log Pipe) ──► [ Queue ] ──► [ Ingestion Engine ] ──► [ PostgreSQL ]
        │  (Sync Pass-Through)                                              ▲
        ▼                                                                   │
[ Shopify API Gateways ] ── (Webhook: Order Placed) ──► [ Webhook Receiver ]┘
                                                        (Attribution Stitching)
```

## Repository layout

| Path | Component | Stack |
|---|---|---|
| `edge/` | Zero-latency listening proxy + queue consumer | Cloudflare Workers (no runtime deps) |
| `db/` | PostgreSQL schema migrations + runner | SQL, `pg` |
| `services/ingestion/` | Telemetry ingest, webhook receiver, attribution stitch, loss sweep, OAuth onboarding | Node.js, Express, `pg` |
| `optimizer/` | Agent Match Score engine + CLI + HTTP microservice + JSON-LD rewriter + what-if simulator | Python 3.11, stdlib only |
| `dashboard/` | Merchant dashboard: Loss Diagnosis, Agent Traffic, Data Optimizer, What-If Simulator | React 18, Vite |
| `demo/` | One-command demo: mock Shopify storefront + agent traffic simulator | Node stdlib |
| `docs/` | Architecture + local development guides | — |

## Quickstart

```bash
# 1. Database (docker compose brings up PostgreSQL 16)
cp .env.example .env            # fill in real values
docker compose up -d postgres
cd db && npm install && npm run migrate

# 2. Ingestion service
cd ../services/ingestion && npm install
DATABASE_URL=postgres://aop:aop@localhost:5432/aop \
INGEST_API_TOKEN=dev-token \
SHOPIFY_WEBHOOK_SECRET=dev-secret \
npm start                       # listens on :8787

# 3. Edge worker (Cloudflare account required for deploy; tests run locally)
cd ../edge && npm install
npx wrangler secret put INGEST_API_TOKEN
npm run deploy

# 4. Optimizer (CLI, or as the dashboard's microservice)
cd ../optimizer
echo "Ships in 4-6 business days. 14-day returns, store credit only." \
  | python3 -m aop_optimizer --pretty --jsonld
python3 -m aop_optimizer.server        # HTTP: POST /score, /rewrite, /simulate on :8899

# 5. Dashboard (Loss Diagnosis screen + Data Optimizer panel)
cd ../dashboard && npm install
npm run dev                            # then set URLs + token in its Settings tab
```

**Or run everything at once:** `./demo/run-demo.sh` boots PostgreSQL,
migrations, the ingestion service, the optimizer, a mock Shopify storefront
that signs real webhooks, a continuous agent-traffic simulator (~30% of
sessions convert; the rest expire into every loss reason), and the dashboard
— a fully populated Loss Diagnosis screen within ~90 seconds.

See [docs/local-development.md](docs/local-development.md) for the manual
end-to-end walkthrough (seeding a merchant, simulating agent pings and signed
Shopify webhooks, watching the loss sweep fire).

## Testing

Every suite runs offline — no network, no external services:

```bash
cd edge && npm test                          # 40 tests — plain Node 22, no wrangler
cd services/ingestion && npm test            # 102 tests — pure libs, pass before npm install
cd optimizer && python3 -m unittest discover # 135 tests — stdlib only (engine, JSON-LD, HTTP, simulator)
cd dashboard && npm test && npm run build    # pure helpers + production build
node --test demo/test/scenarios.test.mjs     # demo scenario generator
cd db && node --check migrate.mjs            # runner syntax; SQL verified against PG16
```

## Environment variables

| Variable | Component | Purpose |
|---|---|---|
| `DATABASE_URL` | db, ingestion | PostgreSQL connection string |
| `INGEST_API_TOKEN` | ingestion, edge (secret) | Bearer token for `POST /ingest/telemetry` |
| `SHOPIFY_WEBHOOK_SECRET` | ingestion | HMAC-SHA256 secret for webhook verification |
| `PORT` | ingestion | HTTP port (default `8787`) |
| `INTENT_EXPIRY_SECONDS` | ingestion | Conversion window before an intent counts as lost (default `60`) |
| `LOSS_SWEEP_INTERVAL_MS` | ingestion | Loss-sweep cadence (default `15000`) |
| `MERCHANT_ROUTES` | edge (`[vars]`) | JSON map: proxy hostname → merchant origin base URL |
| `DEFAULT_ORIGIN` | edge (`[vars]`) | Fallback origin; empty = 502 unknown hostnames |
| `INGEST_API_URL` | edge (`[vars]`) | Base URL of the ingestion service |
| `DASHBOARD_API_TOKEN` | ingestion | Bearer token gating the read-only `/analytics/*` routes (unset = analytics disabled) |
| `DASHBOARD_ALLOWED_ORIGIN` | ingestion | CORS origin reflected on `/analytics/*` (default `*`; pin in production) |
| `AOP_OPTIMIZER_HOST` / `AOP_OPTIMIZER_PORT` | optimizer server | Bind address of the scoring microservice (default `127.0.0.1:8899`) |
| `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` | ingestion | Shopify app credentials for the OAuth install flow (`/auth/install`) |
| `TOKEN_ENCRYPTION_KEY` | ingestion | 64-hex AES-256-GCM key for merchant tokens at rest (`openssl rand -hex 32`) |
| `APP_URL` | ingestion | Public base URL of the service (OAuth redirect + registered webhook address) |

## Compliance posture

Per the AOP data-privacy memo, the platform is a *pass-through analytics processor*:

- **PII never reaches disk.** The edge worker redacts names, emails, phone numbers
  and street addresses from captured payloads *before* queueing
  (`edge/src/redact.js`), retaining only zip/state/country. Each record carries a
  `pii_redactions` audit counter.
- **Data residency.** Records carry `user_geo` (from `X-User-Geo` /
  Cloudflare geo-IP) and a derived `data_region` (`eu`/`row`) so EU telemetry can
  be routed to EU infrastructure.
- **90-day retention cap.** `SELECT * FROM purge_expired_telemetry();`
  (db migration `0006`) deletes expired intent telemetry in bounded batches;
  billing records (`reconciled_agent_orders`) are never purged.
