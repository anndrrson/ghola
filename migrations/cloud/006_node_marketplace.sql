-- Node marketplace enhancements (005 already created base tables)
-- Add columns to node_payments that weren't in the initial migration
ALTER TABLE node_payments ADD COLUMN IF NOT EXISTS payer_id UUID;
ALTER TABLE node_payments ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed';

-- Add avg_latency_ms to inference_nodes
ALTER TABLE inference_nodes ADD COLUMN IF NOT EXISTS avg_latency_ms REAL NOT NULL DEFAULT 0.0;

-- Add reviewer index (005 only created node-level index)
CREATE INDEX IF NOT EXISTS idx_node_reviews_reviewer ON node_reviews(reviewer_id);
