-- ============================================================================
-- AOP :: db/migrations/0005_loss_diagnostics.sql
--
-- Role in the AOP data flow:
--   loss_diagnostics answers the merchant's most valuable question: "why did
--   an AI agent look at my product and then NOT buy?". A scheduled sweep job
--   in the Node.js ingestion service finds agent_intent_logs rows whose
--   60-second conversion window has expired with no matching row in
--   reconciled_agent_orders (matched by transaction_token), classifies the
--   drop-off cause, estimates the revenue lost, and writes exactly ONE
--   diagnostic row per expired intent here. The merchant dashboard reads this
--   table for the "why agents drop off" analytics.
--
-- Depends on: 0001, 0002, 0003.
-- ============================================================================

CREATE TABLE IF NOT EXISTS loss_diagnostics (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Tenant ownership; cascades with merchant offboarding.
    merchant_id              UUID NOT NULL
                                 REFERENCES merchant_profiles(id) ON DELETE CASCADE,

    -- Exactly one diagnostic per expired intent: UNIQUE makes the sweep job
    -- idempotent at the schema level — if the sweep crashes mid-run and
    -- re-scans the same window, the second INSERT for an already-diagnosed
    -- intent fails cleanly instead of double-counting lost revenue.
    -- CASCADE (unlike reconciled_agent_orders.intent_log_id): a diagnostic is
    -- a pure derivative of its intent row and is meaningless without it, so
    -- it follows the intent through retention pruning.
    intent_log_id            UUID NOT NULL
                                 REFERENCES agent_intent_logs(id) ON DELETE CASCADE,

    -- Denormalized from the intent row so per-SKU loss dashboards never need
    -- to join back into the firehose table.
    target_sku               VARCHAR(100) NOT NULL,

    -- Closed classification vocabulary. Unlike protocol_type on
    -- agent_intent_logs, this IS CHECK-constrained: the values are produced
    -- by OUR sweep job (not by evolving third-party protocols), so an
    -- out-of-list value is a bug we want to fail loudly. Extending the list
    -- is a deliberate migration, not a silent drift.
    calculated_loss_reason   VARCHAR(100) NOT NULL
                                 CONSTRAINT loss_diagnostics_reason_check
                                 CHECK (calculated_loss_reason IN
                                     ('PRICE_DISCREPANCY',
                                      'SHIPPING_LATENCY',
                                      'STOCK_OUTAGE',
                                      'POLICY_AMBIGUITY',
                                      'PROTOCOL_ERROR',
                                      'UNKNOWN_DROPOFF')),

    -- Estimated GMV that walked away. NUMERIC(12,2) to match the money
    -- precision of reconciled_agent_orders (an estimate should not overflow
    -- before the real order column would). DEFAULT 0: a drop-off whose value
    -- could not be estimated is still worth recording.
    estimated_revenue_lost   NUMERIC(12,2) NOT NULL DEFAULT 0
                                 CONSTRAINT loss_diagnostics_revenue_nonnegative
                                 CHECK (estimated_revenue_lost >= 0),

    -- Optional evidence blob: competitor price/shipping deltas observed at
    -- classification time (e.g. {"competitor_price": 18.99, "our_price":
    -- 24.99}). JSONB and schemaless on purpose — evidence shape differs per
    -- loss reason.
    competitor_delta_payload JSONB,

    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT loss_diagnostics_intent_log_id_key
        UNIQUE (intent_log_id)
);

-- ----------------------------------------------------------------------------
-- Indexes.
-- (intent_log_id needs no extra index: the UNIQUE constraint above already
--  provides the btree used by FK maintenance and lookups.)
-- ----------------------------------------------------------------------------

-- Dashboard feed: a merchant's recent losses, newest first.
CREATE INDEX IF NOT EXISTS loss_diagnostics_merchant_created_idx
    ON loss_diagnostics (merchant_id, created_at DESC);

-- "Which SKU is bleeding the most?" aggregations.
CREATE INDEX IF NOT EXISTS loss_diagnostics_target_sku_idx
    ON loss_diagnostics (target_sku);

-- Reason-level rollups ("what share of drop-offs are STOCK_OUTAGE?").
-- Low cardinality, but the dashboard filters on it constantly and the table
-- grows with every non-converting intent, so the btree still pays for itself.
CREATE INDEX IF NOT EXISTS loss_diagnostics_loss_reason_idx
    ON loss_diagnostics (calculated_loss_reason);

-- ----------------------------------------------------------------------------
-- Documentation comments.
-- ----------------------------------------------------------------------------
COMMENT ON TABLE loss_diagnostics IS
    'One row per agent intent that expired (60-second window) without '
    'converting to a reconciled order. Written by the sweep job; read by the '
    '"why agents drop off" merchant analytics.';

COMMENT ON COLUMN loss_diagnostics.intent_log_id IS
    'The expired intent this diagnostic explains. UNIQUE enforces exactly one '
    'diagnostic per intent (sweep idempotency); cascades with intent pruning.';

COMMENT ON COLUMN loss_diagnostics.target_sku IS
    'SKU denormalized from the intent row so per-SKU loss dashboards avoid '
    'joining the telemetry firehose.';

COMMENT ON COLUMN loss_diagnostics.calculated_loss_reason IS
    'Sweep-job classification of the drop-off. CHECK-constrained closed set: '
    'PRICE_DISCREPANCY, SHIPPING_LATENCY, STOCK_OUTAGE, POLICY_AMBIGUITY, '
    'PROTOCOL_ERROR, UNKNOWN_DROPOFF.';

COMMENT ON COLUMN loss_diagnostics.estimated_revenue_lost IS
    'Best-effort GMV estimate of the missed conversion; 0 when no estimate '
    'was possible.';

COMMENT ON COLUMN loss_diagnostics.competitor_delta_payload IS
    'Optional JSONB evidence captured at classification time (competitor '
    'price/shipping deltas etc.); shape varies by loss reason.';
