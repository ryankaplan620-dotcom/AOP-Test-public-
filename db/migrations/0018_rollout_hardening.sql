-- AOP rollout hardening: integration health, merchant sessions, and a
-- versioned recommendation/experiment record. All merchant-facing changes
-- are append-only or explicitly stateful so results remain auditable.

CREATE TABLE IF NOT EXISTS merchant_integrations (
  merchant_id UUID PRIMARY KEY REFERENCES merchant_profiles(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider = 'shopify'),
  status TEXT NOT NULL CHECK (status IN ('healthy', 'degraded')),
  webhook_status JSONB NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS merchant_dashboard_sessions (
  token_hash CHAR(64) PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchant_profiles(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS merchant_dashboard_sessions_expiry_idx
  ON merchant_dashboard_sessions (expires_at);

CREATE TABLE IF NOT EXISTS merchant_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchant_profiles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('policy', 'claims', 'jsonld')),
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'approved', 'running', 'rolled_back', 'completed')),
  approved_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  rolled_back_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS merchant_recommendations_scope_idx
  ON merchant_recommendations (merchant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS recommendation_experiments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recommendation_id UUID NOT NULL UNIQUE REFERENCES merchant_recommendations(id) ON DELETE CASCADE,
  control_share NUMERIC(4,3) NOT NULL CHECK (control_share > 0 AND control_share < 1),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ
);
