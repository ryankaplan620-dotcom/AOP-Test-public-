-- ============================================================================
-- AOP :: db/migrations/0017_dead_letter_dedupe.sql
--
-- Dead-letter idempotency (PR13 review fix): Cloudflare Queues delivery is
-- at-least-once — a preservation POST whose 200 reply was lost gets the
-- whole batch REDELIVERED, and without a dedupe key every record would be
-- stored twice. The edge DLQ consumer now sends "<queue>:<message id>" per
-- record; insertDeadLetters writes it here with ON CONFLICT (dedupe_key)
-- DO NOTHING (this unique index is the arbiter).
--
-- Shipped as its own migration (NOT an amendment to 0016): migrate.mjs
-- tracks applied migrations by filename, so an edited 0016 would be
-- silently skipped on any database that already ran it — leaving
-- insertDeadLetters to 42703 on a missing column and the DLQ drain
-- permanently broken.
--
-- NULL dedupe_key = no dedupe for that row (a unique index treats NULLs as
-- distinct), so callers without ids keep working.
--
-- Idempotent: guarded ALTER + CREATE INDEX IF NOT EXISTS only.
-- ============================================================================

ALTER TABLE dead_letter_telemetry ADD COLUMN IF NOT EXISTS dedupe_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS dead_letter_telemetry_dedupe_idx
    ON dead_letter_telemetry (dedupe_key);
