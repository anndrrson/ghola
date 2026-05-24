-- Backend privacy hardening pass.
--
-- Existing approval_nonce columns are retained for compatibility, but new
-- writes store SHA-256 approval nonce hashes.

DO $$
BEGIN
    IF to_regclass('public.sms_actions') IS NOT NULL THEN
        ALTER TABLE sms_actions ADD COLUMN IF NOT EXISTS privacy_mode TEXT;
        ALTER TABLE sms_actions ADD COLUMN IF NOT EXISTS network_scope TEXT;
        ALTER TABLE sms_actions ADD COLUMN IF NOT EXISTS user_approved_at TIMESTAMPTZ;
        ALTER TABLE sms_actions ADD COLUMN IF NOT EXISTS approval_nonce TEXT;
        ALTER TABLE sms_actions ADD COLUMN IF NOT EXISTS approval_summary TEXT;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_actions_user_approval_nonce
            ON sms_actions(user_id, approval_nonce) WHERE approval_nonce IS NOT NULL;
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.wallet_transactions') IS NOT NULL THEN
        ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS to_address_hash TEXT;
        ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS to_address_preview TEXT;
        CREATE INDEX IF NOT EXISTS idx_wallet_txns_user_to_address_hash
            ON wallet_transactions(user_id, to_address_hash, currency, amount, created_at DESC)
            WHERE to_address_hash IS NOT NULL;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS native_message_blocks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender_did_hash TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, sender_did_hash)
);
CREATE INDEX IF NOT EXISTS idx_native_message_blocks_user
    ON native_message_blocks(user_id, created_at);

DO $$
BEGIN
    IF to_regclass('public.native_message_envelopes') IS NOT NULL THEN
        CREATE TABLE IF NOT EXISTS native_message_abuse_reports (
            id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            message_id          UUID REFERENCES native_message_envelopes(id) ON DELETE SET NULL,
            sender_did_hash     TEXT,
            reason              TEXT,
            ciphertext_metadata JSONB NOT NULL DEFAULT '{}',
            created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    ELSE
        CREATE TABLE IF NOT EXISTS native_message_abuse_reports (
            id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            message_id          UUID,
            sender_did_hash     TEXT,
            reason              TEXT,
            ciphertext_metadata JSONB NOT NULL DEFAULT '{}',
            created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_native_message_abuse_reports_user
    ON native_message_abuse_reports(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_native_message_abuse_reports_sender_hash
    ON native_message_abuse_reports(sender_did_hash, created_at)
    WHERE sender_did_hash IS NOT NULL;
