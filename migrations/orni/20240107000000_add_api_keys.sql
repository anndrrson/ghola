-- API Keys for OpenAI-compatible endpoint access
CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    model_id UUID NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    key_hash VARCHAR(64) NOT NULL UNIQUE,
    key_prefix VARCHAR(12) NOT NULL,
    name VARCHAR(128),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX idx_api_keys_key_hash ON api_keys(key_hash);
CREATE INDEX idx_api_keys_model_id ON api_keys(model_id);

-- Model reviews and ratings
CREATE TABLE model_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    model_id UUID NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    rating INT NOT NULL CHECK (rating >= 1 AND rating <= 5),
    review_text TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, model_id)
);

CREATE INDEX idx_model_reviews_model_id ON model_reviews(model_id);

ALTER TABLE models ADD COLUMN IF NOT EXISTS avg_rating DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE models ADD COLUMN IF NOT EXISTS review_count INT NOT NULL DEFAULT 0;

-- Creator slug for public profile pages
ALTER TABLE users ADD COLUMN IF NOT EXISTS slug VARCHAR(64) UNIQUE;
