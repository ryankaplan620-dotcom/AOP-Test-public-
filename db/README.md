<!--
  AOP :: db/README.md

  Role in the AOP data flow: documentation for the PostgreSQL relational
  storage layer — the terminus of the telemetry pipeline
  ([AI Agent] -> [CF Worker edge proxy] -> [Queue] -> [ingestion service] -> HERE)
  and the source of truth for attribution, billing, and loss analytics.
-->

# AOP — PostgreSQL Storage Layer (`db/`)

This directory owns the relational schema for the Agent Optimization Platform
and the runner that applies it. Everything the ingestion service writes —
agent intent telemetry, reconciled orders, loss diagnostics — lands in the
tables defined here.

## Where this sits in the system

```
[AI Agent (ACP / AP2)]
        |
        v
[Cloudflare Worker edge proxy] --(sync passthrough)--> [Shopify backend]
        |                                                     |
        | (async telemetry)                                   | (order-created webhook)
        v                                                     v
[EDGE_LOG_QUEUE] -> [queue consumer] -> [Node.js ingestion service]
                                                |
                                                v
                                     [PostgreSQL  <-- THIS LAYER]
```

- The edge proxy never talks to PostgreSQL. Telemetry arrives asynchronously
  via the queue, so a database outage can never break a merchant's live agent
  traffic — that guarantee is architectural, and this layer is designed to be
  safe to fall behind on.
- The ingestion service is the only writer. It inserts intents, reconciles
  webhooks into orders (joining on the `X-Agent-Transaction-Token` value),
  and runs the sweep job that writes loss diagnostics.

## Schema overview

| Table | Purpose | Written by |
|---|---|---|
| `merchant_profiles` | Tenant root: one row per onboarded Shopify merchant, with the AES-256-GCM-encrypted Admin API token. | Onboarding flow |
| `agent_intent_logs` | High-volume append-only telemetry: every `/availability`, `/shipping_quote`, etc. query an AI agent makes. | Queue consumer path |
| `reconciled_agent_orders` | Orders attributed back to an intent via transaction token. Source of truth for GMV and the 0.5% commission. | Webhook reconciliation path |
| `loss_diagnostics` | Exactly one row per intent that expired (60 s window) without converting; classifies why the agent dropped off. | Sweep job |

Plus `schema_migrations` (created by the runner itself, not by a migration
file) tracking which files have been applied.

### ER relationships

```
merchant_profiles 1 ---- * agent_intent_logs          (ON DELETE CASCADE)
merchant_profiles 1 ---- * reconciled_agent_orders    (ON DELETE CASCADE)
merchant_profiles 1 ---- * loss_diagnostics           (ON DELETE CASCADE)

agent_intent_logs 1 ---- 0..1 reconciled_agent_orders (intent_log_id UNIQUE, ON DELETE SET NULL)
agent_intent_logs 1 ---- 0..1 loss_diagnostics        (intent_log_id UNIQUE, ON DELETE CASCADE)
```

Reading the two intent-side links together: every intent eventually resolves
to **at most one** of "converted" (a reconciled order points at it) or
"lost" (a loss diagnostic points at it). The deletion semantics differ on
purpose:

- `reconciled_agent_orders.intent_log_id` is `ON DELETE SET NULL` — billing
  records must survive telemetry retention pruning. Money outlives logs.
- `loss_diagnostics.intent_log_id` is `ON DELETE CASCADE` and `UNIQUE` — a
  diagnostic is a pure derivative of its intent (and the `UNIQUE` makes the
  sweep job idempotent at the schema level).

The attribution join itself (`transaction_token`) is deliberately
denormalized onto both `agent_intent_logs` and `reconciled_agent_orders` so
attribution reporting still works after old intent rows are pruned.

### Key schema-level guarantees

- **Billing math lives in the schema.** `commission_fee` is a `STORED`
  generated column: `round(gross_merchandise_value * commission_rate, 2)`.
  No application code path can write a fee inconsistent with the data.
- **Webhook idempotency.** `reconciled_agent_orders.shopify_order_id` is
  `UNIQUE`; Shopify's at-least-once webhook redelivery becomes a clean
  conflict, never a double-billed commission.
- **Rate snapshots.** `commission_rate` is stored per-row (default
  `0.00500` = 0.5%), so historic rows keep the rate they were billed at if
  the platform rate ever changes.
- **Hot-path indexing.** The reconciliation join path
  (`transaction_token` btree on both sides) plus
  `(merchant_id, processed_at DESC)` / `(merchant_id, reconciled_at DESC)` /
  `(merchant_id, created_at DESC)` composites for per-merchant time-window
  scans, and a GIN `jsonb_path_ops` index on `inbound_payload` for `@>`
  containment mining.

## Running migrations

Requirements: Node.js >= 18, PostgreSQL 14+ (12+ works thanks to the
pgcrypto guard), network access to the target database.

```bash
cd db
npm install
export DATABASE_URL='postgres://user:password@host:5432/aop'
npm run migrate
```

The runner (`migrate.mjs`):

1. Connects with a single `pg` client (never a pool — advisory locks are
   session-scoped).
2. Takes a **blocking advisory lock** so concurrent deploy jobs serialize
   instead of interleaving DDL; the second job waits, then no-ops.
3. Creates `schema_migrations(filename text primary key, applied_at
   timestamptz)` if missing.
4. Applies unapplied `migrations/*.sql` files in filename order, **each file
   in its own transaction** together with its bookkeeping row — a migration
   either fully applies and is recorded, or fully rolls back.
5. Exits non-zero on any failure (CI/CD halts the deploy; the ingestion
   service never starts against a half-migrated schema).

Re-running is always safe: applied files are skipped, and the DDL itself is
additionally written with `IF NOT EXISTS` / `CREATE OR REPLACE` /
`DROP TRIGGER IF EXISTS` guards as a second layer of defense.

Adding a migration: create `migrations/NNNN_short_name.sql` with the next
zero-padded number. Never edit an already-applied file — the runner tracks
filenames, not content. Do not put `BEGIN`/`COMMIT` in migration files; the
runner owns transaction boundaries.

## Deviations from the draft spec

The draft schema in the product spec was written in a MySQL-ish dialect and
had several production-readiness gaps. Every correction:

1. **Inline `INDEX` keyword removed (invalid PostgreSQL).** The draft
   declared indexes inline inside `CREATE TABLE` column lists (a MySQL-ism).
   PostgreSQL rejects that syntax; all secondary indexes are now standalone
   `CREATE INDEX [IF NOT EXISTS]` statements after each table, which also
   lets them be named, commented on, and (in the future) rebuilt
   `CONCURRENTLY`.
2. **`gross_merchandise_value` widened `NUMERIC(10,2)` → `NUMERIC(12,2)`.**
   `10,2` caps at 99,999,999.99 — under the plausible ceiling for a single
   wholesale/B2B order or a low-unit-value currency. Overflow on the billing
   column would reject the order webhook and silently lose revenue data.
   `estimated_revenue_lost` matches at `NUMERIC(12,2)` for the same reason.
3. **`commission_fee` is a `STORED` generated column, not app-computed.**
   The draft implied the ingestion service would compute the fee. Moving
   `round(gmv * rate, 2)` into the schema makes the database the single
   source of truth for billing math; no code path (service, backfill,
   manual `psql`) can produce an inconsistent fee.
4. **`commission_rate` stored per-row with `DEFAULT 0.00500`.** A global
   config value would retroactively rewrite historic fees on any rate
   change; the per-row snapshot preserves billing history.
5. **`protocol_type` deliberately NOT `CHECK`-constrained.** Agent-commerce
   protocols (`STRIPE_ACP`, `GOOGLE_AP2`, `VISA_INTELLIGENT_COMMERCE`,
   `UNKNOWN_PROTOCOL`, ...) evolve too fast; a `CHECK` here would make
   telemetry ingest fail on the first new protocol. The known values are
   documented in a `COMMENT ON` instead. By contrast,
   `request_method` and `calculated_loss_reason` ARE `CHECK`-constrained —
   those vocabularies are closed (HTTP verbs) or produced by our own sweep
   code (loss reasons), so out-of-list values are bugs worth failing on.
6. **Case-insensitive uniqueness on `shopify_shop_domain`.** The draft had
   only a plain `UNIQUE`. Hostnames are case-insensitive; a functional
   unique index on `lower(shopify_shop_domain)` prevents
   `Shop.myshopify.com` / `shop.myshopify.com` becoming two tenants and
   splitting attribution. A `CHECK (btrim(...) <> '')` also rejects
   empty/whitespace-only domains.
7. **Explicit FK deletion semantics.** The draft left `ON DELETE` behavior
   unspecified in places. Now: everything cascades from
   `merchant_profiles` (offboarding is one `DELETE`);
   `reconciled_agent_orders.intent_log_id` is `SET NULL` (billing survives
   log pruning); `loss_diagnostics.intent_log_id` is `CASCADE` + `UNIQUE`
   (a diagnostic is derivative, and uniqueness makes the sweep idempotent).
8. **`TIMESTAMPTZ` everywhere, never `TIMESTAMP`.** Merchants, edge PoPs,
   and the database do not share a timezone; naive timestamps would corrupt
   the 60-second expiry-window math.
9. **`access_token_encrypted` is `TEXT`, not `VARCHAR(n)`.** AES-256-GCM
   ciphertext + IV + tag encodings vary in length; truncating a credential
   at a `VARCHAR` boundary would be silent and catastrophic.
10. **Sentinel `'UNSPECIFIED'` (NOT NULL) for `target_sku`.** Instead of the
    draft's nullable-ish treatment: keeps the btree dense and lets loss
    analytics `GROUP BY target_sku` without `COALESCE`.
11. **GIN index uses `jsonb_path_ops`, not default `jsonb_ops`.** We only
    need `@>` containment on `inbound_payload`; `jsonb_path_ops` is
    substantially smaller and faster for that on a firehose-scale table.
12. **Non-negativity `CHECK`s on all money columns** (`gmv`,
    `commission_rate`, `estimated_revenue_lost`) — absent from the draft; a
    negative value in any of them indicates upstream corruption and must not
    reach billing.
13. **pgcrypto kept despite PG13+ native `gen_random_uuid()`.** Documented
    guard for PG12-era managed databases; `IF NOT EXISTS` makes it a no-op
    on modern instances.
