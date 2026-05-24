-- Phase 1: Generalized Service Registry for Headless Merchants
-- Transforms SAID from inference-node-specific marketplace into universal service registry

-- Enum types for service listings
DO $$ BEGIN
    CREATE TYPE service_status AS ENUM ('pending', 'active', 'degraded', 'offline', 'suspended');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE service_auth_type AS ENUM ('none', 'api_key', 'ucan', 'oauth2', 'said_verify');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE pricing_model AS ENUM ('per_request', 'per_minute', 'per_token', 'flat_monthly', 'free');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Main service registry table
CREATE TABLE IF NOT EXISTS service_listings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    owner_did TEXT NOT NULL,

    -- Identity
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    logo_url TEXT,
    website TEXT,

    -- Categorization
    category TEXT NOT NULL DEFAULT 'general',
    tags TEXT[] NOT NULL DEFAULT '{}',

    -- API Details
    base_url TEXT NOT NULL,
    health_check_url TEXT,
    openapi_url TEXT,
    auth_type service_auth_type NOT NULL DEFAULT 'api_key',
    auth_details JSONB NOT NULL DEFAULT '{}',

    -- Pricing
    pricing_model pricing_model NOT NULL DEFAULT 'per_request',
    price_micro_usdc BIGINT NOT NULL DEFAULT 0,
    pricing_tiers JSONB,
    free_tier_requests INTEGER DEFAULT 0,

    -- SLA
    sla_uptime_percent REAL,
    sla_latency_p50_ms INTEGER,
    sla_latency_p99_ms INTEGER,
    regions TEXT[] NOT NULL DEFAULT '{}',

    -- Structured endpoints
    endpoints JSONB NOT NULL DEFAULT '[]',

    -- Measured metrics (updated by health checker)
    status service_status NOT NULL DEFAULT 'pending',
    uptime_percent REAL NOT NULL DEFAULT 0.0,
    avg_latency_ms REAL NOT NULL DEFAULT 0.0,
    total_requests BIGINT NOT NULL DEFAULT 0,
    total_revenue_micro_usdc BIGINT NOT NULL DEFAULT 0,
    avg_rating REAL,
    review_count INTEGER NOT NULL DEFAULT 0,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    last_heartbeat_at TIMESTAMPTZ,
    last_checked_at TIMESTAMPTZ,

    -- Merchant payment config
    receive_address TEXT,
    platform_fee_bps INTEGER NOT NULL DEFAULT 300,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Full-text search vector (auto-generated from name + description).
-- `array_to_string(tags, ...)` is only STABLE on Postgres, which makes the
-- generated column invalid on stricter versions; tag filtering still uses
-- the dedicated GIN index below.
ALTER TABLE service_listings ADD COLUMN IF NOT EXISTS search_vector tsvector
    GENERATED ALWAYS AS (
        setweight(to_tsvector('pg_catalog.english'::regconfig, coalesce(name, '')), 'A') ||
        setweight(to_tsvector('pg_catalog.english'::regconfig, coalesce(description, '')), 'B')
    ) STORED;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_service_listings_owner ON service_listings(owner_id);
CREATE INDEX IF NOT EXISTS idx_service_listings_owner_did ON service_listings(owner_did);
CREATE INDEX IF NOT EXISTS idx_service_listings_category ON service_listings(category);
CREATE INDEX IF NOT EXISTS idx_service_listings_status ON service_listings(status);
CREATE INDEX IF NOT EXISTS idx_service_listings_tags ON service_listings USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_service_listings_price ON service_listings(price_micro_usdc) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_service_listings_slug ON service_listings(slug);
CREATE INDEX IF NOT EXISTS idx_service_listings_search ON service_listings USING GIN(search_vector);

-- Service heartbeats (health check results)
CREATE TABLE IF NOT EXISTS service_heartbeats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id UUID NOT NULL REFERENCES service_listings(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    latency_ms INTEGER,
    status_code INTEGER,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_service_heartbeats_service ON service_heartbeats(service_id);
CREATE INDEX IF NOT EXISTS idx_service_heartbeats_created ON service_heartbeats(created_at);

-- Service reviews (generalized, with structured sub-scores)
CREATE TABLE IF NOT EXISTS service_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id UUID NOT NULL REFERENCES service_listings(id) ON DELETE CASCADE,
    reviewer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reviewer_did TEXT,
    rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
    comment TEXT,
    quality_score INTEGER CHECK (quality_score >= 1 AND quality_score <= 5),
    reliability_score INTEGER CHECK (reliability_score >= 1 AND reliability_score <= 5),
    latency_score INTEGER CHECK (latency_score >= 1 AND latency_score <= 5),
    value_score INTEGER CHECK (value_score >= 1 AND value_score <= 5),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(service_id, reviewer_id)
);

CREATE INDEX IF NOT EXISTS idx_service_reviews_service ON service_reviews(service_id);
CREATE INDEX IF NOT EXISTS idx_service_reviews_reviewer ON service_reviews(reviewer_id);

-- Service payment records
CREATE TABLE IF NOT EXISTS service_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id UUID NOT NULL REFERENCES service_listings(id) ON DELETE CASCADE,
    payer_id UUID REFERENCES users(id),
    payer_did TEXT,
    agent_wallet_id UUID REFERENCES agent_wallets(id),
    endpoint_name TEXT,
    amount_micro_usdc BIGINT NOT NULL,
    merchant_share_micro_usdc BIGINT NOT NULL,
    platform_share_micro_usdc BIGINT NOT NULL,
    status TEXT NOT NULL DEFAULT 'completed',
    tx_signature TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_service_payments_service ON service_payments(service_id);
CREATE INDEX IF NOT EXISTS idx_service_payments_payer ON service_payments(payer_id);
CREATE INDEX IF NOT EXISTS idx_service_payments_created ON service_payments(created_at);

-- Updated_at trigger
CREATE TRIGGER set_service_listings_updated_at
    BEFORE UPDATE ON service_listings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
