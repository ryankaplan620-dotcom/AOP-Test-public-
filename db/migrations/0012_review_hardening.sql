-- ============================================================================
-- AOP :: db/migrations/0012_review_hardening.sql
--
-- Schema-side fixes for adversarially-verified review findings:
--
--   1. purge_expired_telemetry redefined to delete ONE batch per call.
--      The 0006 version looped its whole backlog inside a single plpgsql
--      call = ONE transaction = one statement under the service pool's 15s
--      statement_timeout: any sizable backlog timed out, rolled back ALL
--      batches, and retried identically every 6h — the 90-day compliance cap
--      was silently never enforced. The loop now lives in the CALLER
--      (jobs/retention-sweep.js): each call is its own short transaction.
--
--   2. sweep_state: tiny watermark table so the loss sweep stops re-scanning
--      the entire diagnosed 90-day history oldest-first on every 15s tick
--      (the anti-joins exclude old rows from the RESULT, but the scan still
--      visits them; at firehose scale the query outgrows the statement
--      timeout and the sweep dies permanently).
--
--   3. Plain time indexes for the cross-merchant analytics predicates —
--      every dashboard aggregate filters on these columns with no leading
--      merchant_id, which forced seq scans.
--
--   4. order_adjustment_orphans: refunds/cancellations that arrive BEFORE
--      their order's own webhook (Shopify guarantees no cross-topic
--      ordering) previously got a terminal 200 and the credit was lost
--      forever — merchant overbilled. They now park here and are replayed
--      when the order reconciles.
--
--   5. Drop the redundant exact-match UNIQUE on shopify_shop_domain: the
--      functional lower() index (0002) is the real key and the ONLY arbiter
--      upsertMerchantToken's ON CONFLICT targets; the redundant constraint
--      could 23505 a concurrent duplicate install instead of letting the
--      upsert take its DO UPDATE path.
--
-- Idempotent throughout. Depends on: 0003, 0004, 0006, 0008.
-- ============================================================================

-- ---- 1. Single-batch purge --------------------------------------------------
CREATE OR REPLACE FUNCTION purge_expired_telemetry(
    retention_days integer DEFAULT 90,
    batch_size     integer DEFAULT 10000
)
RETURNS TABLE (intents_deleted bigint)
LANGUAGE plpgsql
AS $$
DECLARE
    cutoff        timestamptz;
    deleted_batch bigint;
BEGIN
    -- Guard rails: a zero/negative retention would delete EVERYTHING that
    -- exists; refuse loudly instead of quietly wiping telemetry.
    IF retention_days IS NULL OR retention_days < 1 THEN
        RAISE EXCEPTION
            'purge_expired_telemetry: retention_days must be >= 1 (got %)',
            retention_days;
    END IF;
    IF batch_size IS NULL OR batch_size < 1 THEN
        RAISE EXCEPTION
            'purge_expired_telemetry: batch_size must be >= 1 (got %)',
            batch_size;
    END IF;

    cutoff := now() - make_interval(days => retention_days);

    -- EXACTLY ONE ctid-batched delete per call. The caller loops while the
    -- returned count equals batch_size — every iteration is its own
    -- statement/transaction, so lock time, WAL, and statement_timeout
    -- exposure are all bounded by ONE batch regardless of backlog size,
    -- and completed batches stay deleted even if a later one fails.
    DELETE FROM agent_intent_logs
    WHERE ctid IN (
        SELECT ctid FROM agent_intent_logs
        WHERE processed_at < cutoff
        LIMIT batch_size
    );
    GET DIAGNOSTICS deleted_batch = ROW_COUNT;

    RETURN QUERY SELECT deleted_batch;
END;
$$;

COMMENT ON FUNCTION purge_expired_telemetry(integer, integer) IS
    'Compliance retention sweep: deletes ONE ctid-batch of agent_intent_logs '
    '(and, via CASCADE, their loss_diagnostics) older than retention_days. '
    'Callers loop while the return equals batch_size — each call is its own '
    'transaction, so a backlog can never exceed statement_timeout (the 0006 '
    'whole-backlog loop could). Never touches reconciled_agent_orders.';

-- ---- 2. Sweep watermark -----------------------------------------------------
CREATE TABLE IF NOT EXISTS sweep_state (
    job_name   VARCHAR(50) PRIMARY KEY,
    -- The instant through which the job has FULLY processed its input.
    watermark  TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE sweep_state IS
    'Per-job progress watermarks. loss_sweep stores the processed_at instant '
    'below which every expired intent has been diagnosed or skipped — the '
    'sweep query adds processed_at >= watermark so each tick scans only the '
    'frontier instead of the whole retention window.';

-- ---- 3. Analytics time indexes ---------------------------------------------
CREATE INDEX IF NOT EXISTS loss_diagnostics_created_at_idx
    ON loss_diagnostics (created_at DESC);
CREATE INDEX IF NOT EXISTS reconciled_agent_orders_reconciled_at_idx
    ON reconciled_agent_orders (reconciled_at DESC);
CREATE INDEX IF NOT EXISTS order_adjustments_adjusted_at_idx
    ON order_adjustments (adjusted_at DESC);

-- ---- 4. Early-credit parking lot -------------------------------------------
CREATE TABLE IF NOT EXISTS order_adjustment_orphans (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id       UUID NOT NULL
                          REFERENCES merchant_profiles(id) ON DELETE CASCADE,
    -- The order the credit is waiting for; NOT an FK (the whole point is
    -- that the reconciled_agent_orders row does not exist yet).
    shopify_order_id  VARCHAR(100) NOT NULL,
    -- Same kind-prefixed idempotency key as order_adjustments.
    source_event_id   VARCHAR(120) NOT NULL,
    adjustment_kind   VARCHAR(20) NOT NULL
                          CONSTRAINT order_adjustment_orphans_kind_allowed
                          CHECK (adjustment_kind IN ('REFUND', 'CANCELLATION')),
    -- NULL = "credit everything remaining" (cancellation semantics).
    requested_gmv     NUMERIC(12,2)
                          CONSTRAINT order_adjustment_orphans_gmv_positive
                          CHECK (requested_gmv IS NULL OR requested_gmv > 0),
    requested_currency CHAR(3)
                          CONSTRAINT order_adjustment_orphans_currency_shape
                          CHECK (requested_currency IS NULL OR requested_currency ~ '^[A-Z]{3}$'),
    received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT order_adjustment_orphans_source_event_id_key
        UNIQUE (source_event_id)
);

-- Replay lookup when the order's own webhook finally reconciles it.
CREATE INDEX IF NOT EXISTS order_adjustment_orphans_order_idx
    ON order_adjustment_orphans (merchant_id, shopify_order_id);

COMMENT ON TABLE order_adjustment_orphans IS
    'Refund/cancellation webhooks that arrived before their order was '
    'reconciled (Shopify does not order deliveries across topics). Replayed '
    'into order_adjustments when the orders/create webhook lands; without '
    'this the credit was acknowledged and lost — merchant overbilled.';

-- ---- 5. Drop redundant exact-match unique ----------------------------------
ALTER TABLE merchant_profiles
    DROP CONSTRAINT IF EXISTS merchant_profiles_shop_domain_key;
