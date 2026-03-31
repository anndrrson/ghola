-- Migration 016: Enterprise ops layer
-- Multi-tenant isolation, audit trail, OIDC federation, treasury management,
-- configurable settlement

-- ── Tenants ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tenants (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                      TEXT NOT NULL,
    slug                      TEXT NOT NULL UNIQUE,
    owner_user_id             UUID NOT NULL REFERENCES users(id),
    -- Settlement config (overrides global defaults)
    settlement_interval_secs  INTEGER NOT NULL DEFAULT 3600,
    max_settlement_batch_size INTEGER NOT NULL DEFAULT 1000,
    fallback_rpc_urls         TEXT[]  NOT NULL DEFAULT '{}',
    -- Misc tenant settings (JSON bag for extensibility)
    settings                  JSONB   NOT NULL DEFAULT '{}',
    created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tenant_members (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        TEXT NOT NULL DEFAULT 'member',  -- owner | admin | member | viewer
    department  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS tenant_departments (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name                  TEXT NOT NULL,
    budget_micro_usdc     BIGINT NOT NULL DEFAULT 0,
    parent_department_id  UUID REFERENCES tenant_departments(id),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_tenant_members_user     ON tenant_members(user_id);
CREATE INDEX IF NOT EXISTS idx_tenant_members_tenant   ON tenant_members(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_depts_tenant     ON tenant_departments(tenant_id);

-- ── Audit Events ─────────────────────────────────────────────────────────────
-- Each row includes the SHA-256 hash of the previous row's hash, forming an
-- append-only chain that detects any retrospective tampering.

CREATE TABLE IF NOT EXISTS audit_events (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID REFERENCES tenants(id),
    actor_did      TEXT NOT NULL,
    actor_user_id  UUID REFERENCES users(id),
    event_type     TEXT NOT NULL,   -- wallet_op | payment | policy_change | circuit_breaker | ucan_delegation | etc.
    resource_type  TEXT,
    resource_id    TEXT,
    details        JSONB NOT NULL DEFAULT '{}',
    prev_hash      TEXT,            -- NULL for first event in a chain
    event_hash     TEXT NOT NULL,   -- SHA-256(prev_hash || id || event_type || details || created_at)
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_tenant    ON audit_events(tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor     ON audit_events(actor_did);
CREATE INDEX IF NOT EXISTS idx_audit_type      ON audit_events(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_created   ON audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_resource  ON audit_events(resource_type, resource_id);

-- ── OIDC Federation ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS oidc_providers (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name               TEXT NOT NULL,
    issuer_url         TEXT NOT NULL,
    client_id          TEXT NOT NULL,
    client_secret_enc  TEXT NOT NULL,  -- AES-256-GCM encrypted with server key
    discovery_url      TEXT NOT NULL,  -- issuer_url + /.well-known/openid-configuration
    -- JSON mapping: {"sub":"agent_did","email":"email","groups":"roles"}
    claim_mapping      JSONB NOT NULL DEFAULT '{}',
    active             BOOLEAN NOT NULL DEFAULT true,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, issuer_url)
);

CREATE TABLE IF NOT EXISTS oidc_provisioned_agents (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    provider_id   UUID NOT NULL REFERENCES oidc_providers(id) ON DELETE CASCADE,
    external_sub  TEXT NOT NULL,   -- OIDC subject claim
    user_id       UUID REFERENCES users(id),
    did           TEXT NOT NULL,
    last_login    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (provider_id, external_sub)
);

CREATE INDEX IF NOT EXISTS idx_oidc_providers_tenant   ON oidc_providers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_oidc_agents_tenant      ON oidc_provisioned_agents(tenant_id);
CREATE INDEX IF NOT EXISTS idx_oidc_agents_provider    ON oidc_provisioned_agents(provider_id);
CREATE INDEX IF NOT EXISTS idx_oidc_agents_did         ON oidc_provisioned_agents(did);

-- ── Treasury Management ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS treasury_pools (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name                            TEXT NOT NULL,
    funding_wallet_address          TEXT NOT NULL,
    total_budget_micro_usdc         BIGINT NOT NULL DEFAULT 0,
    allocated_micro_usdc            BIGINT NOT NULL DEFAULT 0,
    spent_micro_usdc                BIGINT NOT NULL DEFAULT 0,
    -- Transactions above this threshold require explicit approval
    approval_threshold_micro_usdc   BIGINT NOT NULL DEFAULT 1000000,  -- 1 USDC
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS department_budgets (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    treasury_pool_id      UUID NOT NULL REFERENCES treasury_pools(id) ON DELETE CASCADE,
    department_id         UUID NOT NULL REFERENCES tenant_departments(id) ON DELETE CASCADE,
    allocated_micro_usdc  BIGINT NOT NULL DEFAULT 0,
    spent_micro_usdc      BIGINT NOT NULL DEFAULT 0,
    period                TEXT NOT NULL DEFAULT 'monthly',   -- daily | weekly | monthly
    period_start          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (treasury_pool_id, department_id)
);

CREATE TABLE IF NOT EXISTS approval_requests (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    treasury_pool_id    UUID NOT NULL REFERENCES treasury_pools(id),
    tenant_id           UUID NOT NULL REFERENCES tenants(id),
    requester_did       TEXT NOT NULL,
    requester_user_id   UUID REFERENCES users(id),
    amount_micro_usdc   BIGINT NOT NULL,
    recipient_address   TEXT NOT NULL,
    purpose             TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | executed
    reviewer_user_id    UUID REFERENCES users(id),
    reviewer_note       TEXT,
    reviewed_at         TIMESTAMPTZ,
    tx_signature        TEXT,
    executed_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_treasury_pools_tenant     ON treasury_pools(tenant_id);
CREATE INDEX IF NOT EXISTS idx_dept_budgets_pool         ON department_budgets(treasury_pool_id);
CREATE INDEX IF NOT EXISTS idx_approval_tenant           ON approval_requests(tenant_id);
CREATE INDEX IF NOT EXISTS idx_approval_status           ON approval_requests(status);
CREATE INDEX IF NOT EXISTS idx_approval_requester        ON approval_requests(requester_did);

-- ── Settlement Receipt Notifications ─────────────────────────────────────────
-- Stored receipts for tenant-level settlement completion notifications.

CREATE TABLE IF NOT EXISTS settlement_receipts (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    settlement_batch_id         UUID NOT NULL REFERENCES settlement_batches(id),
    tenant_id                   UUID REFERENCES tenants(id),
    service_id                  UUID NOT NULL REFERENCES service_listings(id),
    total_micro_usdc            BIGINT NOT NULL,
    merchant_share_micro_usdc   BIGINT NOT NULL,
    platform_share_micro_usdc   BIGINT NOT NULL,
    rpc_url_used                TEXT,
    notified_at                 TIMESTAMPTZ,
    webhook_delivered           BOOLEAN NOT NULL DEFAULT false,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_settlement_receipts_tenant  ON settlement_receipts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_settlement_receipts_service ON settlement_receipts(service_id);

-- ── updated_at triggers ────────────────────────────────────────────────────────

CREATE TRIGGER set_updated_at_tenants
    BEFORE UPDATE ON tenants
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER set_updated_at_treasury_pools
    BEFORE UPDATE ON treasury_pools
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
