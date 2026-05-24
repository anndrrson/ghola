-- Wallet-only SIWS auth for said-cloud.
-- Additive/backwards-compatible: existing Google/email users unchanged.

ALTER TABLE users ADD COLUMN IF NOT EXISTS siws_pubkey TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_siws_pubkey ON users(siws_pubkey);
