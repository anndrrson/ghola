-- Waitlist signups for catalog-only models (no provider backend yet).

CREATE TABLE IF NOT EXISTS model_interest (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_id UUID NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    email TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (user_id IS NOT NULL OR email IS NOT NULL)
);

-- Idempotency: one row per (model, user) and one per (model, email).
CREATE UNIQUE INDEX IF NOT EXISTS idx_model_interest_user
    ON model_interest(model_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_model_interest_email
    ON model_interest(model_id, email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_model_interest_model ON model_interest(model_id);
