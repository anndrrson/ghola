-- Phase 15-16: Sub-agent wallets + encrypted credential sharing

-- Sub-agent wallet extensions
ALTER TABLE agent_wallets ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES agent_wallets(id);
ALTER TABLE agent_wallets ADD COLUMN IF NOT EXISTS delegation_token TEXT;
ALTER TABLE agent_wallets ADD COLUMN IF NOT EXISTS capabilities TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_agent_wallets_parent ON agent_wallets(parent_id);

-- Encrypted credential sharing between agents
CREATE TABLE IF NOT EXISTS shared_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_did TEXT NOT NULL,
    recipient_did TEXT NOT NULL,
    encrypted_payload TEXT NOT NULL,
    capability_required TEXT NOT NULL DEFAULT 'said/read_secrets',
    label TEXT NOT NULL DEFAULT '',
    expires_at TIMESTAMPTZ NOT NULL,
    accessed_count INTEGER NOT NULL DEFAULT 0,
    max_accesses INTEGER,
    revoked BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shared_creds_owner ON shared_credentials(owner_did);
CREATE INDEX IF NOT EXISTS idx_shared_creds_recipient ON shared_credentials(recipient_did);
