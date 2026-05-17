-- Private USDCx settlement intents.
-- Store the minimum server-side metadata required to match an approved
-- user intent with a signed Aleo verifier receipt. Raw shielded recipients
-- stay off this table.
CREATE TABLE IF NOT EXISTS private_wallet_transfers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rail TEXT NOT NULL DEFAULT 'aleo_usdcx_shielded',
    provider TEXT NOT NULL DEFAULT 'aleo',
    network TEXT NOT NULL DEFAULT 'aleo:mainnet',
    asset TEXT NOT NULL DEFAULT 'USDCx',
    amount_micro_usdc BIGINT NOT NULL CHECK (amount_micro_usdc > 0),
    recipient_hash TEXT NOT NULL,
    recipient_preview TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'intent_pending'
        CHECK (status IN ('intent_pending', 'submitted', 'verified', 'failed', 'expired')),
    privacy_mode TEXT,
    network_scope TEXT,
    user_approved_at TIMESTAMPTZ,
    approval_nonce TEXT,
    approval_summary TEXT,
    proof_digest TEXT,
    adapter_receipt_ref TEXT UNIQUE,
    created_at TIMESTAMPTZ DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    verified_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_private_wallet_transfers_user
    ON private_wallet_transfers(user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_private_wallet_transfers_user_approval_nonce
    ON private_wallet_transfers(user_id, approval_nonce) WHERE approval_nonce IS NOT NULL;
