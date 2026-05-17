-- Inference node registration for self-hosted AI
CREATE TABLE IF NOT EXISTS inference_nodes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    owner_did TEXT NOT NULL,
    endpoint_url TEXT NOT NULL UNIQUE,
    models_served TEXT[] NOT NULL DEFAULT '{}',
    price_per_query_micro_usdc BIGINT NOT NULL DEFAULT 100000,
    status TEXT NOT NULL DEFAULT 'pending',
    region TEXT,
    description TEXT,
    uptime_percent REAL NOT NULL DEFAULT 0.0,
    total_queries BIGINT NOT NULL DEFAULT 0,
    total_revenue_micro_usdc BIGINT NOT NULL DEFAULT 0,
    avg_rating REAL,
    review_count INT NOT NULL DEFAULT 0,
    consecutive_failures INT NOT NULL DEFAULT 0,
    last_heartbeat_at TIMESTAMPTZ,
    last_checked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS node_heartbeats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    node_id UUID NOT NULL REFERENCES inference_nodes(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    latency_ms INT,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS node_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    node_id UUID NOT NULL REFERENCES inference_nodes(id) ON DELETE CASCADE,
    reviewer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rating INT NOT NULL CHECK (rating >= 1 AND rating <= 5),
    comment TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(node_id, reviewer_id)
);

CREATE TABLE IF NOT EXISTS node_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    node_id UUID NOT NULL REFERENCES inference_nodes(id) ON DELETE CASCADE,
    amount_micro_usdc BIGINT NOT NULL,
    node_share_micro_usdc BIGINT NOT NULL,
    creator_share_micro_usdc BIGINT NOT NULL,
    platform_share_micro_usdc BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_inference_nodes_owner ON inference_nodes(owner_id);
CREATE INDEX idx_inference_nodes_status ON inference_nodes(status);
CREATE INDEX idx_inference_nodes_models ON inference_nodes USING GIN(models_served);
CREATE INDEX idx_node_heartbeats_node ON node_heartbeats(node_id);
CREATE INDEX idx_node_heartbeats_created ON node_heartbeats(created_at);
CREATE INDEX idx_node_reviews_node ON node_reviews(node_id);
CREATE INDEX idx_node_payments_node ON node_payments(node_id);
CREATE INDEX idx_node_payments_created ON node_payments(created_at);

CREATE TRIGGER set_inference_nodes_updated_at
    BEFORE UPDATE ON inference_nodes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
