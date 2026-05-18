-- Strict local privacy enforcement metadata.
-- External execution requests must carry these fields and the backend stores
-- them on the action row for audit/debugging without exposing approval_nonce.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS privacy_mode TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS network_scope TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS user_approved_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS approval_nonce TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS approval_summary TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_user_approval_nonce
    ON tasks(user_id, approval_nonce) WHERE approval_nonce IS NOT NULL;

ALTER TABLE email_actions ADD COLUMN IF NOT EXISTS privacy_mode TEXT;
ALTER TABLE email_actions ADD COLUMN IF NOT EXISTS network_scope TEXT;
ALTER TABLE email_actions ADD COLUMN IF NOT EXISTS user_approved_at TIMESTAMPTZ;
ALTER TABLE email_actions ADD COLUMN IF NOT EXISTS approval_nonce TEXT;
ALTER TABLE email_actions ADD COLUMN IF NOT EXISTS approval_summary TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_actions_user_approval_nonce
    ON email_actions(user_id, approval_nonce) WHERE approval_nonce IS NOT NULL;

ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS privacy_mode TEXT;
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS network_scope TEXT;
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS user_approved_at TIMESTAMPTZ;
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS approval_nonce TEXT;
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS approval_summary TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_txns_user_approval_nonce
    ON wallet_transactions(user_id, approval_nonce) WHERE approval_nonce IS NOT NULL;
