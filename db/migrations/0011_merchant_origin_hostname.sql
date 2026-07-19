-- ============================================================================
-- AOP :: db/migrations/0011_merchant_origin_hostname.sql
--
-- Role in the AOP data flow:
--   Splits the TWO merchant identities that were being forced through one
--   column. merchant_profiles.shopify_shop_domain is the *.myshopify.com key
--   Shopify itself uses (OAuth install, X-Shopify-Shop-Domain on webhooks).
--   But edge telemetry records shop_domain = the RESOLVED ORIGIN hostname
--   (wrangler.toml contract), and for any merchant whose storefront origin is
--   a custom domain (the standard production Shopify setup) those two values
--   differ — so telemetry lookups against shopify_shop_domain silently
--   dropped 100% of that merchant's intents (skipped_unknown_merchant),
--   or, seeded the other way around, every real webhook missed instead and
--   no commission was ever billed.
--
--   Fix: origin_hostname, GENERATED from origin_url (always in sync, no code
--   path can forget to maintain it), lets the telemetry path resolve
--   merchants by EITHER key (findMerchantForTelemetry) while webhooks/OAuth
--   stay strictly keyed by the myshopify domain.
--
-- Idempotent: guarded DO block (ADD COLUMN IF NOT EXISTS cannot be used with
-- a generated column expression change) + CREATE INDEX IF NOT EXISTS.
-- Depends on: 0007.
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'merchant_profiles'
           AND column_name = 'origin_hostname'
    ) THEN
        -- lower() first so any scheme/host casing admitted by the 0007 CHECK
        -- (~* '^https?://') normalizes; the capture stops at path/port/query.
        -- substring(text from regex) is IMMUTABLE, so it is legal here.
        ALTER TABLE merchant_profiles
            ADD COLUMN origin_hostname VARCHAR(255)
            GENERATED ALWAYS AS
            (substring(lower(origin_url) from '^https?://([^/:?#]+)'))
            STORED;
    END IF;
END
$$;

-- Telemetry-resolution lookup index. Partial: rows without routing configured
-- can never match a telemetry record. NOT unique — two profiles pointing at
-- one origin is an operator error the lookup tolerates (LIMIT 1), not a
-- state worth refusing to store.
CREATE INDEX IF NOT EXISTS merchant_profiles_origin_hostname_idx
    ON merchant_profiles (origin_hostname)
    WHERE origin_hostname IS NOT NULL;

COMMENT ON COLUMN merchant_profiles.origin_hostname IS
    'GENERATED: hostname of origin_url, lowercased. The edge records the '
    'resolved origin hostname as telemetry shop_domain; this column lets the '
    'ingest path resolve those records for custom-domain merchants while '
    'shopify_shop_domain stays the strict *.myshopify.com key for '
    'webhooks/OAuth.';
