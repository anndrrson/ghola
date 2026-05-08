-- Marketplace features: featured models, free tier

ALTER TABLE models ADD COLUMN IF NOT EXISTS is_featured BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE models ADD COLUMN IF NOT EXISTS is_platform_model BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE models ADD COLUMN IF NOT EXISTS free_queries_per_day INT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS free_query_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    model_id UUID NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    query_date DATE NOT NULL DEFAULT CURRENT_DATE,
    query_count INT NOT NULL DEFAULT 1,
    UNIQUE(user_id, model_id, query_date)
);

CREATE INDEX IF NOT EXISTS idx_free_query_usage_lookup ON free_query_usage(user_id, model_id, query_date);
CREATE INDEX IF NOT EXISTS idx_models_featured ON models(is_featured) WHERE is_featured = TRUE;
