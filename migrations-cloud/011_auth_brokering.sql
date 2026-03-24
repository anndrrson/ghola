-- Phase 3: Agent Auth Brokering
-- Enables merchants to verify agent identity + capabilities via SAID

-- Auth verification audit log
CREATE TABLE IF NOT EXISTS auth_verifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id UUID REFERENCES service_listings(id),
    merchant_did TEXT NOT NULL,
    agent_did TEXT NOT NULL,
    requested_capabilities TEXT[] NOT NULL DEFAULT '{}',
    result TEXT NOT NULL,  -- 'valid', 'invalid', 'expired', 'insufficient_capability', 'unknown_agent'
    trust_score REAL,
    latency_ms INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_verifications_merchant ON auth_verifications(merchant_did);
CREATE INDEX IF NOT EXISTS idx_auth_verifications_agent ON auth_verifications(agent_did);
CREATE INDEX IF NOT EXISTS idx_auth_verifications_created ON auth_verifications(created_at);

-- Service API keys (for merchants to call verification/metering endpoints)
CREATE TABLE IF NOT EXISTS service_api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id UUID NOT NULL REFERENCES service_listings(id) ON DELETE CASCADE,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_hash TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT 'default',
    scopes TEXT[] NOT NULL DEFAULT '{verify}',
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_service_api_keys_service ON service_api_keys(service_id);
CREATE INDEX IF NOT EXISTS idx_service_api_keys_hash ON service_api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_service_api_keys_owner ON service_api_keys(owner_id);
