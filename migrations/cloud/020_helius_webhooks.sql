-- Helius enhanced-webhook integration. Extends payment_transactions with the
-- richer metadata Helius gives us for free (parsed type, source program,
-- human-readable description) so the activity feed can render context like
-- "Alpha received 0.42 USDC from SWAP via Jupiter" without a second lookup.
--
-- All columns are nullable so the legacy POST /v1/pay/sync path (which
-- doesn't have access to Helius parsing) keeps working with NULLs.

ALTER TABLE payment_transactions
    ADD COLUMN IF NOT EXISTS helius_type TEXT,
    ADD COLUMN IF NOT EXISTS helius_source TEXT,
    ADD COLUMN IF NOT EXISTS description TEXT,
    ADD COLUMN IF NOT EXISTS slot BIGINT,
    ADD COLUMN IF NOT EXISTS block_time TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_payment_transactions_block_time
    ON payment_transactions(block_time DESC NULLS LAST);
