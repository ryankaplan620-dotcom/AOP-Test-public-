-- ============================================================================
-- AOP :: db/migrations/0010_order_currency.sql
--
-- Role in the AOP data flow:
--   reconciled_agent_orders (0004) stored GMV "in the merchant's currency"
--   without recording WHICH currency — coherent only while every store bills
--   in one currency. Shopify sends the order's currency (ISO 4217) on every
--   orders/create webhook; from this migration on the ingestion service
--   persists it, and billing statements GROUP BY currency so a statement can
--   never sum EUR into USD.
--
--   Nullable, no default: legacy rows genuinely don't know their currency,
--   and defaulting them to 'USD' would fabricate billing data. Statement
--   queries surface NULL as 'UNSPECIFIED' — visibly unknown, not silently
--   wrong. New webhook writes always supply a validated 3-letter code (the
--   route drops to NULL only if Shopify ever omits/mangles the field).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + guarded constraint DO block.
-- Depends on: 0004.
-- ============================================================================

ALTER TABLE reconciled_agent_orders
    ADD COLUMN IF NOT EXISTS currency CHAR(3);

-- Uppercase ISO-4217 shape or NULL. Guarded: ADD CONSTRAINT has no
-- IF NOT EXISTS, and this migration must be re-runnable (0007 precedent).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'reconciled_agent_orders_currency_shape'
           AND conrelid = 'reconciled_agent_orders'::regclass
    ) THEN
        ALTER TABLE reconciled_agent_orders
            ADD CONSTRAINT reconciled_agent_orders_currency_shape
            CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$');
    END IF;
END
$$;

COMMENT ON COLUMN reconciled_agent_orders.currency IS
    'ISO-4217 currency of gross_merchandise_value, from the Shopify order '
    'webhook. NULL on pre-0010 rows (statements render UNSPECIFIED). Billing '
    'aggregates GROUP BY currency — cross-currency sums are never produced.';
