-- Foundation model catalog metadata: HF-grade fields surfaced natively on Ghola.

ALTER TABLE models ADD COLUMN IF NOT EXISTS params_b DOUBLE PRECISION;
ALTER TABLE models ADD COLUMN IF NOT EXISTS active_params_b DOUBLE PRECISION;
ALTER TABLE models ADD COLUMN IF NOT EXISTS license TEXT;
ALTER TABLE models ADD COLUMN IF NOT EXISTS license_url TEXT;
ALTER TABLE models ADD COLUMN IF NOT EXISTS developer TEXT;
ALTER TABLE models ADD COLUMN IF NOT EXISTS architecture TEXT;
ALTER TABLE models ADD COLUMN IF NOT EXISTS context_window INTEGER;
ALTER TABLE models ADD COLUMN IF NOT EXISTS modality TEXT[] NOT NULL DEFAULT ARRAY['text']::TEXT[];
ALTER TABLE models ADD COLUMN IF NOT EXISTS hf_id TEXT;
ALTER TABLE models ADD COLUMN IF NOT EXISTS release_date DATE;
ALTER TABLE models ADD COLUMN IF NOT EXISTS is_foundation BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE models ADD COLUMN IF NOT EXISTS gguf_available BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE models ADD COLUMN IF NOT EXISTS recommended_vram_gb INTEGER;

CREATE INDEX IF NOT EXISTS idx_models_is_foundation ON models(is_foundation) WHERE is_foundation = TRUE;
CREATE INDEX IF NOT EXISTS idx_models_developer ON models(developer);
CREATE INDEX IF NOT EXISTS idx_models_license ON models(license);
