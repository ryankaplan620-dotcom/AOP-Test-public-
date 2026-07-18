-- ============================================================================
-- AOP :: db/migrations/0006_telemetry_retention.sql
--
-- Role in the AOP data flow:
--   Implements the 90-day telemetry retention cap mandated by the AOP
--   Legal/Compliance memo ("Agent Data Privacy"): intercepted agent traffic
--   is analytics exhaust, and capping how long it is stored minimizes the
--   platform's liability surface as a pass-through analytics processor.
--
-- What is purged vs. what survives:
--   - agent_intent_logs older than the retention window are DELETEd. Their
--     dependent loss_diagnostics rows go with them (intent_log_id is
--     ON DELETE CASCADE) — a loss diagnosis is derived telemetry, not a
--     financial record.
--   - reconciled_agent_orders are NEVER purged here: they are billing records
--     (GMV + commission source of truth). Their intent_log_id FK is
--     ON DELETE SET NULL precisely so billing survives telemetry pruning,
--     and the denormalized transaction_token keeps attribution reporting
--     functional after the intent row is gone.
--
-- Invocation: SELECT * FROM purge_expired_telemetry();          -- default 90d
--             SELECT * FROM purge_expired_telemetry(30);        -- tighter cap
-- Intended to be called by a scheduled job (pg_cron, a k8s CronJob running
-- psql, or the ingestion service's maintenance loop). Batched DELETEs keep
-- each transaction's lock/WAL footprint bounded on large backlogs.
--
-- Depends on: 0003, 0004, 0005.
-- ============================================================================

-- Purge scans are pure time-range scans (processed_at < cutoff) across ALL
-- merchants. The existing (merchant_id, processed_at DESC) composite cannot
-- serve that without a leading merchant_id, so the sweep gets its own
-- single-column index.
CREATE INDEX IF NOT EXISTS agent_intent_logs_processed_at_idx
    ON agent_intent_logs (processed_at);

-- One retention pass, batched. Returns the number of intent rows deleted so
-- schedulers can log/alert on purge volume.
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
    deleted_total bigint := 0;
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

    LOOP
        -- ctid-batched delete: grabs at most batch_size victims per pass so
        -- one giant DELETE cannot hold row locks / bloat WAL for minutes.
        -- loss_diagnostics rows cascade with each intent automatically.
        DELETE FROM agent_intent_logs
        WHERE ctid IN (
            SELECT ctid FROM agent_intent_logs
            WHERE processed_at < cutoff
            LIMIT batch_size
        );
        GET DIAGNOSTICS deleted_batch = ROW_COUNT;
        deleted_total := deleted_total + deleted_batch;
        EXIT WHEN deleted_batch < batch_size;
    END LOOP;

    RETURN QUERY SELECT deleted_total;
END;
$$;

COMMENT ON FUNCTION purge_expired_telemetry(integer, integer) IS
    'Compliance retention sweep: deletes agent_intent_logs (and, via CASCADE, '
    'their loss_diagnostics) older than retention_days (default 90, the cap '
    'set by the AOP data-privacy memo). Never touches reconciled_agent_orders '
    '— billing records outlive telemetry. Batched by ctid to bound lock/WAL '
    'cost; returns the total intent rows deleted.';

COMMENT ON INDEX agent_intent_logs_processed_at_idx IS
    'Serves the retention sweep''s cross-merchant time-range scan '
    '(processed_at < cutoff); the composite merchant/processed index cannot.';
