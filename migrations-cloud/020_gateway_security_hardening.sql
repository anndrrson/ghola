-- Phase G2: gateway security hardening.
--
-- 1) Deduplicate paid x402 signatures in a race-safe way.
-- 2) Preserve auditability for consumed signatures by service and time.

CREATE TABLE IF NOT EXISTS gateway_consumed_payments (
    signature TEXT PRIMARY KEY,
    service_listing_id UUID NOT NULL REFERENCES service_listings(id) ON DELETE CASCADE,
    consumed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gateway_consumed_payments_service_created
    ON gateway_consumed_payments(service_listing_id, consumed_at DESC);
