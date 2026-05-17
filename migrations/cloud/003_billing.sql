-- Subscription plans
CREATE TYPE subscription_tier AS ENUM ('free', 'consumer_pro', 'business', 'enterprise');

ALTER TABLE users ADD COLUMN subscription_tier subscription_tier NOT NULL DEFAULT 'free';
ALTER TABLE users ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE users ADD COLUMN subscription_expires_at TIMESTAMPTZ;

-- API keys for resolve endpoint (agent developers)
ALTER TABLE api_keys ADD COLUMN tier subscription_tier NOT NULL DEFAULT 'free';
ALTER TABLE api_keys ADD COLUMN daily_limit INTEGER NOT NULL DEFAULT 1000;
ALTER TABLE api_keys ADD COLUMN requests_today INTEGER NOT NULL DEFAULT 0;
ALTER TABLE api_keys ADD COLUMN requests_reset_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Verified business badges
CREATE TABLE verified_badges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID NOT NULL REFERENCES business_profiles(id),
    verified_by TEXT NOT NULL DEFAULT 'manual',
    attestation_tx TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '1 year')
);

CREATE INDEX idx_verified_badges_profile ON verified_badges(profile_id);
