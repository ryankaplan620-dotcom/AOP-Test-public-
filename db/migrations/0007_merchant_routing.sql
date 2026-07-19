-- ============================================================================
-- AOP :: db/migrations/0007_merchant_routing.sql
--
-- Role in the AOP data flow:
--   Closes the onboarding -> edge gap: OAuth install (services/ingestion
--   routes/oauth.js) creates the merchant row, but the edge worker previously
--   resolved proxy hostnames only from its static MERCHANT_ROUTES config —
--   a newly installed merchant was not routable until an operator edited
--   wrangler.toml and redeployed. These columns make merchant_profiles the
--   routing source of truth: the worker resolves unknown hostnames through
--   GET /routes/resolve (ingestion), which reads exactly this table.
--
--     proxy_hostname  the hostname agents hit (e.g. redthread.agents.example
--                     .com); populated at install from the shop handle +
--                     PROXY_HOSTNAME_SUFFIX, or set manually by an operator.
--     origin_url      where the proxy forwards that traffic (the merchant's
--                     storefront origin); defaults to https://<shop domain>
--                     at install.
--
-- Depends on: 0002.
-- ============================================================================

ALTER TABLE merchant_profiles
    ADD COLUMN IF NOT EXISTS proxy_hostname VARCHAR(255),
    ADD COLUMN IF NOT EXISTS origin_url     VARCHAR(512);

-- Hostnames are case-insensitive (RFC 4343): uniqueness and lookups both go
-- through lower(). Partial index — most pre-0007 rows have NULL routing and
-- NULLs must not collide.
CREATE UNIQUE INDEX IF NOT EXISTS merchant_profiles_proxy_hostname_lower_uidx
    ON merchant_profiles (lower(proxy_hostname))
    WHERE proxy_hostname IS NOT NULL;

-- The edge only ever proxies to http(s) origins (edge/src/routing.js rejects
-- everything else); enforce the same contract at rest so a bad row cannot
-- turn the resolve endpoint into a garbage-origin dispenser. Guarded so the
-- migration is idempotent (PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'merchant_profiles_origin_url_scheme'
           AND conrelid = 'merchant_profiles'::regclass
    ) THEN
        ALTER TABLE merchant_profiles
            ADD CONSTRAINT merchant_profiles_origin_url_scheme
            CHECK (origin_url IS NULL OR origin_url ~* '^https?://');
    END IF;
END $$;

COMMENT ON COLUMN merchant_profiles.proxy_hostname IS
    'Hostname agents hit on the AOP edge proxy for this merchant. Resolved '
    'dynamically by the worker via GET /routes/resolve — no worker redeploy '
    'needed when merchants onboard. NULL = not routable dynamically (static '
    'MERCHANT_ROUTES config may still cover it).';

COMMENT ON COLUMN merchant_profiles.origin_url IS
    'Storefront origin the proxy forwards this merchant''s agent traffic to '
    '(http(s) only, CHECK-enforced). Defaults to https://<shop domain> at '
    'OAuth install.';
