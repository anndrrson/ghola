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
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);

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

-- Ensure OAuth provider columns exist (table may predate these)
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_apple_id ON users(apple_id) WHERE apple_id IS NOT NULL;

-- Ensure columns from CREATE TABLE exist (live DB may predate them)
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'America/New_York';
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS said_identity_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();

-- Enterprise tier support
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_tier_check;
ALTER TABLE users ADD CONSTRAINT users_tier_check
    CHECK (tier IN ('free', 'pro', 'unlimited', 'enterprise'));
"#;
