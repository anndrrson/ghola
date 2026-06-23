-- Metered private-agent compute for confidential workers.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_tier_check;
ALTER TABLE users ADD CONSTRAINT users_tier_check
    CHECK (tier IN ('free', 'pro', 'private_agent', 'unlimited', 'enterprise'));

CREATE TABLE IF NOT EXISTS private_agent_compute_reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL UNIQUE,
    seconds BIGINT NOT NULL CHECK (seconds > 0),
    reason TEXT NOT NULL DEFAULT 'private_agent_session'
        CHECK (reason IN ('private_agent_session', 'live_trade_submit')),
    status TEXT NOT NULL DEFAULT 'reserved'
        CHECK (status IN ('reserved', 'completed', 'paused', 'failed')),
    period_start DATE NOT NULL DEFAULT date_trunc('month', now())::date,
    created_at TIMESTAMPTZ DEFAULT now(),
    released_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_private_agent_compute_reservations_user_period
    ON private_agent_compute_reservations(user_id, period_start);

CREATE INDEX IF NOT EXISTS idx_private_agent_compute_reservations_status
    ON private_agent_compute_reservations(status, reason);
