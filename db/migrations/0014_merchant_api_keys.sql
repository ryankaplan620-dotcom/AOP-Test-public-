-- ============================================================================
-- AOP :: db/migrations/0014_merchant_api_keys.sql
--
-- Multi-tenant dashboard auth: per-merchant API keys for the read-only
-- /analytics surface. Until now a single DASHBOARD_API_TOKEN saw every
-- merchant's numbers; that stays as the PLATFORM (operator) credential, and
-- this table adds merchant-scoped credentials the platform issues.
--
-- Security model:
--   - The plaintext key is NEVER stored. The service shows it exactly once
--     at creation and persists only its SHA-256 hex digest (key_hash). A
--     leaked database dump therefore contains no usable credentials.
--   - key_prefix holds the first characters of the plaintext ("aop_live_"
--     plus a short leader) purely so humans can tell keys apart in a list;
--     it is far too short to reconstruct the key.
--   - Revocation is a tombstone (revoked_at), not a DELETE: billing/audit
--     trails can show which key was live when, and a revoked hash can never
--     be silently re-issued because key_hash stays UNIQUE forever.
--   - ON DELETE CASCADE: keys are meaningless without their merchant.
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS only. Depends on: 0002.
-- ============================================================================

CREATE TABLE IF NOT EXISTS merchant_api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    merchant_id UUID NOT NULL
        REFERENCES merchant_profiles (id) ON DELETE CASCADE,

    -- SHA-256 of the full plaintext key, lowercase hex. UNIQUE doubles as
    -- the lookup index for the auth hot path.
    key_hash CHAR(64) NOT NULL,

    -- Display-only identifier (e.g. 'aop_live_3f9a'). Never used for auth.
    key_prefix VARCHAR(16) NOT NULL,

    -- Operator-facing note ("staging dashboard", "Acme finance team").
    label VARCHAR(120),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ,

    CONSTRAINT merchant_api_keys_key_hash_key UNIQUE (key_hash),
    -- Digest shape is load-bearing: the auth path compares lowercase hex; a
    -- row that somehow held uppercase or non-hex could never match and would
    -- be dead weight — reject it at write time.
    CONSTRAINT merchant_api_keys_hash_shape CHECK (key_hash ~ '^[0-9a-f]{64}$')
);

-- Key management lists a merchant's keys; the auth path never scans this.
CREATE INDEX IF NOT EXISTS merchant_api_keys_merchant_idx
    ON merchant_api_keys (merchant_id);
