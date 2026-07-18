-- ============================================================================
-- AOP :: db/migrations/0004_reconciled_agent_orders.sql
--
-- Role in the AOP data flow:
--   reconciled_agent_orders is the money table. When a Shopify order-created
--   webhook reaches the Node.js ingestion service, the service looks up the
--   order's X-Agent-Transaction-Token against agent_intent_logs (cookie-less
--   attribution). A successful match INSERTs one row here, stitching the
--   purchase back to the agent intent that produced it, recording the GMV,
--   and computing AOP's 0.5% commission. This table is the source of truth
--   for merchant billing, so its invariants are enforced IN THE SCHEMA:
--     - shopify_order_id UNIQUE  -> webhook redelivery cannot double-bill;
--     - commission_fee GENERATED -> billing math cannot drift from the data.
--
-- Depends on: 0001, 0002, 0003.
-- ============================================================================

CREATE TABLE IF NOT EXISTS reconciled_agent_orders (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Tenant ownership; cascades with merchant offboarding.
    merchant_id             UUID NOT NULL
                                REFERENCES merchant_profiles(id) ON DELETE CASCADE,

    -- Back-pointer to the specific intent row this order was attributed to.
    -- Nullable + ON DELETE SET NULL (NOT cascade): billing records must
    -- survive telemetry retention pruning. If old intent logs are purged,
    -- the financial row keeps standing with the link severed. Also NULL when
    -- attribution matched on token alone after the intent row was already
    -- swept (late webhook edge case).
    intent_log_id           UUID
                                REFERENCES agent_intent_logs(id) ON DELETE SET NULL,

    -- Shopify's order identifier (numeric ID or GID string — VARCHAR, not
    -- BIGINT, because Shopify GraphQL GIDs are not numeric). UNIQUE is the
    -- idempotency backstop for Shopify's at-least-once webhook delivery:
    -- a redelivered webhook becomes a constraint violation the ingestion
    -- service treats as "already reconciled", never a duplicate commission.
    shopify_order_id        VARCHAR(100) NOT NULL,

    -- Denormalized copy of the attribution token. Kept even though
    -- intent_log_id exists so attribution reporting still works after the
    -- intent row is pruned (see intent_log_id comment).
    transaction_token       VARCHAR(255) NOT NULL,

    -- Order GMV in the merchant's currency. NUMERIC(12,2) — widened from the
    -- draft spec's NUMERIC(10,2): 10,2 caps at 99,999,999.99, which a single
    -- high-volume B2B/wholesale order (or a low-unit-value currency like IDR
    -- or JPY-minor pricing) can plausibly exceed; overflowing the billing
    -- column would reject the webhook and lose revenue data. 12,2 raises the
    -- ceiling to 9,999,999,999.99. NUMERIC (never FLOAT) because this is
    -- money.
    gross_merchandise_value NUMERIC(12,2) NOT NULL
                                CONSTRAINT reconciled_agent_orders_gmv_nonnegative
                                CHECK (gross_merchandise_value >= 0),

    -- The commission rate APPLIED TO THIS ROW, snapshotted at reconciliation
    -- time. Default 0.00500 = the flat 0.5%-of-GMV platform fee. Stored
    -- per-row (not read from config at query time) so that if the platform
    -- rate ever changes, historic rows keep the rate they were actually
    -- billed at. Bounded to [0, 1]: NUMERIC(6,5) could otherwise admit up to
    -- 9.99999 (999.999%), and since commission_fee is generated from this
    -- column, a fat-fingered rate (e.g. 5 instead of 0.005) would produce a
    -- schema-blessed fee of 5x GMV in the billing source-of-truth table.
    commission_rate         NUMERIC(6,5) NOT NULL DEFAULT 0.00500
                                CONSTRAINT reconciled_agent_orders_rate_bounds
                                CHECK (commission_rate >= 0 AND commission_rate <= 1),

    -- Billing math lives in the schema, not in app code: a STORED generated
    -- column makes the database the single source of truth for the fee.
    -- No code path (ingestion service, backfill script, manual psql UPDATE)
    -- can ever write a fee inconsistent with gmv * rate. round(x, 2) is
    -- immutable for NUMERIC, so it is legal in a generated column, and it
    -- pins half-up cent rounding in one place.
    commission_fee          NUMERIC(12,2)
                                GENERATED ALWAYS AS
                                (round(gross_merchandise_value * commission_rate, 2))
                                STORED,

    reconciled_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT reconciled_agent_orders_shopify_order_id_key
        UNIQUE (shopify_order_id)
);

-- ----------------------------------------------------------------------------
-- Indexes.
-- ----------------------------------------------------------------------------

-- Attribution lookups from token to order (e.g. "did this token convert?" —
-- the sweep job asks exactly this before writing a loss diagnostic).
CREATE INDEX IF NOT EXISTS reconciled_agent_orders_transaction_token_idx
    ON reconciled_agent_orders (transaction_token);

-- Per-merchant billing/statement queries, newest first (DESC matches the
-- dominant ORDER BY so no sort node is needed).
CREATE INDEX IF NOT EXISTS reconciled_agent_orders_merchant_reconciled_idx
    ON reconciled_agent_orders (merchant_id, reconciled_at DESC);

-- FK-side index: PostgreSQL does not auto-index the referencing side, and
-- both the ON DELETE SET NULL maintenance and "order for this intent" lookups
-- need it. UNIQUE enforces the attribution invariant that one intent ping is
-- credited with at most ONE order (the ER contract documented in db/README):
-- without it two webhook flows could both claim the same intent. Multiple
-- NULLs remain allowed, so pruned-intent / late-webhook rows are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS reconciled_agent_orders_intent_log_id_idx
    ON reconciled_agent_orders (intent_log_id);

-- ----------------------------------------------------------------------------
-- Documentation comments.
-- ----------------------------------------------------------------------------
COMMENT ON TABLE reconciled_agent_orders IS
    'Shopify orders successfully attributed to an AI-agent intent via '
    'X-Agent-Transaction-Token. Source of truth for GMV and the 0.5% platform '
    'commission; shopify_order_id uniqueness makes webhook redelivery '
    'idempotent.';

COMMENT ON COLUMN reconciled_agent_orders.intent_log_id IS
    'Attributed intent row; NULL if the intent log was pruned or already '
    'swept (ON DELETE SET NULL keeps billing records alive independently of '
    'telemetry retention).';

COMMENT ON COLUMN reconciled_agent_orders.shopify_order_id IS
    'Shopify order identifier (numeric ID or GraphQL GID). UNIQUE: the '
    'idempotency key for at-least-once webhook delivery.';

COMMENT ON COLUMN reconciled_agent_orders.transaction_token IS
    'Denormalized X-Agent-Transaction-Token copy so attribution survives '
    'intent-log pruning.';

COMMENT ON COLUMN reconciled_agent_orders.gross_merchandise_value IS
    'Order GMV in merchant currency. NUMERIC(12,2), widened from the draft''s '
    '10,2 so large wholesale orders / low-unit-value currencies cannot '
    'overflow the billing column.';

COMMENT ON COLUMN reconciled_agent_orders.commission_rate IS
    'Rate applied to THIS row, snapshotted at reconciliation (default 0.00500 '
    '= 0.5%). Per-row so historic rows survive future platform rate changes.';

COMMENT ON COLUMN reconciled_agent_orders.commission_fee IS
    'STORED generated column: round(gross_merchandise_value * commission_rate, 2). '
    'The schema — not application code — is the single source of truth for '
    'billing math; this column can never be written directly.';
