-- ============================================================================
-- AOP :: db/migrations/0003_agent_intent_logs.sql
--
-- Role in the AOP data flow:
--   agent_intent_logs is the high-volume telemetry firehose table. Every
--   pre-purchase query an AI shopping agent makes against a merchant's
--   storefront (/availability, /shipping_quote, ...) is intercepted by the
--   Cloudflare Worker edge proxy, pushed onto env.EDGE_LOG_QUEUE, drained by
--   the queue consumer, and POSTed to the Node.js ingestion service, which
--   INSERTs one row here. Writes are asynchronous and off the merchant's hot
--   path by design: if this table is unavailable, live agent traffic is
--   unaffected (the edge proxy still passes requests through to Shopify).
--
--   Two consumers read this table:
--     1. The order-reconciliation path: Shopify order-created webhooks carry
--        an X-Agent-Transaction-Token echo; the ingestion service joins that
--        token against transaction_token here to attribute the order
--        (cookie-less attribution). This join is THE hot path and drives the
--        indexing strategy below.
--     2. The sweep job: intents older than the 60-second conversion window
--        with no matching reconciled order are classified into
--        loss_diagnostics (exactly one diagnostic per expired intent).
--
-- Depends on: 0001_extensions.sql, 0002_merchant_profiles.sql.
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_intent_logs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Tenant ownership. CASCADE: telemetry is worthless without its merchant,
    -- and offboarding must not leave orphaned intent rows behind.
    merchant_id       UUID NOT NULL
                          REFERENCES merchant_profiles(id) ON DELETE CASCADE,

    -- The cookie-less attribution key: value of the X-Agent-Transaction-Token
    -- header minted/observed at the edge. Deliberately NOT unique — a single
    -- agent transaction legitimately produces multiple intent rows (e.g. an
    -- /availability probe followed by a /shipping_quote on the same token).
    transaction_token VARCHAR(255) NOT NULL,

    -- Which agent-commerce protocol the caller spoke. Known values today:
    --   'STRIPE_ACP', 'GOOGLE_AP2', 'VISA_INTELLIGENT_COMMERCE',
    --   'UNKNOWN_PROTOCOL'.
    -- Deliberately NOT a CHECK constraint: agent protocols are evolving
    -- monthly, and a new protocol string must never make edge telemetry
    -- inserts fail. Unknown strings are normalized/reported at read time.
    protocol_type     VARCHAR(50) NOT NULL,

    -- HTTP verbs are a closed, stable set, so unlike protocol_type this IS
    -- safe to CHECK-constrain; anything else indicates a corrupted event.
    request_method    VARCHAR(10) NOT NULL
                          CONSTRAINT agent_intent_logs_request_method_check
                          CHECK (request_method IN
                              ('GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS')),

    -- Path only (e.g. '/availability'), never query string — query params may
    -- carry PII and belong (redacted) in inbound_payload instead.
    endpoint_path     VARCHAR(255) NOT NULL,

    -- SKU the agent asked about, extracted at the edge when parseable.
    -- Sentinel 'UNSPECIFIED' (rather than NULL) keeps the btree index dense
    -- and lets loss analytics GROUP BY target_sku without COALESCE gymnastics.
    target_sku        VARCHAR(100) NOT NULL DEFAULT 'UNSPECIFIED',

    -- Full (redacted) request body/params as captured at the edge. Nullable:
    -- GET/HEAD probes often have no payload. JSONB (not JSON/TEXT) so the
    -- loss-diagnostics sweep can run containment queries against it.
    inbound_payload   JSONB,

    processed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- Indexing strategy — this table is write-heavy AND read-hot, so every index
-- below is justified by a specific production query path:
-- ----------------------------------------------------------------------------

-- (1) THE hot path: webhook reconciliation joins order.transaction_token ->
--     agent_intent_logs.transaction_token within seconds of purchase. Plain
--     btree; not unique (see column comment above).
CREATE INDEX IF NOT EXISTS agent_intent_logs_transaction_token_idx
    ON agent_intent_logs (transaction_token);

-- (2) Merchant-facing analytics: "which SKUs are agents probing?"
CREATE INDEX IF NOT EXISTS agent_intent_logs_target_sku_idx
    ON agent_intent_logs (target_sku);

-- (3) Per-merchant time-window scans: powers both the dashboard's recent-
--     activity feed and the sweep job's "intents older than 60s for merchant
--     X" scan. DESC matches the dominant ORDER BY ... DESC LIMIT access
--     pattern so PostgreSQL can walk the index forward without a sort.
CREATE INDEX IF NOT EXISTS agent_intent_logs_merchant_processed_idx
    ON agent_intent_logs (merchant_id, processed_at DESC);

-- (4) Ad-hoc payload mining ("find intents mentioning express shipping").
--     jsonb_path_ops (not the default jsonb_ops) because we only need @>
--     containment queries and it is markedly smaller/faster for them on a
--     firehose-scale table.
CREATE INDEX IF NOT EXISTS agent_intent_logs_inbound_payload_gin
    ON agent_intent_logs USING GIN (inbound_payload jsonb_path_ops);

-- ----------------------------------------------------------------------------
-- Documentation comments.
-- ----------------------------------------------------------------------------
COMMENT ON TABLE agent_intent_logs IS
    'Append-only telemetry of every AI-agent storefront query captured by the '
    'Cloudflare Worker edge proxy (via queue -> ingestion service). Joined to '
    'Shopify orders by transaction_token for cookie-less attribution; swept '
    'into loss_diagnostics when the 60-second conversion window expires.';

COMMENT ON COLUMN agent_intent_logs.transaction_token IS
    'X-Agent-Transaction-Token header value; the cookie-less attribution key '
    'joining intents to reconciled_agent_orders. Not unique: one agent '
    'transaction can emit several intent rows.';

COMMENT ON COLUMN agent_intent_logs.protocol_type IS
    'Agent-commerce protocol identifier. Known values: STRIPE_ACP, GOOGLE_AP2, '
    'VISA_INTELLIGENT_COMMERCE, UNKNOWN_PROTOCOL. Intentionally unconstrained '
    '(no CHECK): protocols evolve and telemetry ingest must never reject a '
    'new one.';

COMMENT ON COLUMN agent_intent_logs.target_sku IS
    'SKU the agent asked about; sentinel ''UNSPECIFIED'' when the edge proxy '
    'could not extract one (kept NOT NULL for dense indexing and grouping).';

COMMENT ON COLUMN agent_intent_logs.inbound_payload IS
    'Redacted JSONB capture of the inbound request body/params. NULL for '
    'body-less probes. Indexed with GIN jsonb_path_ops for @> containment.';

COMMENT ON COLUMN agent_intent_logs.processed_at IS
    'When the ingestion service persisted the event (start of the 60-second '
    'conversion window used by the loss-diagnostics sweep).';
