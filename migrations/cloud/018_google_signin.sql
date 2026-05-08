-- Phase M1: Google Sign-In support for said-cloud
--
-- Allows the mobile app (Android/Seeker) to authenticate against said-cloud
-- using the same Google ID token it already uses for thumper-cloud, without
-- requiring a password. This is purely additive — existing email+password
-- accounts continue to work unchanged.

-- google_id is the Google subject ("sub") claim, unique per Google account.
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT UNIQUE;

-- Optional display name from Google profile (used for greetings, audit logs).
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;

-- Google sign-in users have no password. Make password_hash nullable so we
-- don't have to insert a sentinel value.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);
