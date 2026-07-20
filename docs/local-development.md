# Local development — end-to-end walkthrough

This walks the full loop on one machine: PostgreSQL up → migrations → merchant
seed → ingestion service → simulated agent ping → simulated signed Shopify
webhook → loss sweep.

## 0. Prerequisites

- Node.js ≥ 18 (22 recommended), Python 3.11, Docker (for PostgreSQL).

## 1. Database

```bash
cp .env.example .env                  # adjust if you like; defaults work locally
docker compose up -d postgres
cd db && npm install
DATABASE_URL=postgres://aop:aop@localhost:5432/aop npm run migrate
```

A second `npm run migrate` prints "schema up to date" and no-ops — the runner is
idempotent (advisory-locked, transaction-per-file).

## 2. Seed a merchant

The proxy records the **origin hostname** as `shop_domain`; the ingestion service
resolves it against `shopify_shop_domain` OR the `origin_hostname` generated from
`origin_url` (migration 0011). Real Shopify webhooks, by contrast, always carry
the permanent `*.myshopify.com` domain. Seed the two identities the way
production has them — myshopify key + custom-domain origin:

```bash
psql postgres://aop:aop@localhost:5432/aop <<'SQL'
INSERT INTO merchant_profiles (shopify_shop_domain, access_token_encrypted, origin_url)
VALUES ('redthread.myshopify.com', 'enc:v1:placeholder-ciphertext', 'https://redthreadapparel.com')
ON CONFLICT DO NOTHING;
SQL
```

(`access_token_encrypted` stores ciphertext only in production — app-layer
AES-256-GCM; the placeholder is fine locally.)

## 3. Ingestion service

```bash
cd services/ingestion && npm install
DATABASE_URL=postgres://aop:aop@localhost:5432/aop \
INGEST_API_TOKEN=dev-token \
SHOPIFY_WEBHOOK_SECRET=dev-secret \
npm start
# [ingestion] listening on :8787 ; GET /healthz -> {"status":"ok"}
```

## 4. Simulate an agent intent ping

Locally you can skip the Worker and POST a telemetry batch exactly as the queue
consumer would (this is the same verification loop as the onboarding directive's
`verify_loop_test_99` curl, minus the edge hop):

```bash
curl -s -X POST http://localhost:8787/ingest/telemetry \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{
    "records": [{
      "token": "verify_loop_test_99",
      "protocol": "STRIPE_ACP",
      "method": "GET",
      "path": "/availability",
      "query": "?sku=TEST-SKU-01",
      "target_sku": "TEST-SKU-01",
      "shop_domain": "redthreadapparel.com",
      "inbound_payload": null,
      "pii_redactions": 0,
      "user_geo": "US",
      "data_region": "row",
      "status": 200,
      "latency_ms": 3,
      "observed_at": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"
    }]
  }'
# -> {"inserted":1,"skipped_unknown_merchant":0,"rejected_invalid":0}
```

To exercise the real edge worker instead: `cd edge && npx wrangler dev` proxies
`http://localhost:8787`-bound routes per `wrangler.toml`; the test suite
(`npm test`) covers the worker's behavior without any Cloudflare account.

## 5. Simulate a signed Shopify order webhook

Shopify signs the raw body with HMAC-SHA256 (base64). Generate a signed payload
whose `note_attributes` echo the transaction token:

```bash
BODY='{"id":9900000001,"total_price":"129.90","note_attributes":[{"name":"aop_transaction_token","value":"verify_loop_test_99"}]}'
HMAC=$(node -e "console.log(require('crypto').createHmac('sha256','dev-secret').update(process.argv[1]).digest('base64'))" "$BODY")

curl -s -X POST http://localhost:8787/webhooks/shopify/orders-create \
  -H "Content-Type: application/json" \
  -H "X-Shopify-Shop-Domain: redthread.myshopify.com" \
  -H "X-Shopify-Hmac-Sha256: $HMAC" \
  -d "$BODY"
# -> {"ok":true,"action":"reconciled", ...}
```

Check the money table — the commission is computed by the database:

```bash
psql postgres://aop:aop@localhost:5432/aop \
  -c "SELECT shopify_order_id, gross_merchandise_value, commission_rate, commission_fee
        FROM reconciled_agent_orders;"
#  ord 9900000001 | 129.90 | 0.00500 | 0.65
```

Re-send the same curl: the response reports the redelivery no-op and no second
row appears (`ON CONFLICT (shopify_order_id) DO NOTHING`).

## 6. Watch the loss sweep fire

Ingest another ping with a **different** token (step 4, e.g.
`token: "tok_never_converts"`) and do **not** send a webhook for it. Within
`INTENT_EXPIRY_SECONDS` (60s) + one sweep interval (15s), the service logs the
diagnostic and:

```bash
psql postgres://aop:aop@localhost:5432/aop \
  -c "SELECT target_sku, calculated_loss_reason, estimated_revenue_lost
        FROM loss_diagnostics;"
```

## 7. Retention purge (compliance)

```bash
psql postgres://aop:aop@localhost:5432/aop -c "SELECT * FROM purge_expired_telemetry();"
```

Deletes intent telemetry older than 90 days (dependent diagnostics cascade);
billing rows are never touched. Schedule in production via pg_cron or a cron job.

## 8. Dashboard + optimizer panel

```bash
cd optimizer && python3 -m aop_optimizer.server &        # :8899
cd ../dashboard && npm install && npm run dev            # Vite dev server
```

Open the dev URL, go to **Settings**, set the ingestion URL
(`http://localhost:8787`), an access credential (below), and the optimizer URL
(`http://localhost:8899`). The Loss Diagnosis tab then shows the seeded
metrics live; the Data Optimizer tab runs the scan end-to-end. (Set
`DASHBOARD_API_TOKEN` when starting the ingestion service in step 3 — without
it the /analytics routes answer 503.)

Two credential classes work in the Settings token field (use **Verify
access** to confirm which scope you got):

- the platform `DASHBOARD_API_TOKEN` — sees every merchant, or
- a per-merchant API key, scoped to one shop. Mint one with the platform
  token (the plaintext `api_key` is shown exactly once — only its SHA-256
  digest is stored):

```bash
curl -s -X POST http://localhost:8787/analytics/keys \
  -H "Authorization: Bearer $DASHBOARD_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"shop_domain": "redthread.myshopify.com", "label": "local dev"}'
# -> {"api_key": "aop_live_…", "key_prefix": "aop_live_xxxx", ...}

curl -s http://localhost:8787/analytics/keys \
  -H "Authorization: Bearer $DASHBOARD_API_TOKEN"           # inventory
curl -s -X DELETE http://localhost:8787/analytics/keys/<id> \
  -H "Authorization: Bearer $DASHBOARD_API_TOKEN"           # revoke
```

## 9. Proof of lift + outcome calibration

The dashboard's **Proof of Lift** tab renders `GET /analytics/lift` — weekly
agent-conversion series plus an exact split-half comparison (recent half of
the window vs the half before it) and per-reason loss shifts. Observed counts
only; when the baseline half can't support a relative comparison the lift is
`null`, never a made-up number:

```bash
curl -s "http://localhost:8787/analytics/lift?days=56" \
  -H "Authorization: Bearer $DASHBOARD_API_TOKEN"
```

The optimizer's selection-probability curve can be calibrated from real
won/lost sessions (aggregate your merchants' policy scores with their
observed outcomes — e.g. wins/losses from `/analytics/lift` splits):

```bash
curl -s -X POST http://localhost:8899/calibrate \
  -H "Content-Type: application/json" \
  -H "X-AOP-Calibrate: 1" \
  -d '{"sessions": [
        {"score": 48, "wins": 11, "losses": 89},
        {"score": 62, "wins": 47, "losses": 53},
        {"score": 78, "wins": 82, "losses": 18}
      ]}'
# -> {"ok": true, "mode": "full", "market_baseline_score": ..., ...}
curl -s http://localhost:8899/calibration          # active curve + provenance
curl -s -X DELETE -H "X-AOP-Calibrate: 1" \
  http://localhost:8899/calibrate                  # back to defaults
```

The `X-AOP-Calibrate: 1` header is required on the two state-mutating verbs —
a custom header forces a browser CORS preflight the server will fail, so a
drive-by web page can never recalibrate the curve. Set `AOP_OPTIMIZER_TOKEN`
to additionally require a bearer token if the port is exposed beyond
localhost.

An accepted fit becomes the server's active curve — subsequent `/score`,
`/rewrite`, and `/simulate` responses carry a `calibration` provenance object
(`fitted` / `default` / `request_override`). A rejected fit (too little data,
inverted slope, implausible parameters) answers 422 and changes nothing.

## 10. Edge response enrichment (inject verified JSON-LD at the proxy)

The edge can inject a merchant's **optimizer-verified** schema.org JSON-LD
into their HTML responses — agents see machine-readable policy/product
claims with zero storefront changes. Off by default per merchant; the write
path validates shape (schema.org `@context` + `@type`), size (≤32KB), and
the payload is injected verbatim (the only transform is escaping `<` inside
the serialized JSON so it can never break out of its script tag):

```bash
# 1. Produce verified JSON-LD from the merchant's REAL policy text — the
#    optimizer's /rewrite returns schema.org blocks under policy_jsonld;
#    compose the block you want to publish (context + typed body):
curl -s -X POST http://localhost:8899/rewrite \
  -H "Content-Type: application/json" \
  -d '{"policy_text": "30-day returns. Ships in 2 business days."}' \
  | python3 -c "
import json, sys
p = json.load(sys.stdin)['policy_jsonld']['optimized']
print(json.dumps({'@context': p['@context'], **p['returnPolicy']}, indent=2))"

# 2. Store it + enable the gate (platform token):
curl -s -X PUT http://localhost:8787/analytics/enrichment \
  -H "Authorization: Bearer $DASHBOARD_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"shop_domain": "redthread.myshopify.com",
       "jsonld": {"@context": "https://schema.org", "@type": "Organization",
                  "name": "Red Thread",
                  "hasMerchantReturnPolicy": {"@type": "MerchantReturnPolicy",
                                              "merchantReturnDays": 30}},
       "enabled": true}'

# 3. The edge bundles it with route resolution (/routes/resolve) and injects
#    it into GET+200+text/html responses, tagged data-aop-enriched="true"
#    and x-aop-enriched: 1. Disable any time:
curl -s -X PUT http://localhost:8787/analytics/enrichment \
  -H "Authorization: Bearer $DASHBOARD_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"shop_domain": "redthread.myshopify.com", "jsonld": null, "enabled": false}'
```

Enrichment requires the merchant to be **dynamically routed** — proxy_hostname
+ origin_url in `merchant_profiles`, which the OAuth install populates. The
payload rides the **same** `/routes/resolve` answer as dynamic routing (one
control-plane round trip serves both; changes land within ~60s). The edge
reply path never fetches — it reads the payload from that shared per-isolate
cache synchronously, so a slow or down control plane can never add latency to
any merchant's HTML. Merchants pinned via the static `MERCHANT_ROUTES` worker
config (a redeploy-time escape hatch that bypasses the database) are not
enriched.

## 11. Score a store policy

```bash
cd optimizer
echo "We charge a 15% restocking fee. Returns within 14 days for store credit only.
Ships in 4-6 business days." | python3 -m aop_optimizer --pretty
```

The JSON output contains the Agent Match Score, selection probability, applied
deductions, and directive rewrites whose `projected_score_gain` sums to exactly
the recoverable deficit.
