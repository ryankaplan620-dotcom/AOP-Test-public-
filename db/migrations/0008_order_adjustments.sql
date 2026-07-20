-- ============================================================================
-- AOP :: db/migrations/0008_order_adjustments.sql
--
-- Role in the AOP data flow:
--   order_adjustments is the billing CREDIT ledger. reconciled_agent_orders
--   (0004) records commission the moment an agent-attributed order is
--   created — but orders get refunded and cancelled, and a commission billed
--   on returned GMV is a dispute waiting to happen. When a Shopify
--   refunds/create or orders/cancelled webhook reaches the ingestion service,
--   it INSERTs one row here crediting back the adjusted GMV share of the fee.
--
--   Ledger semantics (deliberate): the original order row is NEVER mutated —
--   an immutable charge plus explicit credits is auditable and replayable,
--   while in-place GMV updates would silently rewrite closed statements.
--   Statements net the two: billed = sum(commission_fee) - sum(commission_credit).
--
--   Credits land in the month the ADJUSTMENT happened (not the order month):
--   a January order refunded in February credits February's statement, which
--   matches how the fee was actually collected.
--
-- Invariants enforced IN THE SCHEMA, mirroring 0004:
--   - source_event_id UNIQUE       -> webhook redelivery cannot double-credit;
--   - commission_credit GENERATED  -> credit math cannot drift from the data;
--   - commission_rate copied from the parent order row at insert time (the
--     repository INSERT..SELECTs it) so a credit always reverses fee at the
--     SAME rate the order was billed at, even across platform rate changes.
--
-- Depends on: 0001, 0004.
-- ============================================================================

CREATE TABLE IF NOT EXISTS order_adjustments (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Tenant ownership; cascades with merchant offboarding (0004 does too,
    -- so the parent order row and its credits leave together).
    merchant_id             UUID NOT NULL
                                REFERENCES merchant_profiles(id) ON DELETE CASCADE,

    -- The charged order this credit reverses (part of). CASCADE: a credit
    -- without its charge is meaningless in every statement query.
    reconciled_order_id     UUID NOT NULL
                                REFERENCES reconciled_agent_orders(id) ON DELETE CASCADE,

    -- Idempotency key for at-least-once webhook delivery, kind-prefixed by
    -- the ingestion service so the two topics can never collide:
    --   'refund:<shopify refund id>'  |  'cancel:<shopify order id>'
    source_event_id         VARCHAR(120) NOT NULL,

    adjustment_kind         VARCHAR(20) NOT NULL
                                CONSTRAINT order_adjustments_kind_allowed
                                CHECK (adjustment_kind IN ('REFUND', 'CANCELLATION')),

    -- GMV being credited back, in the parent order's currency. Positive by
    -- convention (this whole table IS the negative side of the ledger).
    -- The repository insert clamps it so the SUM of a given order's
    -- adjustments can never exceed the order's GMV.
    adjusted_gmv            NUMERIC(12,2) NOT NULL
                                CONSTRAINT order_adjustments_gmv_positive
                                CHECK (adjusted_gmv > 0),

    -- Rate snapshot COPIED from the parent order row at insert time (a
    -- generated column cannot reference another table). Same bounds as 0004.
    commission_rate         NUMERIC(6,5) NOT NULL
                                CONSTRAINT order_adjustments_rate_bounds
                                CHECK (commission_rate >= 0 AND commission_rate <= 1),

    -- Credit math lives in the schema, exactly like the fee it reverses:
    -- no code path can write a credit inconsistent with gmv * rate.
    commission_credit       NUMERIC(12,2)
                                GENERATED ALWAYS AS
                                (round(adjusted_gmv * commission_rate, 2))
                                STORED,

    adjusted_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT order_adjustments_source_event_id_key
        UNIQUE (source_event_id)
);

-- ----------------------------------------------------------------------------
-- Indexes.
-- ----------------------------------------------------------------------------

-- "All credits for this order" — the over-refund clamp sums these on every
-- refund insert, and per-order drill-downs read them.
CREATE INDEX IF NOT EXISTS order_adjustments_reconciled_order_idx
    ON order_adjustments (reconciled_order_id);

-- Per-merchant monthly statement scans, newest first (matches 0004's
-- merchant/reconciled_at index shape).
CREATE INDEX IF NOT EXISTS order_adjustments_merchant_adjusted_idx
    ON order_adjustments (merchant_id, adjusted_at DESC);

-- ----------------------------------------------------------------------------
-- Documentation comments.
-- ----------------------------------------------------------------------------
COMMENT ON TABLE order_adjustments IS
    'Billing credit ledger: refunds/cancellations of reconciled agent orders. '
    'Never mutates the charge row; statements net charges minus credits. '
    'source_event_id uniqueness makes webhook redelivery idempotent.';

COMMENT ON COLUMN order_adjustments.source_event_id IS
    'Kind-prefixed Shopify event key (refund:<refund id> | cancel:<order id>). '
    'UNIQUE: the idempotency key for at-least-once webhook delivery.';

COMMENT ON COLUMN order_adjustments.adjusted_gmv IS
    'GMV credited back (positive), clamped by the repository insert so an '
    'order''s total adjustments never exceed its gross_merchandise_value.';

COMMENT ON COLUMN order_adjustments.commission_rate IS
    'Snapshot copied from the parent reconciled_agent_orders row so credits '
    'reverse fees at the rate actually billed, across rate changes.';

COMMENT ON COLUMN order_adjustments.commission_credit IS
    'STORED generated column: round(adjusted_gmv * commission_rate, 2). The '
    'schema is the single source of truth for credit math.';
