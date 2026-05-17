use sqlx::PgPool;

/// Create all Orni Models tables in the 'orni' schema, idempotently.
/// The connection uses search_path=orni,public so all queries work
/// against the orni schema without SQL changes.
pub async fn ensure_schema(db: &PgPool) -> anyhow::Result<()> {
    // Create schema
    sqlx::query("CREATE SCHEMA IF NOT EXISTS orni").execute(db).await?;

    // pgcrypto provides gen_random_uuid() (used as column defaults across the
    // schema) and gen_random_bytes() (Phase 4.3 address_hmac_key default).
    // Idempotent.
    sqlx::query("CREATE EXTENSION IF NOT EXISTS pgcrypto").execute(db).await.ok();

    // Set search_path for this session (all subsequent queries use orni schema first)
    sqlx::query("SET search_path TO orni, public").execute(db).await?;

    // Enums (in orni schema) — each must be a separate query
    sqlx::query("DO $$ BEGIN CREATE TYPE orni.model_status AS ENUM ('draft', 'training', 'live', 'paused', 'failed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$").execute(db).await?;
    sqlx::query("DO $$ BEGIN CREATE TYPE orni.source_type AS ENUM ('text', 'pdf', 'youtube', 'blog'); EXCEPTION WHEN duplicate_object THEN NULL; END $$").execute(db).await?;
    sqlx::query("DO $$ BEGIN CREATE TYPE orni.content_status AS ENUM ('pending', 'processing', 'ready', 'failed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$").execute(db).await?;
    sqlx::query("DO $$ BEGIN CREATE TYPE orni.fine_tune_status AS ENUM ('pending', 'running', 'completed', 'failed', 'cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$").execute(db).await?;
    sqlx::query("DO $$ BEGIN CREATE TYPE orni.chat_role AS ENUM ('system', 'user', 'assistant'); EXCEPTION WHEN duplicate_object THEN NULL; END $$").execute(db).await?;

    // Tables (in orni schema, using original names so queries work unchanged)
    sqlx::query(r#"
        CREATE TABLE IF NOT EXISTS orni.users (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            wallet_address VARCHAR(64) UNIQUE,
            email VARCHAR(255) UNIQUE,
            password_hash VARCHAR(255),
            username VARCHAR(64) UNIQUE,
            display_name VARCHAR(128),
            avatar_url TEXT,
            is_creator BOOLEAN NOT NULL DEFAULT FALSE,
            usdc_balance BIGINT NOT NULL DEFAULT 0,
            stripe_customer_id VARCHAR(255),
            slug VARCHAR(64) UNIQUE,
            did TEXT UNIQUE,
            said_verified BOOLEAN NOT NULL DEFAULT FALSE,
            said_profile_url TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    "#).execute(db).await?;

    sqlx::query(r#"
        CREATE TABLE IF NOT EXISTS orni.models (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            creator_id UUID NOT NULL REFERENCES orni.users(id) ON DELETE CASCADE,
            slug VARCHAR(128) NOT NULL UNIQUE,
            name VARCHAR(256) NOT NULL,
            description TEXT,
            avatar_url TEXT,
            system_prompt TEXT NOT NULL,
            base_model VARCHAR(256) NOT NULL DEFAULT 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
            provider_model_id VARCHAR(256),
            status orni.model_status NOT NULL DEFAULT 'draft',
            price_per_query BIGINT NOT NULL DEFAULT 100000,
            total_queries BIGINT NOT NULL DEFAULT 0,
            total_revenue BIGINT NOT NULL DEFAULT 0,
            category VARCHAR(128),
            tags TEXT[] NOT NULL DEFAULT '{}',
            self_hosted_node_id UUID,
            self_hosted_endpoint TEXT,
            is_featured BOOLEAN NOT NULL DEFAULT FALSE,
            is_platform_model BOOLEAN NOT NULL DEFAULT FALSE,
            free_queries_per_day INT NOT NULL DEFAULT 0,
            avg_rating DOUBLE PRECISION NOT NULL DEFAULT 0,
            review_count INT NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    "#).execute(db).await?;

    sqlx::query(r#"CREATE TABLE IF NOT EXISTS orni.content_sources (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        model_id UUID NOT NULL REFERENCES orni.models(id) ON DELETE CASCADE,
        source_type orni.source_type NOT NULL, source_url TEXT, content_text TEXT,
        status orni.content_status NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )"#).execute(db).await?;

    sqlx::query(r#"CREATE TABLE IF NOT EXISTS orni.training_datasets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        model_id UUID NOT NULL REFERENCES orni.models(id) ON DELETE CASCADE,
        file_key TEXT NOT NULL, num_examples INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )"#).execute(db).await?;

    sqlx::query(r#"CREATE TABLE IF NOT EXISTS orni.fine_tune_jobs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        model_id UUID NOT NULL REFERENCES orni.models(id) ON DELETE CASCADE,
        provider_job_id VARCHAR(256), status orni.fine_tune_status NOT NULL DEFAULT 'pending',
        result_model_id VARCHAR(256), error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )"#).execute(db).await?;

    sqlx::query(r#"CREATE TABLE IF NOT EXISTS orni.chat_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES orni.users(id) ON DELETE CASCADE,
        model_id UUID NOT NULL REFERENCES orni.models(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )"#).execute(db).await?;

    sqlx::query(r#"CREATE TABLE IF NOT EXISTS orni.chat_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id UUID NOT NULL REFERENCES orni.chat_sessions(id) ON DELETE CASCADE,
        role orni.chat_role NOT NULL, content TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )"#).execute(db).await?;

    sqlx::query(r#"CREATE TABLE IF NOT EXISTS orni.payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES orni.users(id) ON DELETE CASCADE,
        model_id UUID NOT NULL REFERENCES orni.models(id) ON DELETE CASCADE,
        amount BIGINT NOT NULL, creator_share BIGINT NOT NULL, platform_share BIGINT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )"#).execute(db).await?;

    sqlx::query(r#"CREATE TABLE IF NOT EXISTS orni.deposits (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES orni.users(id) ON DELETE CASCADE,
        amount BIGINT NOT NULL, tx_signature VARCHAR(128) NOT NULL UNIQUE,
        verified BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )"#).execute(db).await?;

    sqlx::query(r#"CREATE TABLE IF NOT EXISTS orni.credit_purchases (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES orni.users(id) ON DELETE CASCADE,
        amount_micro_usdc BIGINT NOT NULL, amount_usd_cents INT NOT NULL,
        stripe_session_id VARCHAR(255) UNIQUE, status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )"#).execute(db).await?;

    sqlx::query(r#"CREATE TABLE IF NOT EXISTS orni.free_query_usage (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES orni.users(id) ON DELETE CASCADE,
        model_id UUID NOT NULL REFERENCES orni.models(id) ON DELETE CASCADE,
        query_date DATE NOT NULL DEFAULT CURRENT_DATE, query_count INT NOT NULL DEFAULT 1,
        UNIQUE(user_id, model_id, query_date)
    )"#).execute(db).await?;

    sqlx::query(r#"CREATE TABLE IF NOT EXISTS orni.api_keys (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES orni.users(id) ON DELETE CASCADE,
        model_id UUID NOT NULL REFERENCES orni.models(id) ON DELETE CASCADE,
        key_hash VARCHAR(64) NOT NULL UNIQUE, key_prefix VARCHAR(12) NOT NULL,
        name VARCHAR(128), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMPTZ, is_active BOOLEAN NOT NULL DEFAULT TRUE
    )"#).execute(db).await?;

    sqlx::query(r#"CREATE TABLE IF NOT EXISTS orni.model_reviews (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES orni.users(id) ON DELETE CASCADE,
        model_id UUID NOT NULL REFERENCES orni.models(id) ON DELETE CASCADE,
        rating INT NOT NULL CHECK (rating >= 1 AND rating <= 5),
        review_text TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, model_id)
    )"#).execute(db).await?;

    // Settlement queue for on-chain USDC payouts
    sqlx::query(r#"
        CREATE TABLE IF NOT EXISTS orni.settlement_queue (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            creator_id UUID NOT NULL REFERENCES orni.users(id) ON DELETE CASCADE,
            creator_wallet TEXT,
            amount_micro_usdc BIGINT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            tx_signature TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            settled_at TIMESTAMPTZ
        )
    "#).execute(db).await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_settlement_queue_status ON orni.settlement_queue(status)")
        .execute(db).await.ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_settlement_queue_wallet ON orni.settlement_queue(creator_wallet)")
        .execute(db).await.ok();

    // ── Multi-currency stablecoin support (USDT primary, USDC secondary) ──
    // Native per-currency balance ledger. `users.usdc_balance` remains as a
    // legacy column during the transition; new writes go here.
    sqlx::query(r#"
        CREATE TABLE IF NOT EXISTS orni.currency_balances (
            user_id    UUID NOT NULL REFERENCES orni.users(id) ON DELETE CASCADE,
            currency   VARCHAR(10) NOT NULL,
            balance    BIGINT NOT NULL DEFAULT 0,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (user_id, currency)
        )
    "#).execute(db).await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_currency_balances_user ON orni.currency_balances(user_id)")
        .execute(db).await.ok();

    // Tag payment-touching rows with the moved currency. Default 'USDC' keeps
    // pre-migration rows interpretable.
    for stmt in [
        "ALTER TABLE orni.deposits         ADD COLUMN IF NOT EXISTS currency VARCHAR(10) NOT NULL DEFAULT 'USDC'",
        "ALTER TABLE orni.payments         ADD COLUMN IF NOT EXISTS currency VARCHAR(10) NOT NULL DEFAULT 'USDC'",
        "ALTER TABLE orni.settlement_queue ADD COLUMN IF NOT EXISTS currency VARCHAR(10) NOT NULL DEFAULT 'USDC'",
    ] {
        sqlx::query(stmt).execute(db).await?;
    }

    // One-shot backfill — idempotent via ON CONFLICT.
    sqlx::query(r#"
        INSERT INTO orni.currency_balances (user_id, currency, balance)
        SELECT id, 'USDC', usdc_balance FROM orni.users WHERE usdc_balance > 0
        ON CONFLICT (user_id, currency) DO NOTHING
    "#).execute(db).await.ok();

    // ── Phase 3.5: large-withdrawal gating + replay protection ──
    // settlement_queue gains:
    //   - `approval_status`: 'auto' (small enough to skip approval), 'pending'
    //     (waiting on second-admin sign-off), 'approved', 'rejected'.
    //   - `withdrawal_id`: idempotency key (UNIQUE per user) so a retried
    //     POST /withdraw can't double-spend.
    for stmt in [
        "ALTER TABLE orni.settlement_queue ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) NOT NULL DEFAULT 'auto'",
        "ALTER TABLE orni.settlement_queue ADD COLUMN IF NOT EXISTS withdrawal_id UUID",
        "ALTER TABLE orni.settlement_queue ADD COLUMN IF NOT EXISTS requested_by UUID",
        "ALTER TABLE orni.settlement_queue ADD COLUMN IF NOT EXISTS approved_by UUID",
        "ALTER TABLE orni.settlement_queue ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ",
    ] {
        sqlx::query(stmt).execute(db).await?;
    }
    // Idempotency: same (requested_by, withdrawal_id) cannot be enqueued twice.
    sqlx::query("CREATE UNIQUE INDEX IF NOT EXISTS uq_settlement_withdrawal ON orni.settlement_queue(requested_by, withdrawal_id) WHERE withdrawal_id IS NOT NULL")
        .execute(db).await.ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_settlement_approval_status ON orni.settlement_queue(approval_status) WHERE approval_status IN ('pending','approved')")
        .execute(db).await.ok();

    // ── Phase 3.7: append-only audit tables ──
    // Sanctions / risk-screening blocks. We store only the *hashed* address +
    // the screening result, never the cleartext address (Phase 4.4 alignment).
    sqlx::query(r#"
        CREATE TABLE IF NOT EXISTS orni.screening_blocks (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id         UUID REFERENCES orni.users(id) ON DELETE SET NULL,
            address_hash    VARCHAR(64) NOT NULL,
            backend         VARCHAR(32) NOT NULL,
            reason          TEXT,
            blocked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    "#).execute(db).await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_screening_blocks_user ON orni.screening_blocks(user_id)")
        .execute(db).await.ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_screening_blocks_address ON orni.screening_blocks(address_hash)")
        .execute(db).await.ok();

    // Append-only marker: every UPDATE on payments/deposits is rejected at the
    // DB level. Lets us catch any code that tries to mutate a settled payment
    // (which would corrupt the audit trail).
    sqlx::query(r#"
        CREATE OR REPLACE FUNCTION orni.reject_update_after_insert() RETURNS TRIGGER AS $$
        BEGIN
            RAISE EXCEPTION 'rows in % are append-only', TG_TABLE_NAME;
        END;
        $$ LANGUAGE plpgsql
    "#).execute(db).await.ok();
    // Drop-and-recreate so we can run repeatedly without DROP TRIGGER IF EXISTS gymnastics.
    sqlx::query("DROP TRIGGER IF EXISTS payments_no_update ON orni.payments").execute(db).await.ok();
    sqlx::query("CREATE TRIGGER payments_no_update BEFORE UPDATE ON orni.payments FOR EACH ROW EXECUTE FUNCTION orni.reject_update_after_insert()")
        .execute(db).await.ok();

    // ── Phase 4.1: per-user deposit subaddresses ──
    // Each user gets a fresh wallet (per-currency ATA) for deposits. The
    // hot/cold sweep from Phase 3 pulls funds from these into the platform
    // hot wallet. On-chain observers can no longer query "all Ghola deposits"
    // by hitting one address.
    sqlx::query(r#"
        CREATE TABLE IF NOT EXISTS orni.user_deposit_wallets (
            user_id              UUID NOT NULL REFERENCES orni.users(id) ON DELETE CASCADE,
            wallet_pubkey        VARCHAR(64) NOT NULL,
            encrypted_secret_key BYTEA NOT NULL,
            provider             VARCHAR(32) NOT NULL DEFAULT 'local',
            created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (user_id)
        )
    "#).execute(db).await?;
    sqlx::query("CREATE UNIQUE INDEX IF NOT EXISTS uq_user_deposit_wallets_pubkey ON orni.user_deposit_wallets(wallet_pubkey)")
        .execute(db).await.ok();

    // ── Phase 4.3: HMAC'd address storage ──
    // Per-user secret keyed-MAC. A DB breach now reveals tier balances and
    // aggregate volumes but not the on-chain graph linking wallets to users.
    // Cleartext addresses still exist on rows where we need to send a transfer
    // (settlement_queue.creator_wallet, deposits during verification) — those
    // get wiped once the on-chain action completes; the `*_address_hash`
    // columns are what we keep long-term.
    for stmt in [
        "ALTER TABLE orni.users ADD COLUMN IF NOT EXISTS address_hmac_key BYTEA NOT NULL DEFAULT gen_random_bytes(32)",
        "ALTER TABLE orni.deposits ADD COLUMN IF NOT EXISTS source_address_hash VARCHAR(64)",
        "ALTER TABLE orni.settlement_queue ADD COLUMN IF NOT EXISTS dest_address_hash VARCHAR(64)",
    ] {
        sqlx::query(stmt).execute(db).await?;
    }

    // ── Phase 4.6: tiered compliance ──
    // Default tier = privacy-first (per-user subaddresses, 30-day retention,
    // hash-only screening). Verified tier = full sanctions data + 7-year
    // retention, triggered by volume / fiat off-ramp / large withdrawal.
    for stmt in [
        "ALTER TABLE orni.users ADD COLUMN IF NOT EXISTS tier VARCHAR(20) NOT NULL DEFAULT 'default'",
        "ALTER TABLE orni.screening_blocks ADD COLUMN IF NOT EXISTS retention_days INT NOT NULL DEFAULT 30",
    ] {
        sqlx::query(stmt).execute(db).await?;
    }

    sqlx::query(r#"
        CREATE TABLE IF NOT EXISTS orni.tier_events (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id     UUID NOT NULL REFERENCES orni.users(id) ON DELETE CASCADE,
            from_tier   VARCHAR(20) NOT NULL,
            to_tier     VARCHAR(20) NOT NULL,
            reason      TEXT NOT NULL,
            occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    "#).execute(db).await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_tier_events_user ON orni.tier_events(user_id)")
        .execute(db).await.ok();

    // ── Spending budgets (caps, not seats) ──
    // Pre-charge enforcement: every debit checks the user's rolling-window
    // spend against their caps. Defaults below are sane for first-deposit
    // users who never touch the UI ($50/day, $1k/month). The real value is
    // unlocking larger deposits — a user with a cap will deposit 10× what
    // they would without one, because the loss-aversion math changes.
    sqlx::query(r#"
        CREATE TABLE IF NOT EXISTS orni.user_budgets (
            user_id           UUID PRIMARY KEY REFERENCES orni.users(id) ON DELETE CASCADE,
            daily_cap_micro   BIGINT NOT NULL DEFAULT 50000000,
            monthly_cap_micro BIGINT NOT NULL DEFAULT 1000000000,
            total_cap_micro   BIGINT,
            enabled           BOOLEAN NOT NULL DEFAULT TRUE,
            created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    "#).execute(db).await?;
    // payments.created_at is the substrate the budget check sums over —
    // make sure it's indexed so the rolling-window queries stay fast.
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_payments_user_created ON orni.payments(user_id, created_at DESC)")
        .execute(db).await.ok();

    // Seed platform user + models
    sqlx::query(r#"
        INSERT INTO orni.users (id, wallet_address, display_name, is_creator)
        VALUES ('00000000-0000-0000-0000-000000000001', NULL, 'Orni Platform', TRUE)
        ON CONFLICT DO NOTHING
    "#).execute(db).await.ok();

    sqlx::query(r#"
        INSERT INTO orni.models (id, creator_id, slug, name, description, system_prompt, base_model, provider_model_id, status, price_per_query, category, is_featured, is_platform_model, free_queries_per_day)
        VALUES
            ('00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001', 'llama-3-8b', 'Llama 3.1 8B', 'Meta''s fast and capable open-source model.', 'You are a helpful AI assistant.', 'llama-3.1-8b-instant', 'llama-3.1-8b-instant', 'live', 50000, 'Technology', TRUE, TRUE, 100),
            ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001', 'qwen-32b', 'Qwen3 32B', 'Alibaba''s powerful reasoning model.', 'You are a helpful AI assistant.', 'qwen/qwen3-32b', 'qwen/qwen3-32b', 'live', 50000, 'Technology', TRUE, TRUE, 100),
            ('00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000001', 'llama-3-70b', 'Llama 3.3 70B', 'Meta''s most capable open model.', 'You are a helpful AI assistant.', 'llama-3.3-70b-versatile', 'llama-3.3-70b-versatile', 'live', 200000, 'Technology', TRUE, TRUE, 100),
            ('00000000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-000000000001', 'llama-scout-17b', 'Llama 4 Scout 17B', 'Meta''s latest Llama 4 model.', 'You are a coding and reasoning assistant.', 'meta-llama/llama-4-scout-17b-16e-instruct', 'meta-llama/llama-4-scout-17b-16e-instruct', 'live', 100000, 'Technology', TRUE, TRUE, 5)
        ON CONFLICT DO NOTHING
    "#).execute(db).await.ok();

    // Update free tier on existing platform models (seed uses ON CONFLICT DO NOTHING
    // so this handles models created before the free tier bump)
    // Set free tier on ALL models (platform + user-created)
    sqlx::query("UPDATE orni.models SET free_queries_per_day = 100 WHERE free_queries_per_day < 100")
        .execute(db).await.ok();

    // ── Foundation catalog metadata (Phase 1) ──
    // Additive ALTER TABLEs — idempotent via IF NOT EXISTS.
    for stmt in [
        "ALTER TABLE orni.models ADD COLUMN IF NOT EXISTS params_b DOUBLE PRECISION",
        "ALTER TABLE orni.models ADD COLUMN IF NOT EXISTS active_params_b DOUBLE PRECISION",
        "ALTER TABLE orni.models ADD COLUMN IF NOT EXISTS license TEXT",
        "ALTER TABLE orni.models ADD COLUMN IF NOT EXISTS license_url TEXT",
        "ALTER TABLE orni.models ADD COLUMN IF NOT EXISTS developer TEXT",
        "ALTER TABLE orni.models ADD COLUMN IF NOT EXISTS architecture TEXT",
        "ALTER TABLE orni.models ADD COLUMN IF NOT EXISTS context_window INTEGER",
        "ALTER TABLE orni.models ADD COLUMN IF NOT EXISTS modality TEXT[] NOT NULL DEFAULT ARRAY['text']::TEXT[]",
        "ALTER TABLE orni.models ADD COLUMN IF NOT EXISTS hf_id TEXT",
        "ALTER TABLE orni.models ADD COLUMN IF NOT EXISTS release_date DATE",
        "ALTER TABLE orni.models ADD COLUMN IF NOT EXISTS is_foundation BOOLEAN NOT NULL DEFAULT FALSE",
        "ALTER TABLE orni.models ADD COLUMN IF NOT EXISTS gguf_available BOOLEAN NOT NULL DEFAULT FALSE",
        "ALTER TABLE orni.models ADD COLUMN IF NOT EXISTS recommended_vram_gb INTEGER",
    ] {
        sqlx::query(stmt).execute(db).await?;
    }

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_models_is_foundation ON orni.models(is_foundation) WHERE is_foundation = TRUE")
        .execute(db).await.ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_models_developer ON orni.models(developer)")
        .execute(db).await.ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_models_license ON orni.models(license)")
        .execute(db).await.ok();

    // Waitlist table for catalog-only foundation models (no provider yet).
    sqlx::query(r#"
        CREATE TABLE IF NOT EXISTS orni.model_interest (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            model_id UUID NOT NULL REFERENCES orni.models(id) ON DELETE CASCADE,
            user_id UUID REFERENCES orni.users(id) ON DELETE SET NULL,
            email TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CHECK (user_id IS NOT NULL OR email IS NOT NULL)
        )
    "#).execute(db).await?;
    sqlx::query("CREATE UNIQUE INDEX IF NOT EXISTS idx_model_interest_user ON orni.model_interest(model_id, user_id) WHERE user_id IS NOT NULL")
        .execute(db).await.ok();
    sqlx::query("CREATE UNIQUE INDEX IF NOT EXISTS idx_model_interest_email ON orni.model_interest(model_id, email) WHERE email IS NOT NULL")
        .execute(db).await.ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_model_interest_model ON orni.model_interest(model_id)")
        .execute(db).await.ok();

    // Backfill foundation metadata on existing 4 platform seeds.
    sqlx::query(r#"
        UPDATE orni.models SET
            is_foundation = TRUE,
            developer = 'Meta',
            architecture = 'llama',
            params_b = 8.03,
            context_window = 131072,
            license = 'llama-3.1-community',
            license_url = 'https://www.llama.com/llama3_1/license/',
            hf_id = 'meta-llama/Llama-3.1-8B-Instruct',
            release_date = '2024-07-23',
            gguf_available = TRUE,
            recommended_vram_gb = 8
        WHERE slug = 'llama-3-8b'
    "#).execute(db).await.ok();

    sqlx::query(r#"
        UPDATE orni.models SET
            is_foundation = TRUE,
            developer = 'Alibaba',
            architecture = 'qwen3',
            params_b = 32.5,
            context_window = 131072,
            license = 'apache-2.0',
            license_url = 'https://www.apache.org/licenses/LICENSE-2.0',
            hf_id = 'Qwen/Qwen3-32B',
            release_date = '2025-04-29',
            gguf_available = TRUE,
            recommended_vram_gb = 32
        WHERE slug = 'qwen-32b'
    "#).execute(db).await.ok();

    sqlx::query(r#"
        UPDATE orni.models SET
            is_foundation = TRUE,
            developer = 'Meta',
            architecture = 'llama',
            params_b = 70.6,
            context_window = 131072,
            license = 'llama-3.3-community',
            license_url = 'https://www.llama.com/llama3_3/license/',
            hf_id = 'meta-llama/Llama-3.3-70B-Instruct',
            release_date = '2024-12-06',
            gguf_available = TRUE,
            recommended_vram_gb = 48
        WHERE slug = 'llama-3-70b'
    "#).execute(db).await.ok();

    sqlx::query(r#"
        UPDATE orni.models SET
            is_foundation = TRUE,
            developer = 'Meta',
            architecture = 'llama-4-moe',
            params_b = 109,
            active_params_b = 17,
            context_window = 10485760,
            license = 'llama-4-community',
            license_url = 'https://www.llama.com/llama4/license/',
            hf_id = 'meta-llama/Llama-4-Scout-17B-16E-Instruct',
            release_date = '2025-04-05',
            gguf_available = FALSE,
            recommended_vram_gb = 80
        WHERE slug = 'llama-scout-17b'
    "#).execute(db).await.ok();

    // ── Together-backed foundation seeds (chat works immediately via fallback) ──
    sqlx::query(r#"
        INSERT INTO orni.models (id, creator_id, slug, name, description, system_prompt,
            base_model, provider_model_id, status, price_per_query, category, tags,
            is_featured, is_platform_model, free_queries_per_day,
            is_foundation, developer, architecture, params_b, active_params_b,
            context_window, license, license_url, hf_id, release_date,
            gguf_available, recommended_vram_gb)
        VALUES
        ('00000000-0000-0000-0000-000000000020', '00000000-0000-0000-0000-000000000001',
         'llama-4-maverick-17b', 'Llama 4 Maverick 17B 128E',
         'Meta''s flagship Llama 4 Mixture-of-Experts. 17B active parameters route through 128 experts (~400B total) for frontier-quality reasoning.',
         'You are a helpful, knowledgeable assistant powered by Llama 4 Maverick. Reason carefully and answer thoroughly.',
         'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8', 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
         'live', 500000, 'Technology', ARRAY['foundation','meta','llama-4','moe','17b-active'],
         TRUE, TRUE, 100,
         TRUE, 'Meta', 'llama-4-moe', 400, 17,
         1048576, 'llama-4-community', 'https://www.llama.com/llama4/license/',
         'meta-llama/Llama-4-Maverick-17B-128E-Instruct', '2025-04-05', FALSE, 200),

        ('00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000001',
         'qwen-25-72b', 'Qwen 2.5 72B Instruct',
         'Alibaba''s high-capability dense model. Strong at multilingual reasoning, math, code, and long-context analysis.',
         'You are a helpful AI assistant powered by Qwen 2.5 72B. Provide clear, well-reasoned responses.',
         'Qwen/Qwen2.5-72B-Instruct-Turbo', 'Qwen/Qwen2.5-72B-Instruct-Turbo',
         'live', 200000, 'Technology', ARRAY['foundation','alibaba','qwen','72b'],
         TRUE, TRUE, 100,
         TRUE, 'Alibaba', 'qwen2', 72.7, NULL,
         131072, 'qwen', 'https://huggingface.co/Qwen/Qwen2.5-72B-Instruct/blob/main/LICENSE',
         'Qwen/Qwen2.5-72B-Instruct', '2024-09-19', TRUE, 48),

        ('00000000-0000-0000-0000-000000000022', '00000000-0000-0000-0000-000000000001',
         'qwen-25-coder-32b', 'Qwen 2.5 Coder 32B',
         'Specialized coding model from Alibaba. State-of-the-art among open-weight code models — fluent in 90+ languages, strong at refactoring and debugging.',
         'You are a coding assistant powered by Qwen 2.5 Coder. Produce clean, idiomatic, well-tested code. Explain non-obvious choices.',
         'Qwen/Qwen2.5-Coder-32B-Instruct', 'Qwen/Qwen2.5-Coder-32B-Instruct',
         'live', 50000, 'Technology', ARRAY['foundation','alibaba','qwen','coder','32b'],
         TRUE, TRUE, 100,
         TRUE, 'Alibaba', 'qwen2', 32.8, NULL,
         131072, 'apache-2.0', 'https://www.apache.org/licenses/LICENSE-2.0',
         'Qwen/Qwen2.5-Coder-32B-Instruct', '2024-11-12', TRUE, 32),

        ('00000000-0000-0000-0000-000000000023', '00000000-0000-0000-0000-000000000001',
         'deepseek-v3', 'DeepSeek V3',
         'DeepSeek''s 671B-parameter MoE with 37B active per token. Frontier-tier open weights for reasoning, math, and code at a fraction of dense-model cost.',
         'You are a thoughtful AI assistant powered by DeepSeek V3. Reason step-by-step on hard problems and answer concisely on easy ones.',
         'deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-V3',
         'live', 500000, 'Technology', ARRAY['foundation','deepseek','moe','671b','37b-active'],
         TRUE, TRUE, 100,
         TRUE, 'DeepSeek', 'deepseek-v3-moe', 671, 37,
         131072, 'deepseek', 'https://github.com/deepseek-ai/DeepSeek-V3/blob/main/LICENSE-MODEL',
         'deepseek-ai/DeepSeek-V3', '2024-12-26', TRUE, 512),

        ('00000000-0000-0000-0000-000000000024', '00000000-0000-0000-0000-000000000001',
         'deepseek-r1-distill-70b', 'DeepSeek R1 Distill Llama 70B',
         'R1''s reasoning capability distilled into a Llama 70B base. Open-weight chain-of-thought reasoning that runs on a single 8×A100 node.',
         'You are a reasoning assistant powered by DeepSeek R1. Think step-by-step inside <think> tags before answering.',
         'deepseek-ai/DeepSeek-R1-Distill-Llama-70B', 'deepseek-ai/DeepSeek-R1-Distill-Llama-70B',
         'live', 200000, 'Technology', ARRAY['foundation','deepseek','reasoning','70b','distill'],
         TRUE, TRUE, 100,
         TRUE, 'DeepSeek', 'llama', 70.6, NULL,
         131072, 'mit', 'https://opensource.org/licenses/MIT',
         'deepseek-ai/DeepSeek-R1-Distill-Llama-70B', '2025-01-20', TRUE, 48),

        ('00000000-0000-0000-0000-000000000025', '00000000-0000-0000-0000-000000000001',
         'mistral-small-3', 'Mistral Small 3 24B',
         'Mistral''s efficient 24B dense model. Competitive with much larger models on reasoning while running fast on a single 32GB GPU.',
         'You are a concise, helpful AI assistant powered by Mistral Small 3. Be direct and accurate.',
         'mistralai/Mistral-Small-24B-Instruct-2501', 'mistralai/Mistral-Small-24B-Instruct-2501',
         'live', 50000, 'Technology', ARRAY['foundation','mistral','24b','efficient'],
         TRUE, TRUE, 100,
         TRUE, 'Mistral AI', 'llama', 23.6, NULL,
         32768, 'apache-2.0', 'https://www.apache.org/licenses/LICENSE-2.0',
         'mistralai/Mistral-Small-24B-Instruct-2501', '2025-01-30', TRUE, 24),

        ('00000000-0000-0000-0000-000000000026', '00000000-0000-0000-0000-000000000001',
         'gemma-2-27b', 'Gemma 2 27B',
         'Google''s open-weight Gemma 2 flagship. Tuned for helpful, safe, balanced responses; strong general-purpose chat under 30B parameters.',
         'You are a helpful AI assistant powered by Gemma 2. Provide balanced, accurate answers.',
         'google/gemma-2-27b-it', 'google/gemma-2-27b-it',
         'live', 50000, 'Technology', ARRAY['foundation','google','gemma','27b'],
         FALSE, TRUE, 100,
         TRUE, 'Google', 'gemma2', 27.2, NULL,
         8192, 'gemma', 'https://ai.google.dev/gemma/terms',
         'google/gemma-2-27b-it', '2024-06-27', TRUE, 24)
        ON CONFLICT (id) DO NOTHING
    "#).execute(db).await.ok();

    // ── Catalog-only foundation seeds (provider_model_id NULL → waitlist mode) ──
    // price_per_query = 0 because column is NOT NULL; frontend recognizes catalog-only
    // via awaiting_host derived from (provider_model_id IS NULL AND no self-hosted endpoint).
    sqlx::query(r#"
        INSERT INTO orni.models (id, creator_id, slug, name, description, system_prompt,
            base_model, provider_model_id, status, price_per_query, category, tags,
            is_featured, is_platform_model, free_queries_per_day,
            is_foundation, developer, architecture, params_b, active_params_b,
            context_window, license, license_url, hf_id, release_date,
            gguf_available, recommended_vram_gb)
        VALUES
        ('00000000-0000-0000-0000-000000000030', '00000000-0000-0000-0000-000000000001',
         'deepseek-r1-671b', 'DeepSeek R1 671B',
         'The full DeepSeek R1 reasoning model — 671B parameters with 37B active. Frontier-grade chain-of-thought reasoning, MIT-licensed open weights. Awaiting node-operator hosting.',
         'You are a reasoning assistant powered by DeepSeek R1. Think step-by-step inside <think> tags before answering.',
         'deepseek-ai/DeepSeek-R1', NULL,
         'live', 0, 'Technology', ARRAY['foundation','deepseek','reasoning','moe','671b','37b-active'],
         TRUE, TRUE, 0,
         TRUE, 'DeepSeek', 'deepseek-v3-moe', 671, 37,
         131072, 'mit', 'https://opensource.org/licenses/MIT',
         'deepseek-ai/DeepSeek-R1', '2025-01-20', TRUE, 512),

        ('00000000-0000-0000-0000-000000000031', '00000000-0000-0000-0000-000000000001',
         'mistral-large-2', 'Mistral Large 2 123B',
         'Mistral''s research-licensed flagship dense model. 123B parameters, 128K context. Non-commercial license — best suited for research nodes and enterprise hosts with a Mistral commercial agreement.',
         'You are a sophisticated AI assistant powered by Mistral Large 2. Provide thorough, well-reasoned analysis.',
         'mistralai/Mistral-Large-Instruct-2407', NULL,
         'live', 0, 'Technology', ARRAY['foundation','mistral','large','123b','non-commercial'],
         FALSE, TRUE, 0,
         TRUE, 'Mistral AI', 'llama', 123, NULL,
         131072, 'mistral-research', 'https://mistral.ai/licenses/MRL-0.1.md',
         'mistralai/Mistral-Large-Instruct-2407', '2024-07-24', TRUE, 96),

        ('00000000-0000-0000-0000-000000000032', '00000000-0000-0000-0000-000000000001',
         'command-r-plus', 'Command R+ 104B',
         'Cohere''s tool-use and RAG specialist. Best-in-class at structured outputs, citations, and 10-language fluency. CC-BY-NC license — research-grade for non-commercial nodes.',
         'You are an enterprise AI assistant powered by Command R+. Excel at retrieval-augmented answers and tool use; cite sources when available.',
         'CohereForAI/c4ai-command-r-plus-08-2024', NULL,
         'live', 0, 'Technology', ARRAY['foundation','cohere','command-r','rag','tool-use','104b'],
         FALSE, TRUE, 0,
         TRUE, 'Cohere', 'command-r', 104, NULL,
         131072, 'cc-by-nc-4.0', 'https://creativecommons.org/licenses/by-nc/4.0/',
         'CohereForAI/c4ai-command-r-plus-08-2024', '2024-08-30', TRUE, 80),

        ('00000000-0000-0000-0000-000000000033', '00000000-0000-0000-0000-000000000001',
         'hermes-3-405b', 'Hermes 3 405B',
         'Nous Research''s flagship fine-tune of Llama 3.1 405B. Steerable, uncensored-by-default agent model with strong roleplay and tool-use behavior. Community-hosted.',
         'You are Hermes, a steerable AI assistant. Follow user instructions precisely; default to direct, unfiltered answers within applicable laws.',
         'NousResearch/Hermes-3-Llama-3.1-405B', NULL,
         'live', 0, 'Technology', ARRAY['foundation','nous','hermes','llama','405b','agent'],
         FALSE, TRUE, 0,
         TRUE, 'Nous Research', 'llama', 405, NULL,
         131072, 'llama-3.1-community', 'https://www.llama.com/llama3_1/license/',
         'NousResearch/Hermes-3-Llama-3.1-405B', '2024-08-15', TRUE, 320),

        ('00000000-0000-0000-0000-000000000034', '00000000-0000-0000-0000-000000000001',
         'phi-4', 'Phi-4 14B',
         'Microsoft''s 14B small-language-model flagship. Punches well above its weight on math and reasoning thanks to synthetic curriculum training. MIT-licensed.',
         'You are a precise, helpful AI assistant powered by Phi-4. Be concise and reason carefully on math and logic.',
         'microsoft/phi-4', NULL,
         'live', 0, 'Technology', ARRAY['foundation','microsoft','phi','14b','reasoning'],
         FALSE, TRUE, 0,
         TRUE, 'Microsoft', 'phi', 14.7, NULL,
         16384, 'mit', 'https://opensource.org/licenses/MIT',
         'microsoft/phi-4', '2024-12-12', TRUE, 12)
        ON CONFLICT (id) DO NOTHING
    "#).execute(db).await.ok();

    Ok(())
}
