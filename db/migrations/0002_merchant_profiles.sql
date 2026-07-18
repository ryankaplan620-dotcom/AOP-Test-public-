-- ============================================================================
-- AOP :: db/migrations/0002_merchant_profiles.sql
--
-- Role in the AOP data flow:
--   merchant_profiles is the tenant root of the entire platform. Every other
--   table (agent_intent_logs, reconciled_agent_orders, loss_diagnostics)
--   hangs off merchant_profiles.id via ON DELETE CASCADE, so offboarding a
--   merchant is a single DELETE and can never strand orphaned telemetry.
--
--   Rows are created when a merchant installs the AOP app on their headless
--   Shopify store. The Node.js ingestion service uses this table to:
--     - resolve the merchant that an intent log / order webhook belongs to
--       (keyed by shopify_shop_domain), and
--     - fetch the (encrypted) Shopify Admin API access token needed to call
--       back into Shopify during reconciliation.
--
-- Depends on: 0001_extensions.sql (gen_random_uuid guard + set_updated_at()).
-- ============================================================================

CREATE TABLE IF NOT EXISTS merchant_profiles (
    -- UUID PKs (vs BIGSERIAL) so IDs can be minted edge-side or app-side
    -- without a DB round-trip and never leak row-count/ordering information
    -- to external agents.
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- The canonical "<shop>.myshopify.com" domain. VARCHAR(255) matches the
    -- DNS hostname length ceiling. The column-level UNIQUE gives exact-match
    -- dedupe; a stricter case-insensitive unique index is added below.
    shopify_shop_domain    VARCHAR(255) NOT NULL,

    -- Ciphertext ONLY. The Shopify Admin API access token is encrypted at the
    -- application layer with AES-256-GCM before it ever reaches the database;
    -- plaintext tokens must never be written here. TEXT (not VARCHAR) because
    -- ciphertext + IV + auth tag encodings vary in length and truncating a
    -- credential would be catastrophic and silent.
    access_token_encrypted TEXT NOT NULL,

    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Exact-match uniqueness (fast FK-style lookups by the ingestion service).
    CONSTRAINT merchant_profiles_shop_domain_key
        UNIQUE (shopify_shop_domain),

    -- Reject '' and whitespace-only domains: a blank domain would make the
    -- webhook -> merchant resolution path silently match nothing.
    CONSTRAINT merchant_profiles_shop_domain_not_empty
        CHECK (btrim(shopify_shop_domain) <> '')
);

-- Case-insensitive uniqueness. Shopify domains are lowercase by convention,
-- but webhook payloads and manually-entered onboarding forms are not
-- guaranteed to agree on casing; without this index "Shop.myshopify.com" and
-- "shop.myshopify.com" would become two tenants and split attribution.
CREATE UNIQUE INDEX IF NOT EXISTS merchant_profiles_shop_domain_lower_uidx
    ON merchant_profiles (lower(shopify_shop_domain));

-- Keep updated_at honest at the database layer (see 0001_extensions.sql).
-- DROP IF EXISTS first because CREATE TRIGGER has no IF NOT EXISTS form and
-- this migration must be safe to replay against a partially-restored dump.
DROP TRIGGER IF EXISTS trg_merchant_profiles_set_updated_at ON merchant_profiles;
CREATE TRIGGER trg_merchant_profiles_set_updated_at
    BEFORE UPDATE ON merchant_profiles
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- Documentation comments (surfaced in psql \d+ and most DB GUIs).
-- ----------------------------------------------------------------------------
COMMENT ON TABLE merchant_profiles IS
    'Tenant root for the Agent Optimization Platform. One row per onboarded '
    'headless Shopify merchant; all telemetry, reconciled orders, and loss '
    'diagnostics cascade-delete from here.';

COMMENT ON COLUMN merchant_profiles.shopify_shop_domain IS
    'Canonical *.myshopify.com domain identifying the store. Unique both '
    'exactly and case-insensitively (see merchant_profiles_shop_domain_lower_uidx).';

COMMENT ON COLUMN merchant_profiles.access_token_encrypted IS
    'Ciphertext only: Shopify Admin API access token encrypted app-side with '
    'AES-256-GCM. Plaintext tokens must NEVER be stored in this column.';

COMMENT ON COLUMN merchant_profiles.updated_at IS
    'Maintained automatically by the set_updated_at() BEFORE UPDATE trigger; '
    'application code should not set this column.';
