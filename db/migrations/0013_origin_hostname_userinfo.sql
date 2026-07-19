-- ============================================================================
-- AOP :: db/migrations/0013_origin_hostname_userinfo.sql
--
-- Hardens the generated origin_hostname (0011) against origin_url values
-- carrying URL userinfo: for 'https://user@host/...' the 0011 regex captured
-- 'user@host', which can never equal the edge's URL.hostname — silently
-- dropping 100% of that merchant's telemetry. The new expression skips an
-- optional userinfo segment before capturing the host.
--
-- Known documented limitation (not addressed here): internationalized
-- domain names must be entered in punycode (xn--...) form in origin_url —
-- the edge compares URL.hostname, which is always punycoded, and SQL cannot
-- perform IDNA encoding. The OAuth install path always writes ASCII
-- *.myshopify.com origins, so this only concerns hand-entered custom
-- origins.
--
-- A generated column's expression cannot be ALTERed in place: drop + re-add
-- (STORED values recompute automatically for all rows on ADD).
-- Idempotent via the expression check in the DO block.
-- Depends on: 0011.
-- ============================================================================

DO $$
DECLARE
    current_expr text;
BEGIN
    SELECT pg_get_expr(d.adbin, d.adrelid)
      INTO current_expr
      FROM pg_attrdef d
      JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
     WHERE d.adrelid = 'merchant_profiles'::regclass
       AND a.attname = 'origin_hostname';

    -- Already migrated (expression contains the userinfo skip) -> no-op.
    IF current_expr IS NOT NULL AND position('[^/?#]*@' in current_expr) > 0 THEN
        RETURN;
    END IF;

    ALTER TABLE merchant_profiles DROP COLUMN IF EXISTS origin_hostname;
    ALTER TABLE merchant_profiles
        ADD COLUMN origin_hostname VARCHAR(255)
        GENERATED ALWAYS AS
        (substring(lower(origin_url) from '^https?://(?:[^/?#]*@)?([^/:?#@]+)'))
        STORED;

    COMMENT ON COLUMN merchant_profiles.origin_hostname IS
        'GENERATED: hostname of origin_url, lowercased, userinfo-stripped. '
        'The edge records the resolved origin hostname as telemetry '
        'shop_domain; this column lets the ingest path resolve those records '
        'for custom-domain merchants. IDN origins must be entered in '
        'punycode form.';
END
$$;

-- The DROP COLUMN above also dropped the 0011 index; recreate it.
CREATE INDEX IF NOT EXISTS merchant_profiles_origin_hostname_idx
    ON merchant_profiles (origin_hostname)
    WHERE origin_hostname IS NOT NULL;
