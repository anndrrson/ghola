-- Phase 5: Per-Request Payment Protocol + Billing-as-a-Service
-- Enables agents to pay per-request through SAID, merchants outsource billing

-- Agent subscriptions to services (budgeted access)
CREATE TABLE IF NOT EXISTS agent_service_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_wallet_id UUID NOT NULL REFERENCES agent_wallets(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_id UUID NOT NULL REFERENCES service_listings(id) ON DELETE CASCADE,
    tier_name TEXT,
    daily_budget_micro_usdc BIGINT,
    total_spent_micro_usdc BIGINT NOT NULL DEFAULT 0,
    requests_today INTEGER NOT NULL DEFAULT 0,
    requests_reset_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('day', NOW()),
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(agent_wallet_id, service_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_service_subs_agent ON agent_service_subscriptions(agent_wallet_id);
CREATE INDEX IF NOT EXISTS idx_agent_service_subs_service ON agent_service_subscriptions(service_id);
CREATE INDEX IF NOT EXISTS idx_agent_service_subs_user ON agent_service_subscriptions(user_id);

-- Metered usage (per-request records for billing-as-a-service)
CREATE TABLE IF NOT EXISTS metered_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id UUID NOT NULL REFERENCES service_listings(id) ON DELETE CASCADE,
    agent_did TEXT NOT NULL,
    agent_wallet_id UUID REFERENCES agent_wallets(id),
    endpoint_name TEXT,
    request_count INTEGER NOT NULL DEFAULT 1,
    tokens_consumed INTEGER,
    amount_micro_usdc BIGINT NOT NULL DEFAULT 0,
    period_start TIMESTAMPTZ NOT NULL DEFAULT date_trunc('hour', NOW()),
    settled BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_metered_usage_service ON metered_usage(service_id);
CREATE INDEX IF NOT EXISTS idx_metered_usage_agent ON metered_usage(agent_did);
CREATE INDEX IF NOT EXISTS idx_metered_usage_unsettled ON metered_usage(settled) WHERE settled = false;
CREATE INDEX IF NOT EXISTS idx_metered_usage_period ON metered_usage(period_start);

-- Settlement batches (hourly aggregation)
CREATE TABLE IF NOT EXISTS settlement_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id UUID NOT NULL REFERENCES service_listings(id),
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    total_requests INTEGER NOT NULL DEFAULT 0,
    total_micro_usdc BIGINT NOT NULL DEFAULT 0,
    merchant_share_micro_usdc BIGINT NOT NULL DEFAULT 0,
    platform_share_micro_usdc BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    tx_signature TEXT,
    settled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_settlement_batches_service ON settlement_batches(service_id);
CREATE INDEX IF NOT EXISTS idx_settlement_batches_status ON settlement_batches(status);

CREATE TRIGGER set_agent_service_subs_updated_at
    BEFORE UPDATE ON agent_service_subscriptions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
