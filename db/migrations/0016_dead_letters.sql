-- ============================================================================
-- AOP :: db/migrations/0016_dead_letters.sql
--
-- Dead-letter preservation (PR13): telemetry batches that exhausted every
-- Cloudflare Queues retry land in the "aop-edge-telemetry-dlq" queue; the
-- edge worker's DLQ consumer drains them into POST /ingest/dead-letters and
-- THIS table preserves the raw records for inspection/replay instead of
-- losing them silently. The platform dashboard surfaces the recent count as
-- an operational alert.
--
-- Not merchant-scoped: a dead-lettered record may be exactly the kind of
-- malformed/unattributable payload that failed ingestion in the first
-- place, so rows carry the raw record verbatim (PII was already redacted at
-- the edge before the record ever entered the queue).
--
-- Retention: purged alongside intent telemetry by the retention sweep
-- (same RETENTION_DAYS bound) — preserved evidence, not a second archive.
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS only.
-- ============================================================================

CREATE TABLE IF NOT EXISTS dead_letter_telemetry (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Where/why the record dead-lettered (e.g. 'edge_dlq').
    reason VARCHAR(120) NOT NULL DEFAULT 'unknown',

    -- The raw telemetry record as it sat on the queue.
    record JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS dead_letter_telemetry_received_idx
    ON dead_letter_telemetry (received_at DESC);
