# AOP Technical Architecture

## 1. High-level topology

The platform runs on a decentralized edge model so the telemetry proxy adds fewer
than 5 milliseconds of latency to storefront lookups:

```
[ AI Agent Client ]
        │
        │ (HTTPS Request to Proxy URL)
        ▼
[ Cloudflare Workers Edge Node ]  ── edge/src/index.js
        ├─── (Asynchronous Log Pipe) ───► [ Cloudflare Queue: aop-edge-telemetry ]
        │                                             │
        │ (Synchronous Pass-Through)                  ▼
        ▼                                   [ Worker Ingestion Engine ]
[ Shopify API Gateways ]                    services/ingestion (Express)
        │                                             │
        │ (Webhook: Order Placed)                     ▼
        ▼                                   [ PostgreSQL Core Database ]
[ Webhook Receiver Engine ] ──────────────────────────┘
services/ingestion/src/routes/webhooks.js   (Attribution Stitching)
```

## 2. Component responsibilities

### The Ingestion Edge (`edge/` — Cloudflare Workers)

One worker script exports two handlers:

- **`fetch(request, env, ctx)`** — the live proxy. The only synchronous work
  before dispatching to the merchant origin: URL parse, two header reads, origin
  resolution (memoized `MERCHANT_ROUTES` lookup), `request.clone()`. Everything
  else — bounded 32KB body capture, JSON parse, **PII redaction**, record build,
  `EDGE_LOG_QUEUE.send()` — is deferred into `ctx.waitUntil()` and runs after the
  response is already streaming back to the agent. Telemetry failure can never
  alter merchant traffic (double-contained try/catch, plus a final backstop that
  converts any unexpected error to a structured 502/500 JSON response).
- **`queue(batch, env)`** — the drain. Batches of up to 100 records (or 5s of
  buffering) are POSTed to the ingestion service with a bearer token. 2xx acks
  the batch; anything else retries via Queues redelivery, with poison batches
  parked in `aop-edge-telemetry-dlq` after 5 attempts.

Only `/availability` and `/shipping_quote` (exact or final path segment) produce
telemetry; **all** paths are transparently proxied either way. The origin URL is
built by assigning `pathname`/`search` onto the configured origin — never by
resolving the inbound path against it — so a hostile `//host` path can't turn the
worker into an open proxy.

### Dynamic merchant routing (onboarding -> edge, no redeploy)

The worker resolves a proxy hostname to a merchant origin from
`env.MERCHANT_ROUTES` (static config) first; on a miss it falls back to
`GET /routes/resolve` on the ingestion service, which reads
`merchant_profiles.proxy_hostname -> origin_url` — the columns the OAuth
callback populates at install (migration 0007). So installing a merchant
makes them routable immediately, with no `wrangler deploy`. The lookup runs
only on a per-isolate cache miss (60s positive / 30s negative TTL, in-flight
deduped), keeping steady-state traffic on the synchronous <5ms path; the
`PROXY_HOSTNAME_SUFFIX` gate bounds lookups to the platform's own namespace
so scanner spray never reaches the control plane; and the resolve call
carries the same `INGEST_API_TOKEN` the edge already holds.

### The Queue Broker (Cloudflare Queues)

High-throughput buffer between the edge and the database, protecting PostgreSQL
from lock pressure during traffic spikes or scraper runs. The product spec's
Redis Enterprise role is fulfilled by Cloudflare Queues in this MVP: it is
native to the Worker runtime (`.send()` producer binding, batch consumer,
retries, DLQ) with zero extra infrastructure.

### The Worker Ingestion Engine (`services/ingestion/` — Node.js/Express)

- `POST /ingest/telemetry` — bearer-auth (timing-safe), per-record validation
  (`lib/validate-telemetry.js` repairs what is safe, rejects what would corrupt
  attribution), shop-domain → merchant resolution through a 60s TTL cache, one
  multi-row parameterized INSERT per batch.
- **Benchmark Engine** (`GET /analytics/benchmark`): aggregates the exact
  integer-cents price evidence the loss classifier stores on
  PRICE_DISCREPANCY diagnostics into the spec's headline insight — average
  undercut when agents chose a competitor on price, plus a per-SKU reprice
  worklist ranked by revenue impact.
- **Context Reconstruction** (`lib/intent-classifier.js`): each stored intent
  is classified into a prompt-category taxonomy (GIFT_URGENT, PRICE_SENSITIVE,
  ECO_CONSCIOUS, REPLENISHMENT, ...) from explicit agent tags or free-text
  prompt fields, persisted in the `_edge` JSONB meta and served by
  `GET /analytics/traffic` for the dashboard's Agent Traffic screen.
- `POST /webhooks/shopify/orders-create` — the Webhook Receiver Engine. Raw-body
  HMAC-SHA256 verification (mounted before any JSON parser — Shopify signs the
  exact bytes), token extraction from `note_attributes`, attribution stitch,
  idempotent reconciled-order INSERT.
- `GET /auth/install` + `GET /auth/callback` — merchant onboarding: the
  Shopify OAuth flow. Strict `*.myshopify.com` validation, Shopify's
  callback HMAC + a signed expiring state nonce, code-for-token exchange,
  **AES-256-GCM encryption of the access token at rest** (random IV per
  encryption, shop domain bound as AAD — `lib/token-crypto.js` implements the
  schema's ciphertext-only contract), idempotent merchant upsert, and
  automatic `orders/create` webhook registration pointing back at this
  service. Feature-gated (503) until the four onboarding vars are set.
- `jobs/loss-sweep.js` — every 15s (default), finds intents older than the
  60-second conversion window with no reconciled order (by intent id or token)
  and no existing diagnostic, classifies each (`lib/loss-classifier.js`), and
  writes `loss_diagnostics` rows. Per-row error isolation; overlap guard.

### The Optimizer Microservice (`optimizer/aop_optimizer/server.py`)

A stdlib-only HTTP wrapper around the scoring engine for the dashboard's Data
Optimizer tab: `POST /score` returns the directive payload; `POST /rewrite`
adds the Semantic Policy Rewriter artifact (`policy_jsonld`); `POST /simulate`
runs the Pricing & Policy What-If Simulator (baseline plus counterfactual
scenarios — extend returns, faster shipping, drop each penalty, free shipping,
ceiling — each re-scored by the same engine so deltas are comparable) — schema.org
`MerchantReturnPolicy` + `OfferShippingDetails` blocks for the policy as
parsed ("current", an honest restatement) and with directive targets applied
("optimized"), plus `rewritten_policy_text`, agent-parseable prose that
round-trips through our own parser to a score of 100 (tested). Binds
127.0.0.1 by default; expected to sit behind the merchant app's auth.

### The Merchant Dashboard (`dashboard/` — React SPA)

The Loss Diagnosis screen from the product wireframe: stat cards (agent
impressions, reconciled orders won + conversion rate, estimated losses), the
critical drop-off callout, the ranked loss-reason table, and the polled
WON/LOST live stream — all read from the ingestion service's bearer-gated
`/analytics/*` routes. The Data Optimizer and What-If Simulator tabs drive the
optimizer microservice's /rewrite and /simulate endpoints. Static build (Vite); connection settings live in the browser.

### The Relational Storage Layer (`db/` — PostgreSQL)

Migrations `0001`–`0006`, applied by `db/migrate.mjs` (advisory-locked,
transaction-per-file, tracked in `schema_migrations`).

## 3. The attribution-stitching sequence

1. **Intent ping** — agent probes `/availability?sku=X` with
   `X-Agent-Transaction-Token: tok_123`. Edge logs a record; ingestion writes an
   `agent_intent_logs` row.
2. **Checkout** *(happy path)* — the agent completes checkout; the order carries
   `aop_transaction_token = tok_123` in `note_attributes`. Shopify fires
   `orders/create`; the webhook receiver verifies HMAC, finds the **latest
   unclaimed** intent with that token for that merchant, and inserts a
   `reconciled_agent_orders` row. The DB computes `commission_fee` as
   `round(gmv * commission_rate, 2)` in a stored generated column
   (`commission_rate` snapshotted per-row at 0.5%).
3. **Expiry** *(loss path)* — no matching order arrives within
   `INTENT_EXPIRY_SECONDS` (60s). The sweep classifies the drop-off from the
   intent's payload/status evidence and writes exactly one `loss_diagnostics`
   row (`intent_log_id` is UNIQUE).

Attribution invariants, all schema-enforced:

- one order per intent (`UNIQUE` index on `reconciled_agent_orders.intent_log_id`;
  token-reuse and webhook races degrade to token-alone reconciliation with a
  `NULL` intent pointer — the billable order is never dropped);
- one diagnostic per intent (`UNIQUE` on `loss_diagnostics.intent_log_id`);
- no double-billing on webhook redelivery (`UNIQUE` on `shopify_order_id` +
  `ON CONFLICT DO NOTHING`);
- billing survives telemetry pruning (`intent_log_id ON DELETE SET NULL` and a
  denormalized `transaction_token` copy on the order row).

## 4. Commission model

`reconciled_agent_orders` is the billing source of truth:

- `gross_merchandise_value NUMERIC(12,2)` — the order total from the webhook.
- `commission_rate NUMERIC(6,5)` — per-row snapshot, default `0.00500`,
  CHECK-bounded to `[0, 1]` so a fat-fingered rate can't mint a fee larger than
  the order.
- `commission_fee` — **`GENERATED ALWAYS AS (round(gmv * rate, 2)) STORED`**.
  No code path (service, backfill, manual psql) can write a fee inconsistent
  with the data. `services/ingestion/src/lib/commission.js` recomputes it in
  integer cents for verification/reporting only.

## 5. Latency budget (<5ms)

The 5ms ceiling is why the edge worker:

- does zero body reads before origin dispatch (the clone's tee branch is read
  later, inside `waitUntil`);
- streams both request and response bodies (never buffers);
- memoizes route-map parsing per isolate;
- performs the queue send strictly after the response is returned.

Pre-dispatch synchronous work is bounded to URL parsing, three header reads, a
map lookup, and `request.clone()` — all sub-millisecond operations.

## 6. Compliance architecture

From the AOP data-privacy memo ("pass-through analytics processor"):

- **PII redaction at the edge** (`edge/src/redact.js`): key-based redaction of
  name/email/phone/address/city/coordinate fields plus value-based scrubbing of
  email/phone/street-address shapes in free text. Only zip, state/province and
  country survive. PII exists in worker RAM for the pass-through milliseconds
  only; it never reaches the queue, the ingestion service, or PostgreSQL. The
  `pii_redactions` counter persists per record (in the JSONB `_edge` meta) as
  the audit trail; a redactor failure drops the payload entirely (fail-safe).
- **Data residency**: `user_geo` (from `X-User-Geo`, falling back to
  Cloudflare's `request.cf.country`) and the derived `data_region`
  (`eu` / `row`) ride every record so EU telemetry can be pinned to EU
  infrastructure.
- **90-day retention**: `purge_expired_telemetry(retention_days, batch_size)`
  (migration `0006`) deletes expired `agent_intent_logs` in ctid-bounded batches
  — dependent `loss_diagnostics` cascade; `reconciled_agent_orders` (billing)
  are never purged. Enforced automatically by the ingestion service's
  in-process retention sweep (`jobs/retention-sweep.js`, every 6h by default);
  pg_cron remains a fine alternative — the purge is idempotent.
