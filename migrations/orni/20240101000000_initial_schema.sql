-- Orni Creator AI Model Marketplace — Initial Schema
-- All monetary values in micro-USDC (1 USDC = 1_000_000 units)

-- ── Extensions ──

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Enums ──

CREATE TYPE model_status AS ENUM ('draft', 'training', 'live', 'paused', 'failed');
CREATE TYPE source_type AS ENUM ('text', 'pdf', 'youtube', 'blog');
CREATE TYPE content_status AS ENUM ('pending', 'processing', 'ready', 'failed');
CREATE TYPE fine_tune_status AS ENUM ('pending', 'running', 'completed', 'failed', 'cancelled');
CREATE TYPE chat_role AS ENUM ('system', 'user', 'assistant');

-- ── Tables ──

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address  VARCHAR(64) NOT NULL UNIQUE,
    username        VARCHAR(64) UNIQUE,
    display_name    VARCHAR(128),
    avatar_url      TEXT,
    is_creator      BOOLEAN NOT NULL DEFAULT FALSE,
    usdc_balance    BIGINT NOT NULL DEFAULT 0,  -- micro-USDC
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE models (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slug              VARCHAR(128) NOT NULL UNIQUE,
    name              VARCHAR(256) NOT NULL,
    description       TEXT,
    avatar_url        TEXT,
    system_prompt     TEXT NOT NULL,
    base_model        VARCHAR(256) NOT NULL DEFAULT 'meta-llama/Meta-Llama-3.1-8B-Instruct',
    provider_model_id VARCHAR(256),
    status            model_status NOT NULL DEFAULT 'draft',
    price_per_query   BIGINT NOT NULL DEFAULT 100000,  -- $0.10 in micro-USDC
    total_queries     BIGINT NOT NULL DEFAULT 0,
    total_revenue     BIGINT NOT NULL DEFAULT 0,
    category          VARCHAR(128),
    tags              TEXT[] NOT NULL DEFAULT '{}',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE content_sources (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_id     UUID NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    source_type  source_type NOT NULL,
    source_url   TEXT,
    content_text TEXT,
    status       content_status NOT NULL DEFAULT 'pending',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE training_datasets (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_id     UUID NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    file_key     TEXT NOT NULL,  -- R2 object path
    num_examples INTEGER NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE fine_tune_jobs (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_id         UUID NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    provider_job_id  VARCHAR(256),
    status           fine_tune_status NOT NULL DEFAULT 'pending',
    result_model_id  VARCHAR(256),
    error_message    TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE chat_sessions (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    model_id   UUID NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE chat_messages (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role       chat_role NOT NULL,
    content    TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE payments (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    model_id       UUID NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    amount         BIGINT NOT NULL,         -- micro-USDC total charged
    creator_share  BIGINT NOT NULL,         -- micro-USDC to creator
    platform_share BIGINT NOT NULL,         -- micro-USDC to platform
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE deposits (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount       BIGINT NOT NULL,           -- micro-USDC
    tx_signature VARCHAR(128) NOT NULL UNIQUE,
    verified     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Indexes ──

-- users
CREATE INDEX idx_users_wallet_address ON users(wallet_address);
CREATE INDEX idx_users_username ON users(username) WHERE username IS NOT NULL;
CREATE INDEX idx_users_is_creator ON users(is_creator) WHERE is_creator = TRUE;

-- models
CREATE INDEX idx_models_creator_id ON models(creator_id);
CREATE INDEX idx_models_slug ON models(slug);
CREATE INDEX idx_models_status ON models(status);
CREATE INDEX idx_models_category ON models(category) WHERE category IS NOT NULL;
CREATE INDEX idx_models_status_live ON models(total_queries DESC) WHERE status = 'live';

-- content_sources
CREATE INDEX idx_content_sources_model_id ON content_sources(model_id);
CREATE INDEX idx_content_sources_status ON content_sources(status);

-- training_datasets
CREATE INDEX idx_training_datasets_model_id ON training_datasets(model_id);

-- fine_tune_jobs
CREATE INDEX idx_fine_tune_jobs_model_id ON fine_tune_jobs(model_id);
CREATE INDEX idx_fine_tune_jobs_status ON fine_tune_jobs(status);

-- chat_sessions
CREATE INDEX idx_chat_sessions_user_id ON chat_sessions(user_id);
CREATE INDEX idx_chat_sessions_model_id ON chat_sessions(model_id);
CREATE INDEX idx_chat_sessions_user_model ON chat_sessions(user_id, model_id);

-- chat_messages
CREATE INDEX idx_chat_messages_session_id ON chat_messages(session_id);
CREATE INDEX idx_chat_messages_session_created ON chat_messages(session_id, created_at);

-- payments
CREATE INDEX idx_payments_user_id ON payments(user_id);
CREATE INDEX idx_payments_model_id ON payments(model_id);
CREATE INDEX idx_payments_created_at ON payments(created_at DESC);

-- deposits
CREATE INDEX idx_deposits_user_id ON deposits(user_id);
CREATE INDEX idx_deposits_tx_signature ON deposits(tx_signature);
CREATE INDEX idx_deposits_verified ON deposits(verified) WHERE verified = FALSE;

-- ── Updated-at Trigger ──

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_models_updated_at
    BEFORE UPDATE ON models
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_fine_tune_jobs_updated_at
    BEFORE UPDATE ON fine_tune_jobs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_chat_sessions_updated_at
    BEFORE UPDATE ON chat_sessions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
