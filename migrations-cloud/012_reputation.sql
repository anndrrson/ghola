-- Phase 4: Trust & Reputation System
-- Generalized reputation scores for both service providers and agents

-- Cached composite reputation scores (recomputed periodically)
CREATE TABLE IF NOT EXISTS reputation_scores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_did TEXT NOT NULL UNIQUE,
    entity_type TEXT NOT NULL,  -- 'business', 'consumer', 'service', 'agent'

    -- Component scores (0.0 - 1.0)
    identity_score REAL NOT NULL DEFAULT 0.0,
    transaction_score REAL NOT NULL DEFAULT 0.0,
    quality_score REAL NOT NULL DEFAULT 0.0,
    reliability_score REAL NOT NULL DEFAULT 0.0,
    history_score REAL NOT NULL DEFAULT 0.0,

    -- Composite
    overall_score REAL NOT NULL DEFAULT 0.0,
    confidence REAL NOT NULL DEFAULT 0.0,  -- 0.0 = no data, 1.0 = lots of data

    -- Raw data
    total_transactions INTEGER NOT NULL DEFAULT 0,
    completed_transactions INTEGER NOT NULL DEFAULT 0,
    disputed_transactions INTEGER NOT NULL DEFAULT 0,
    total_volume_micro_usdc BIGINT NOT NULL DEFAULT 0,
    avg_review_rating REAL,
    review_count INTEGER NOT NULL DEFAULT 0,
    account_age_days INTEGER NOT NULL DEFAULT 0,

    computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reputation_scores_did ON reputation_scores(entity_did);
CREATE INDEX IF NOT EXISTS idx_reputation_scores_type ON reputation_scores(entity_type);
CREATE INDEX IF NOT EXISTS idx_reputation_scores_overall ON reputation_scores(overall_score DESC);

-- Immutable reputation events (audit log)
CREATE TABLE IF NOT EXISTS reputation_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_did TEXT NOT NULL,
    event_type TEXT NOT NULL,  -- 'transaction_completed', 'transaction_disputed', 'review_received', 'sla_met', 'sla_violated', 'badge_granted', 'service_registered'
    counterparty_did TEXT,
    details JSONB,
    score_delta REAL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reputation_events_entity ON reputation_events(entity_did);
CREATE INDEX IF NOT EXISTS idx_reputation_events_type ON reputation_events(event_type);
CREATE INDEX IF NOT EXISTS idx_reputation_events_created ON reputation_events(created_at);

CREATE TRIGGER set_reputation_scores_updated_at
    BEFORE UPDATE ON reputation_scores
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
