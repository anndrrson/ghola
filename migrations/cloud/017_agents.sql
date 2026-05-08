-- Phase 2: Multi-agent ownership
-- Adds the `agents` table so a single user can own multiple cryptographically-distinct
-- AI agents, each with its own DID, wallet, services, and reputation.
--
-- Existing rows in service_listings, agent_wallets, and reputation_scores remain
-- valid: the new agent_id columns are nullable, so legacy user-level data is
-- untouched.

CREATE TABLE IF NOT EXISTS agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Display
    slug TEXT NOT NULL,
    display_name TEXT NOT NULL,
    bio TEXT,
    avatar_url TEXT,

    -- Cryptographic identity
    did TEXT NOT NULL UNIQUE,                    -- did:key:z... (multicodec ed25519-pub)
    master_pubkey BYTEA NOT NULL,                -- 32-byte ed25519 public key
    solana_address TEXT NOT NULL,                -- base58 of master_pubkey

    -- Linked dedicated wallet (created at agent-create time)
    wallet_id UUID REFERENCES agent_wallets(id) ON DELETE SET NULL,

    -- Optional on-chain registration (deferred from v1, populated by future
    -- Solana program register instruction; NULL means off-chain only)
    onchain_identity_pda TEXT,

    -- Lifecycle
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'archived')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(user_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_agents_user_id ON agents(user_id);
CREATE INDEX IF NOT EXISTS idx_agents_did ON agents(did);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);

-- Add nullable agent_id FKs to existing tables so per-agent scoping works
-- without breaking legacy user-level rows.
ALTER TABLE service_listings
    ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agents(id) ON DELETE CASCADE;

ALTER TABLE reputation_scores
    ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agents(id) ON DELETE CASCADE;

ALTER TABLE agent_wallets
    ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_service_listings_agent_id ON service_listings(agent_id);
CREATE INDEX IF NOT EXISTS idx_reputation_scores_agent_id ON reputation_scores(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_wallets_agent_id ON agent_wallets(agent_id);

-- Auto-update updated_at trigger
CREATE TRIGGER set_agents_updated_at
    BEFORE UPDATE ON agents
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
