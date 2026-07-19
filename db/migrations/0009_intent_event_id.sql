-- ============================================================================
-- AOP :: db/migrations/0009_intent_event_id.sql
--
-- Role in the AOP data flow:
--   Cloudflare Queues delivers telemetry batches AT LEAST ONCE: if the
--   ingestion POST succeeds but the ack is lost (worker eviction, network
--   blip after commit), the SAME records are redelivered and re-inserted —
--   silently inflating impressions, sessions, and loss diagnostics.
--
--   Fix: the edge stamps every record with a random event_id AT REQUEST TIME
--   (before queue.send), so a redelivered message carries the SAME ids. This
--   partial unique index turns re-insertion into an ON CONFLICT no-op in
--   insertIntentLogsBatch (services/ingestion/src/repositories.js).
--
--   Partial (WHERE event_id IS NOT NULL) on purpose: rows ingested before
--   this migration — and records from an older edge build that doesn't stamp
--   ids — carry NULL and must neither conflict with each other nor pay index
--   maintenance. NULLs are distinct in a plain unique index anyway, but the
--   partial form also keeps legacy rows out of the index entirely.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
-- Depends on: 0003.
-- ============================================================================

ALTER TABLE agent_intent_logs
    ADD COLUMN IF NOT EXISTS event_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS agent_intent_logs_event_id_uidx
    ON agent_intent_logs (event_id)
    WHERE event_id IS NOT NULL;

COMMENT ON COLUMN agent_intent_logs.event_id IS
    'Edge-minted per-record UUID, stable across Cloudflare Queues '
    'redeliveries. Partial unique index makes batch re-insertion an '
    'ON CONFLICT no-op (ingest idempotency). NULL on pre-0009 rows and '
    'records from edge builds that predate id stamping.';
