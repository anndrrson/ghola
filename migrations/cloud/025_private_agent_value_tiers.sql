-- Lower-friction private-agent monetization tiers.
ALTER TABLE users ADD COLUMN IF NOT EXISTS tier_expires_at TIMESTAMPTZ;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_tier_check;
ALTER TABLE users ADD CONSTRAINT users_tier_check
    CHECK (tier IN ('free', 'pro', 'trial_pack', 'starter', 'private_agent', 'unlimited', 'enterprise'));
