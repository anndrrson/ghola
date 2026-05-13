-- Phase v0.4.0: wallet-only SIWS auth for thumper-cloud.
-- Additive/backwards-compatible: existing Google/Apple/email users unchanged.

ALTER TABLE users ADD COLUMN IF NOT EXISTS siws_pubkey TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_siws_pubkey ON users(siws_pubkey);
