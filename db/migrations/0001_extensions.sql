-- ============================================================================
-- AOP :: db/migrations/0001_extensions.sql
--
-- Role in the AOP data flow:
--   Foundation migration for the PostgreSQL storage layer that backs the
--   Agent Optimization Platform. Every downstream table (merchant_profiles,
--   agent_intent_logs, reconciled_agent_orders, loss_diagnostics) depends on
--   the primitives defined here:
--     1. The pgcrypto extension (UUID generation fallback for PG12).
--     2. A reusable set_updated_at() trigger function used by any table that
--        carries an updated_at column (currently merchant_profiles).
--
-- This file MUST run first; the migration runner (db/migrate.mjs) applies
-- files in filename order, which is why migrations carry zero-padded numeric
-- prefixes.
-- ============================================================================

-- gen_random_uuid() has been a native core function since PostgreSQL 13.
-- We still install pgcrypto defensively so the same DDL bootstraps cleanly on
-- a PG12 instance (e.g. a merchant's legacy managed database). On PG13+ this
-- is a harmless no-op guard: IF NOT EXISTS makes it idempotent, and the
-- native function shadows nothing (pgcrypto's gen_random_uuid was folded into
-- core with identical semantics).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- set_updated_at(): shared BEFORE UPDATE trigger function.
--
-- Stamps NEW.updated_at with the transaction timestamp on every row update so
-- application code can never forget (or lie about) modification times. Using
-- now() (= transaction_timestamp()) rather than clock_timestamp() is
-- deliberate: all rows touched in one transaction get the same timestamp,
-- which keeps audit queries consistent with transactional visibility.
--
-- CREATE OR REPLACE keeps re-runs safe if this migration is ever replayed
-- against a database restored from a partial dump.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION set_updated_at() IS
    'Shared BEFORE UPDATE trigger function: stamps NEW.updated_at = now(). '
    'Attach to any table with an updated_at TIMESTAMPTZ column so modification '
    'times are enforced by the database, not by application code.';
