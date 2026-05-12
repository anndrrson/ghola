use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use std::time::Duration;

pub async fn create_pool(database_url: &str) -> Result<PgPool, sqlx::Error> {
    let max_retries = 5;
    let mut delay = Duration::from_secs(1);

    for attempt in 1..=max_retries {
        match PgPoolOptions::new()
            .max_connections(20)
            .acquire_timeout(Duration::from_secs(10))
            .idle_timeout(Duration::from_secs(300))
            .connect(database_url)
            .await
        {
            Ok(pool) => {
                tracing::info!("database pool connected (attempt {attempt})");
                return Ok(pool);
            }
            Err(e) if attempt < max_retries => {
                tracing::warn!(
                    attempt,
                    max_retries,
                    delay_secs = delay.as_secs(),
                    "database connection failed, retrying: {e}"
                );
                tokio::time::sleep(delay).await;
                delay *= 2;
            }
            Err(e) => return Err(e),
        }
    }

    unreachable!()
}

pub async fn run_migrations(pool: &PgPool) -> Result<(), sqlx::Error> {
    // Run embedded migrations
    sqlx::raw_sql(MIGRATION_SQL).execute(pool).await?;
    tracing::info!("database migrations applied");
    Ok(())
}

const MIGRATION_SQL: &str = r#"
-- Thumper Cloud Schema

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE,
    google_id TEXT UNIQUE,
    apple_id TEXT UNIQUE,
    siws_pubkey TEXT UNIQUE,
    display_name TEXT,
    phone_number TEXT,
    timezone TEXT DEFAULT 'America/New_York',
    tier TEXT DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'unlimited')),
    stripe_customer_id TEXT,
    said_identity_id TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_pubkey TEXT,
    platform TEXT NOT NULL CHECK (platform IN ('android', 'ios')),
    device_name TEXT,
    push_token TEXT,
    last_seen_at TIMESTAMPTZ DEFAULT now(),
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);

CREATE TABLE IF NOT EXISTS tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_type TEXT NOT NULL CHECK (task_type IN ('call', 'email', 'device_action', 'calendar', 'search', 'composite')),
    template_id TEXT,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'awaiting_approval', 'completed', 'failed', 'cancelled')),
    params JSONB DEFAULT '{}',
    result JSONB,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS task_steps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    step_number INT NOT NULL,
    action_type TEXT NOT NULL,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'skipped')),
    input JSONB DEFAULT '{}',
    output JSONB,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_task_steps_task ON task_steps(task_id);

CREATE TABLE IF NOT EXISTS calls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bland_call_id TEXT UNIQUE,
    phone_number TEXT NOT NULL,
    objective TEXT NOT NULL,
    script JSONB,
    transcript TEXT,
    outcome TEXT CHECK (outcome IN ('success', 'failed', 'voicemail', 'busy', 'no_answer', 'in_progress')),
    outcome_details JSONB,
    duration_seconds INT,
    cost_cents INT,
    recording_url TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_calls_user ON calls(user_id);
CREATE INDEX IF NOT EXISTS idx_calls_bland ON calls(bland_call_id);

CREATE TABLE IF NOT EXISTS email_actions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_address TEXT NOT NULL,
    cc_addresses TEXT[],
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    gmail_message_id TEXT,
    gmail_thread_id TEXT,
    status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'sent', 'failed')),
    created_at TIMESTAMPTZ DEFAULT now(),
    sent_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_email_actions_user ON email_actions(user_id);

CREATE TABLE IF NOT EXISTS connected_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('gmail', 'google_calendar', 'apple_calendar')),
    encrypted_access_token BYTEA,
    encrypted_refresh_token BYTEA,
    token_expires_at TIMESTAMPTZ,
    scopes TEXT[],
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_connected_accounts_user ON connected_accounts(user_id);

CREATE TABLE IF NOT EXISTS task_templates (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('calls', 'emails', 'device', 'calendar', 'composite')),
    description TEXT,
    params_schema JSONB NOT NULL DEFAULT '{}',
    default_steps JSONB NOT NULL DEFAULT '[]',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS monitors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    monitor_type TEXT NOT NULL CHECK (monitor_type IN ('email_reply', 'email_digest', 'calendar_reminder', 'notification_watch')),
    config JSONB DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    next_run_at TIMESTAMPTZ,
    last_run_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_monitors_user ON monitors(user_id);
CREATE INDEX IF NOT EXISTS idx_monitors_next_run ON monitors(next_run_at) WHERE is_active = true;

CREATE TABLE IF NOT EXISTS usage_tracking (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    period_start DATE NOT NULL,
    call_count INT DEFAULT 0,
    call_minutes INT DEFAULT 0,
    email_count INT DEFAULT 0,
    monitor_count INT DEFAULT 0,
    UNIQUE(user_id, period_start)
);
CREATE INDEX IF NOT EXISTS idx_usage_user_period ON usage_tracking(user_id, period_start);

-- Email/password auth
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- BYOM (Bring Your Own Model) columns
ALTER TABLE users ADD COLUMN IF NOT EXISTS llm_provider TEXT DEFAULT 'anthropic';
ALTER TABLE users ADD COLUMN IF NOT EXISTS llm_model TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS llm_api_key_encrypted BYTEA;
ALTER TABLE users ADD COLUMN IF NOT EXISTS llm_base_url TEXT;

-- Allow macOS as a device platform
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_platform_check;
ALTER TABLE devices ADD CONSTRAINT devices_platform_check
    CHECK (platform IN ('android', 'ios', 'macos'));

-- Chat messages for SSE streaming chat
CREATE TABLE IF NOT EXISTS chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id UUID NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS session_id UUID;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_user ON chat_messages(user_id);

-- Server-blind end-to-end encryption (sealed envelope v1).
-- envelope_v IS NULL  → legacy v0 plaintext row, content column carries the
--                       message body. These rows remain readable indefinitely
--                       (no bulk migration — explicit per the v1 plan).
-- envelope_v = 1      → v1 sealed envelope, ciphertext in envelope_blob.
--                       The cloud cannot read content for these rows; the
--                       content column is NULL and ignored.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS envelope_blob BYTEA;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS envelope_v SMALLINT;
ALTER TABLE chat_messages ALTER COLUMN content DROP NOT NULL;
-- Either content is present (legacy) OR an envelope is present (v1+). A row
-- with neither is a bug — reject it at write time.
ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_payload_present;
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_payload_present
    CHECK (content IS NOT NULL OR envelope_blob IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_chat_messages_envelope_v ON chat_messages(envelope_v);

-- Twitter auth
ALTER TABLE users ADD COLUMN IF NOT EXISTS twitter_id TEXT UNIQUE;

-- Telegram bot integration
CREATE TABLE IF NOT EXISTS telegram_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    telegram_user_id BIGINT NOT NULL UNIQUE,
    telegram_username TEXT,
    telegram_first_name TEXT,
    chat_id BIGINT NOT NULL,
    session_id UUID NOT NULL DEFAULT gen_random_uuid(),
    linked_at TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tg_links_user ON telegram_links(user_id);

CREATE TABLE IF NOT EXISTS telegram_link_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Developer API keys
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_hash TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT 'Default',
    scopes TEXT[] NOT NULL DEFAULT '{all}',
    rate_limit_per_min INT DEFAULT 60,
    created_at TIMESTAMPTZ DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

-- API usage tracking columns
ALTER TABLE usage_tracking ADD COLUMN IF NOT EXISTS api_call_count INT DEFAULT 0;
ALTER TABLE usage_tracking ADD COLUMN IF NOT EXISTS api_token_count INT DEFAULT 0;

-- Ensure tier column exists (may be missing if table was created without it)
ALTER TABLE users ADD COLUMN IF NOT EXISTS tier TEXT DEFAULT 'free';

-- Fix any existing rows with NULL tier
UPDATE users SET tier = 'free' WHERE tier IS NULL;

-- Ensure OAuth provider columns exist (table may predate these)
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS siws_pubkey TEXT;
DROP INDEX IF EXISTS idx_users_google_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);
DROP INDEX IF EXISTS idx_users_apple_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_apple_id ON users(apple_id);
DROP INDEX IF EXISTS idx_users_siws_pubkey;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_siws_pubkey ON users(siws_pubkey);

-- Ensure columns from CREATE TABLE exist (live DB may predate them)
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'America/New_York';
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS said_identity_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();

-- Make legacy columns nullable if they exist (from earlier Orni/Supabase schema)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'users' AND column_name = 'username') THEN
        ALTER TABLE users ALTER COLUMN username DROP NOT NULL;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'users' AND column_name = 'wallet_spending') THEN
        ALTER TABLE users ALTER COLUMN wallet_spending DROP NOT NULL;
    END IF;
END
$$;

-- Enterprise tier support
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_tier_check;
ALTER TABLE users ADD CONSTRAINT users_tier_check
    CHECK (tier IN ('free', 'pro', 'unlimited', 'enterprise'));

-- Crypto wallet support
CREATE TABLE IF NOT EXISTS user_wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
    solana_address TEXT NOT NULL,
    mnemonic_encrypted BYTEA NOT NULL,
    network TEXT DEFAULT 'devnet' CHECK (network IN ('devnet', 'mainnet-beta')),
    spending_limit_daily_usdc BIGINT DEFAULT 500000,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    wallet_id UUID NOT NULL REFERENCES user_wallets(id),
    tx_type TEXT NOT NULL CHECK (tx_type IN ('transfer', 'deposit')),
    currency TEXT NOT NULL CHECK (currency IN ('SOL', 'USDC')),
    amount BIGINT NOT NULL,
    to_address TEXT,
    signature TEXT,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'failed')),
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wallet_txns_user ON wallet_transactions(user_id);

-- Extend task_type to include crypto
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_task_type_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_task_type_check
    CHECK (task_type IN ('call', 'email', 'device_action', 'calendar', 'search', 'composite', 'crypto'));

-- GPU Compute Marketplace
CREATE TABLE IF NOT EXISTS compute_providers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    relay_pubkey TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    models JSONB NOT NULL DEFAULT '[]',
    vram_mb INT DEFAULT 0,
    max_concurrent INT DEFAULT 2,
    current_load INT DEFAULT 0,
    status TEXT DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'suspended')),
    total_requests BIGINT DEFAULT 0,
    total_tokens_served BIGINT DEFAULT 0,
    total_earned_usdc BIGINT DEFAULT 0,
    success_rate DOUBLE PRECISION DEFAULT 1.0,
    avg_latency_ms DOUBLE PRECISION DEFAULT 0.0,
    reputation_score DOUBLE PRECISION DEFAULT 0.5,
    last_heartbeat_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_compute_providers_user ON compute_providers(user_id);
CREATE INDEX IF NOT EXISTS idx_compute_providers_status ON compute_providers(status);

-- Note: compute_jobs.user_id is stored for billing/dispute resolution but is
-- NEVER exposed to providers via API. Provider-visible RecentJob omits user_id entirely.
CREATE TABLE IF NOT EXISTS compute_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    provider_id UUID NOT NULL REFERENCES compute_providers(id),
    escrow_id UUID,
    model_id TEXT NOT NULL,
    input_tokens INT DEFAULT 0,
    output_tokens INT DEFAULT 0,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'timeout')),
    latency_ms INT,
    quality_score DOUBLE PRECISION,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_compute_jobs_user ON compute_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_compute_jobs_provider ON compute_jobs(provider_id);

CREATE TABLE IF NOT EXISTS escrow_holds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    provider_id UUID NOT NULL REFERENCES compute_providers(id),
    amount_usdc BIGINT NOT NULL,
    status TEXT DEFAULT 'held' CHECK (status IN ('held', 'released', 'refunded', 'expired')),
    released_to_provider BIGINT DEFAULT 0,
    platform_fee BIGINT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_escrow_holds_user ON escrow_holds(user_id);
CREATE INDEX IF NOT EXISTS idx_escrow_holds_status ON escrow_holds(status);

CREATE TABLE IF NOT EXISTS provider_stats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id UUID NOT NULL REFERENCES compute_providers(id) ON DELETE CASCADE,
    stat_date DATE NOT NULL,
    requests_total INT DEFAULT 0,
    requests_success INT DEFAULT 0,
    requests_failed INT DEFAULT 0,
    tokens_served BIGINT DEFAULT 0,
    earned_usdc BIGINT DEFAULT 0,
    avg_latency_ms DOUBLE PRECISION DEFAULT 0.0,
    UNIQUE(provider_id, stat_date)
);
CREATE INDEX IF NOT EXISTS idx_provider_stats_provider ON provider_stats(provider_id);

-- Provider withdrawal support
ALTER TABLE compute_providers ADD COLUMN IF NOT EXISTS wallet_address TEXT;
ALTER TABLE compute_providers ADD COLUMN IF NOT EXISTS total_withdrawn_usdc BIGINT DEFAULT 0;

CREATE TABLE IF NOT EXISTS provider_payouts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id UUID NOT NULL REFERENCES compute_providers(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id),
    amount_usdc BIGINT NOT NULL,
    to_address TEXT NOT NULL,
    signature TEXT,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'failed')),
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_provider_payouts_provider ON provider_payouts(provider_id);

-- Privacy: HD-derived intermediate wallets for provider payouts
ALTER TABLE compute_providers ADD COLUMN IF NOT EXISTS payout_index INT;
CREATE SEQUENCE IF NOT EXISTS payout_index_seq START 1;

-- Agent Rental Marketplace
CREATE TABLE IF NOT EXISTS rental_agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id UUID NOT NULL REFERENCES compute_providers(id) ON DELETE CASCADE,
    slug TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    avatar_url TEXT,
    system_prompt TEXT NOT NULL,
    model_id TEXT NOT NULL,
    temperature DOUBLE PRECISION DEFAULT 0.7,
    max_tokens INT DEFAULT 2048,
    tools TEXT[] DEFAULT '{}',
    tags TEXT[] DEFAULT '{}',
    is_public BOOLEAN DEFAULT true,
    is_active BOOLEAN DEFAULT true,
    total_conversations BIGINT DEFAULT 0,
    total_messages BIGINT DEFAULT 0,
    avg_rating DOUBLE PRECISION DEFAULT 0.0,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rental_agents_provider ON rental_agents(provider_id);
CREATE INDEX IF NOT EXISTS idx_rental_agents_active ON rental_agents(is_active, is_public);

CREATE TABLE IF NOT EXISTS agent_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES rental_agents(id) ON DELETE CASCADE,
    message_count INT DEFAULT 0,
    total_cost_usdc BIGINT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    last_message_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_user ON agent_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent ON agent_sessions(agent_id);

CREATE TABLE IF NOT EXISTS agent_ratings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES rental_agents(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    rating INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    feedback TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_ratings_agent ON agent_ratings(agent_id);

-- Link chat messages to agent sessions
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES rental_agents(id);
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS agent_session_id UUID REFERENCES agent_sessions(id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_agent_session ON chat_messages(agent_session_id);

-- Track which agent a compute job was for
ALTER TABLE compute_jobs ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES rental_agents(id);

-- Swarm Jobs (elastic agent dispatch)
CREATE TABLE IF NOT EXISTS swarm_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    -- Agent matching criteria
    require_tags TEXT[] DEFAULT '{}',
    require_tools TEXT[] DEFAULT '{}',
    prefer_model TEXT,
    min_reputation DOUBLE PRECISION DEFAULT 0.5,
    -- Budget
    max_budget_usdc BIGINT NOT NULL,
    spent_usdc BIGINT DEFAULT 0,
    -- Execution
    max_parallel INT DEFAULT 10,
    max_retries INT DEFAULT 1,
    timeout_secs INT DEFAULT 300,
    -- Status
    status TEXT DEFAULT 'pending' CHECK (status IN (
        'pending', 'matching', 'running', 'paused',
        'completed', 'partial', 'failed', 'cancelled'
    )),
    -- Counts (denormalized for fast reads)
    total_units INT DEFAULT 0,
    completed_units INT DEFAULT 0,
    failed_units INT DEFAULT 0,
    running_units INT DEFAULT 0,
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT now(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_swarm_jobs_user ON swarm_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_swarm_jobs_status ON swarm_jobs(status);

CREATE TABLE IF NOT EXISTS swarm_work_units (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    swarm_id UUID NOT NULL REFERENCES swarm_jobs(id) ON DELETE CASCADE,
    unit_index INT NOT NULL,
    -- Input
    prompt TEXT NOT NULL,
    context JSONB DEFAULT '{}',
    -- Assignment
    agent_id UUID REFERENCES rental_agents(id),
    provider_id UUID REFERENCES compute_providers(id),
    escrow_id UUID REFERENCES escrow_holds(id),
    job_id UUID REFERENCES compute_jobs(id),
    -- Output
    result TEXT,
    result_metadata JSONB,
    -- Status
    status TEXT DEFAULT 'pending' CHECK (status IN (
        'pending', 'assigned', 'running', 'completed', 'failed', 'cancelled', 'retrying'
    )),
    error_message TEXT,
    retry_count INT DEFAULT 0,
    -- Cost
    cost_usdc BIGINT DEFAULT 0,
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT now(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_swarm_units_swarm ON swarm_work_units(swarm_id);
CREATE INDEX IF NOT EXISTS idx_swarm_units_status ON swarm_work_units(swarm_id, status);
CREATE INDEX IF NOT EXISTS idx_swarm_units_agent ON swarm_work_units(agent_id);

-- x402 Payments (anonymous pay-per-request via Solana USDC)
CREATE TABLE IF NOT EXISTS x402_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tx_signature TEXT NOT NULL UNIQUE,
    payer_address TEXT NOT NULL,
    amount_usdc BIGINT NOT NULL,
    required_amount_usdc BIGINT NOT NULL,
    agent_id UUID REFERENCES rental_agents(id),
    provider_id UUID REFERENCES compute_providers(id),
    provider_amount BIGINT DEFAULT 0,
    platform_fee BIGINT DEFAULT 0,
    settled BOOLEAN DEFAULT false,
    model_id TEXT,
    input_tokens INT,
    output_tokens INT,
    latency_ms INT,
    created_at TIMESTAMPTZ DEFAULT now(),
    settled_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_x402_payments_tx ON x402_payments(tx_signature);
CREATE INDEX IF NOT EXISTS idx_x402_payments_payer ON x402_payments(payer_address);
CREATE INDEX IF NOT EXISTS idx_x402_payments_agent ON x402_payments(agent_id);

-- x402 payment status tracking (pending → settled | failed)
ALTER TABLE x402_payments ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending'
    CHECK (status IN ('pending', 'settled', 'failed'));

-- Task Bounties: allow escrow_holds without a compute provider
ALTER TABLE escrow_holds ALTER COLUMN provider_id DROP NOT NULL;

-- Bounty columns on tasks
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS bounty_usdc BIGINT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS executor_id UUID REFERENCES users(id);

-- Earnings tracking on user wallets
ALTER TABLE user_wallets ADD COLUMN IF NOT EXISTS earned_usdc BIGINT DEFAULT 0;
ALTER TABLE user_wallets ADD COLUMN IF NOT EXISTS withdrawn_usdc BIGINT DEFAULT 0;

-- Task bounties table
CREATE TABLE IF NOT EXISTS task_bounties (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE UNIQUE,
    funder_id UUID NOT NULL REFERENCES users(id),
    executor_id UUID REFERENCES users(id),
    amount_usdc BIGINT NOT NULL,
    platform_fee_bps INT NOT NULL DEFAULT 300,
    executor_amount BIGINT DEFAULT 0,
    platform_fee BIGINT DEFAULT 0,
    status TEXT DEFAULT 'held' CHECK (status IN ('held', 'released', 'refunded', 'expired')),
    escrow_id UUID REFERENCES escrow_holds(id),
    created_at TIMESTAMPTZ DEFAULT now(),
    settled_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_task_bounties_task ON task_bounties(task_id);
CREATE INDEX IF NOT EXISTS idx_task_bounties_funder ON task_bounties(funder_id);
CREATE INDEX IF NOT EXISTS idx_task_bounties_executor ON task_bounties(executor_id);
CREATE INDEX IF NOT EXISTS idx_task_bounties_status ON task_bounties(status);

-- Bounty earnings withdrawal tracking
CREATE TABLE IF NOT EXISTS bounty_payouts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    amount_usdc BIGINT NOT NULL,
    to_address TEXT NOT NULL,
    signature TEXT,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'failed')),
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_bounty_payouts_user ON bounty_payouts(user_id);

-- Task Marketplace: open bounty tasks that external executors can claim
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_open BOOLEAN DEFAULT false;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS title TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_marketplace ON tasks(is_open, status) WHERE is_open = true;

-- Identity + reputation for marketplace participants
ALTER TABLE users ADD COLUMN IF NOT EXISTS reputation_score DOUBLE PRECISION DEFAULT 0.5;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bounties_completed INT DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bounties_funded INT DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verified BOOLEAN DEFAULT false;

-- Optional minimum reputation to claim a task
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS min_reputation DOUBLE PRECISION;

-- Phase M3: Agent ownership — thread agent_id through task records.
-- The `agents` table itself lives in the said-cloud database, so we store
-- agent_id as a bare UUID with no FK constraint. The agent_did is the
-- did:key string, denormalized for convenience so the task engine can stamp
-- payment events with the agent identity without a cross-DB lookup.
-- v1 keeps wallets user-scoped; per-agent settlement is a follow-up phase.
ALTER TABLE tasks         ADD COLUMN IF NOT EXISTS agent_id UUID;
ALTER TABLE tasks         ADD COLUMN IF NOT EXISTS agent_did TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_id);

ALTER TABLE calls         ADD COLUMN IF NOT EXISTS agent_id UUID;
ALTER TABLE email_actions ADD COLUMN IF NOT EXISTS agent_id UUID;
ALTER TABLE task_bounties ADD COLUMN IF NOT EXISTS agent_id UUID;

-- ───────────────────────────────────────────────────────────────────────
-- Pair Device handshake mailbox (E2E key transport between user-owned devices)
-- ───────────────────────────────────────────────────────────────────────
--
-- A short-lived, write-once mailbox so device A can hand its session DEKs
-- to device B without the cloud being able to read them. Device A
-- encrypts a sealed envelope addressed to device B's freshly-minted
-- ephemeral X25519 pubkey (printed by B in a QR code) and POSTs it
-- here. Device B polls until the mailbox arrives and the row is deleted
-- on first read. The cloud only ever sees opaque ciphertext — see
-- crates/said-envelope for the wire format.
--
-- Constraints that matter:
--   - id is a high-entropy random token chosen by the receiving device
--     (≥16 bytes encoded). The cloud rejects PUT/GET on insufficiently
--     random ids at the route layer.
--   - One ciphertext per id (write-once). Subsequent POSTs to the same
--     id must fail; subsequent GETs after the first deletion must 404.
--   - Short TTL: rows expire after a few minutes. The route prunes on
--     read, so a cloud operator can never replay an unread mailbox to
--     a different receiver.
CREATE TABLE IF NOT EXISTS device_handshakes (
    id              TEXT PRIMARY KEY,
    envelope_blob   BYTEA NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_device_handshakes_expires
    ON device_handshakes(expires_at);

-- Refresh-token rotation (OAuth2-style, single-use).
--
-- The client gets a long-lived refresh token at sign-in. When the short-lived
-- access JWT expires, the client POSTs the refresh to /api/auth/refresh and
-- gets back a NEW access token AND a NEW refresh token. The old refresh row is
-- marked revoked and linked forward via rotated_to_hash, which makes
-- refresh-token theft detectable (if the same token is replayed after rotation,
-- the new chain can be revoked).
CREATE TABLE IF NOT EXISTS refresh_tokens (
    token_hash       TEXT PRIMARY KEY,            -- SHA-256(refresh_token)
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    issued_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at       TIMESTAMPTZ NOT NULL,
    revoked_at       TIMESTAMPTZ,
    rotated_to_hash  TEXT
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user
    ON refresh_tokens(user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires
    ON refresh_tokens(expires_at);
"#;
