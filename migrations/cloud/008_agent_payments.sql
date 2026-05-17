-- Agent payment infrastructure tables

CREATE TABLE IF NOT EXISTS agent_wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    hd_index INTEGER NOT NULL,
    solana_address TEXT NOT NULL,
    spending_policy JSONB NOT NULL DEFAULT '{}',
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, label),
    UNIQUE(user_id, hd_index)
);

CREATE INDEX idx_agent_wallets_user_id ON agent_wallets(user_id);
CREATE INDEX idx_agent_wallets_solana_address ON agent_wallets(solana_address);

CREATE TABLE IF NOT EXISTS payment_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_wallet_id UUID NOT NULL REFERENCES agent_wallets(id) ON DELETE CASCADE,
    agent_label TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('send', 'receive')),
    currency TEXT NOT NULL CHECK (currency IN ('sol', 'usdc')),
    amount BIGINT NOT NULL,
    recipient TEXT NOT NULL,
    sender TEXT NOT NULL,
    signature TEXT NOT NULL UNIQUE,
    memo TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_payment_transactions_user_id ON payment_transactions(user_id);
CREATE INDEX idx_payment_transactions_agent_wallet_id ON payment_transactions(agent_wallet_id);
CREATE INDEX idx_payment_transactions_created_at ON payment_transactions(created_at DESC);
CREATE INDEX idx_payment_transactions_signature ON payment_transactions(signature);

CREATE TABLE IF NOT EXISTS merchant_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    did TEXT NOT NULL,
    receive_address TEXT NOT NULL,
    accepted_currencies JSONB NOT NULL DEFAULT '["usdc"]',
    webhook_url TEXT,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id),
    UNIQUE(did)
);

CREATE INDEX idx_merchant_configs_did ON merchant_configs(did);

-- Auto-update updated_at trigger
CREATE TRIGGER set_agent_wallets_updated_at
    BEFORE UPDATE ON agent_wallets
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER set_merchant_configs_updated_at
    BEFORE UPDATE ON merchant_configs
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
