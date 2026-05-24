-- End-to-end privacymax hardening.
--
-- Existing raw columns are retained for compatibility with older code, but
-- new writes store hash/preview columns and redact raw values after provider
-- handoff wherever the provider no longer needs them.

DO $$
BEGIN
    IF to_regclass('public.calls') IS NOT NULL THEN
        ALTER TABLE calls ADD COLUMN IF NOT EXISTS phone_number_hash TEXT;
        ALTER TABLE calls ADD COLUMN IF NOT EXISTS phone_number_preview TEXT;
        ALTER TABLE calls ADD COLUMN IF NOT EXISTS privacy_mode TEXT;
        ALTER TABLE calls ADD COLUMN IF NOT EXISTS network_scope TEXT;
        ALTER TABLE calls ADD COLUMN IF NOT EXISTS user_approved_at TIMESTAMPTZ;
        ALTER TABLE calls ADD COLUMN IF NOT EXISTS approval_nonce TEXT;
        ALTER TABLE calls ADD COLUMN IF NOT EXISTS approval_summary TEXT;
        CREATE INDEX IF NOT EXISTS idx_calls_user_phone_hash
            ON calls(user_id, phone_number_hash, created_at DESC)
            WHERE phone_number_hash IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_user_approval_nonce
            ON calls(user_id, approval_nonce) WHERE approval_nonce IS NOT NULL;
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.sms_actions') IS NOT NULL THEN
        ALTER TABLE sms_actions ADD COLUMN IF NOT EXISTS to_number_hash TEXT;
        ALTER TABLE sms_actions ADD COLUMN IF NOT EXISTS to_number_preview TEXT;
        CREATE INDEX IF NOT EXISTS idx_sms_actions_user_to_hash
            ON sms_actions(user_id, to_number_hash, created_at DESC)
            WHERE to_number_hash IS NOT NULL;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS privacy_audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_kind TEXT NOT NULL,
    privacy_mode TEXT NOT NULL,
    network_scope TEXT NOT NULL,
    approval_nonce_hash TEXT NOT NULL,
    approval_summary TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_privacy_audit_events_user
    ON privacy_audit_events(user_id, created_at DESC);
