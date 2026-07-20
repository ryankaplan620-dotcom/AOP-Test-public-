-- ============================================================================
-- AOP :: db/migrations/0015_merchant_enrichment.sql
--
-- Edge response enrichment: per-merchant storage for OPTIMIZER-VERIFIED
-- schema.org JSON-LD that the edge proxy injects into the merchant's HTML
-- responses (feature-gated, off by default).
--
-- Provenance contract (fabrication guard): the stored payload is produced by
-- the optimizer (build_policy_jsonld / claims injector) from facts the
-- merchant supplied — policy text, product records. The platform operator
-- stores it via PUT /analytics/enrichment (which validates shape and size);
-- the edge injects it VERBATIM. Nothing in this pipeline invents content.
--
-- Columns (on merchant_profiles — 1:1 with the tenant, like routing):
--   enrichment_enabled  feature gate; false = edge never touches responses.
--   enrichment_jsonld   the JSON-LD payload (object or array of objects).
--   enrichment_updated_at  audit stamp for "which version is live".
--
-- CHECK: the gate can never be on without a payload — an enabled merchant
-- with NULL JSON-LD would make the edge buffer HTML for nothing.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + guarded constraint. Depends on: 0002.
-- ============================================================================

ALTER TABLE merchant_profiles
    ADD COLUMN IF NOT EXISTS enrichment_enabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE merchant_profiles
    ADD COLUMN IF NOT EXISTS enrichment_jsonld JSONB;

ALTER TABLE merchant_profiles
    ADD COLUMN IF NOT EXISTS enrichment_updated_at TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'merchant_profiles_enrichment_payload_check'
           AND conrelid = 'merchant_profiles'::regclass
    ) THEN
        ALTER TABLE merchant_profiles
            ADD CONSTRAINT merchant_profiles_enrichment_payload_check
            CHECK (NOT enrichment_enabled OR enrichment_jsonld IS NOT NULL);
    END IF;
END
$$;
