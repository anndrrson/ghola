-- Phase G1: Merchant Gateway — zero-implementation headless merchant onboarding.
--
-- A merchant pastes an API URL, auth credential, and a price. Ghola provisions a
-- vault-backed sub-org with a Solana wallet, encrypts their upstream credential,
-- and stands up a proxy route at gateway.ghola.xyz/m/{slug}/*. Agent callers pay
-- via x402 on the inbound leg; Ghola injects the merchant's credential into the
-- outbound leg; metered_usage is written on success only. The merchant writes
-- zero lines of code.
--
-- This migration is additive only. It reuses service_listings as the "what is
-- being sold" table (pricing, slug, name, endpoints) and layers proxy-mode
-- metadata on top. Legacy non-proxy services (proxy_enabled=false) continue
-- to work exactly as before.

-- ─── service_listings: proxy-mode columns ──────────────────────────────────

ALTER TABLE service_listings
    ADD COLUMN IF NOT EXISTS proxy_enabled BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS proxy_origin_url TEXT,                      -- where the gateway forwards to
    ADD COLUMN IF NOT EXISTS proxy_auth_mode TEXT,                       -- bearer | api_key_header | api_key_query | basic | none
    ADD COLUMN IF NOT EXISTS proxy_auth_header_name TEXT,                -- for api_key_header (e.g. 'x-api-key'); NULL for bearer (=> Authorization)
    ADD COLUMN IF NOT EXISTS merchant_credential_id UUID,                -- FK to merchant_credentials, set after encryption
    ADD COLUMN IF NOT EXISTS vault_suborg_id TEXT,                       -- Turnkey/LocalVault sub-org identifier
    ADD COLUMN IF NOT EXISTS vault_wallet_address TEXT,                  -- Solana address where USDC lands
    ADD COLUMN IF NOT EXISTS circuit_breaker_open BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS circuit_breaker_until TIMESTAMPTZ;          -- when circuit re-closes (NULL if closed)

CREATE INDEX IF NOT EXISTS idx_service_listings_proxy_enabled
    ON service_listings(proxy_enabled) WHERE proxy_enabled = true;

-- ─── merchant_credentials: encrypted upstream auth material ────────────────
--
-- Envelope-encrypted blob. LocalVault uses AES-256-GCM with a Ghola-held KEK
-- (dev / Round-1 prod). TurnkeyVault wraps a data-encryption-key with a
-- KEK that lives inside Turnkey's HSM boundary — a Ghola DB dump is useless
-- without the vault. Both implementations share this schema.

CREATE TABLE IF NOT EXISTS merchant_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_listing_id UUID NOT NULL REFERENCES service_listings(id) ON DELETE CASCADE,
    auth_mode TEXT NOT NULL,              -- matches proxy_auth_mode
    header_name TEXT,                     -- snapshot of header_name at creation time
    ciphertext BYTEA NOT NULL,            -- nonce(12) || ciphertext || tag(16)
    key_version INTEGER NOT NULL DEFAULT 1,
    vault_backend TEXT NOT NULL DEFAULT 'local',  -- 'local' | 'turnkey'
    vault_key_ref TEXT,                   -- opaque vault-side reference (e.g. wrapped-DEK handle)
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    rotated_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_merchant_credentials_listing
    ON merchant_credentials(service_listing_id);

-- Wire the FK back so SELECTs can join cleanly
DO $$ BEGIN
    ALTER TABLE service_listings
        ADD CONSTRAINT fk_service_merchant_credential
        FOREIGN KEY (merchant_credential_id)
        REFERENCES merchant_credentials(id)
        ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── gateway_call_logs: append-only per-request ledger ────────────────────
--
-- One row per proxied call. Powers the merchant dashboard's live log tail and
-- earnings charts. Intentionally narrow — no bodies, no headers beyond what's
-- needed to debug and bill. Rotate via a cron later if the table gets hot.

CREATE TABLE IF NOT EXISTS gateway_call_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_listing_id UUID NOT NULL REFERENCES service_listings(id) ON DELETE CASCADE,
    caller_agent_did TEXT,                       -- NULL if unauthenticated probe
    caller_user_id UUID,                         -- NULL if anonymous
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    upstream_status INTEGER,                     -- NULL if the gateway never reached upstream
    gateway_status INTEGER NOT NULL,             -- what the caller ultimately saw
    latency_ms INTEGER NOT NULL,
    bytes_in BIGINT NOT NULL DEFAULT 0,
    bytes_out BIGINT NOT NULL DEFAULT 0,
    amount_charged_micro_usdc BIGINT NOT NULL DEFAULT 0,
    payment_status TEXT NOT NULL DEFAULT 'none', -- none | paid | refunded | failed
    x402_tx_signature TEXT,
    error_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gateway_logs_listing
    ON gateway_call_logs(service_listing_id);
CREATE INDEX IF NOT EXISTS idx_gateway_logs_created
    ON gateway_call_logs(service_listing_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gateway_logs_caller
    ON gateway_call_logs(caller_agent_did) WHERE caller_agent_did IS NOT NULL;
