-- Usage metering for pay-as-you-go billing
CREATE TABLE IF NOT EXISTS usage_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    endpoint TEXT NOT NULL DEFAULT 'api',
    count INTEGER NOT NULL DEFAULT 1,
    period_start DATE NOT NULL DEFAULT CURRENT_DATE,
    period_end DATE NOT NULL DEFAULT CURRENT_DATE,
    billed BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_records_user_period ON usage_records(user_id, period_start);
CREATE INDEX IF NOT EXISTS idx_usage_records_unbilled ON usage_records(user_id, billed) WHERE billed = false;

-- Add stripe_customer_id to users if not exists
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
