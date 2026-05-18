-- Pilot-ready institutional controls for private USDCx settlement.
-- These are additive so existing private transfer intents survive deploys.

ALTER TABLE private_wallet_transfers ADD COLUMN IF NOT EXISTS signing_mode TEXT;
ALTER TABLE private_wallet_transfers ADD COLUMN IF NOT EXISTS signer_key_id TEXT;
ALTER TABLE private_wallet_transfers ADD COLUMN IF NOT EXISTS signer_attestation_hash TEXT;
ALTER TABLE private_wallet_transfers ADD COLUMN IF NOT EXISTS policy_hash TEXT;
ALTER TABLE private_wallet_transfers ADD COLUMN IF NOT EXISTS selective_disclosure_receipt_hash TEXT;
ALTER TABLE private_wallet_transfers ADD COLUMN IF NOT EXISTS institutional_readiness_version TEXT;

CREATE TABLE IF NOT EXISTS private_wallet_transfer_audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    transfer_id UUID NOT NULL REFERENCES private_wallet_transfers(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    policy_hash TEXT,
    receipt_hash TEXT,
    recipient_preview TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_private_wallet_transfer_audit_events_transfer
    ON private_wallet_transfer_audit_events(transfer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_private_wallet_transfer_audit_events_user
    ON private_wallet_transfer_audit_events(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS private_wallet_receipt_exports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    transfer_id UUID NOT NULL REFERENCES private_wallet_transfers(id) ON DELETE CASCADE,
    receipt_hash TEXT NOT NULL,
    export_reason TEXT,
    export_audience TEXT,
    approval_nonce TEXT,
    approval_summary TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_private_wallet_receipt_exports_transfer
    ON private_wallet_receipt_exports(transfer_id, created_at DESC);
