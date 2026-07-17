-- Hybrid private-agent billing: subscription floor plus metered filled notional.
-- Events are immutable and globally idempotent. Period rows serialize concurrent
-- fills and retain sub-cent fee precision until a whole cent can be invoiced.

ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;

CREATE TABLE IF NOT EXISTS private_agent_trading_usage_periods (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    period_start DATE NOT NULL,
    tier TEXT NOT NULL,
    included_notional_micro_usd BIGINT NOT NULL CHECK (included_notional_micro_usd >= 0),
    overage_fee_bps INTEGER NOT NULL CHECK (overage_fee_bps >= 0),
    filled_notional_micro_usd BIGINT NOT NULL DEFAULT 0 CHECK (filled_notional_micro_usd >= 0),
    accrued_fee_micro_usd BIGINT NOT NULL DEFAULT 0 CHECK (accrued_fee_micro_usd >= 0),
    queued_fee_cents BIGINT NOT NULL DEFAULT 0 CHECK (queued_fee_cents >= 0),
    invoiced_fee_cents BIGINT NOT NULL DEFAULT 0 CHECK (invoiced_fee_cents >= 0),
    active_stripe_invoice_item_id TEXT,
    active_stripe_invoice_item_base_cents BIGINT NOT NULL DEFAULT 0 CHECK (active_stripe_invoice_item_base_cents >= 0),
    monthly_fee_cap_micro_usd BIGINT NOT NULL CHECK (monthly_fee_cap_micro_usd >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, period_start)
);

CREATE TABLE IF NOT EXISTS private_agent_trading_usage_events (
    event_id TEXT NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    period_start DATE NOT NULL,
    work_order_commitment TEXT NOT NULL,
    connector_result_commitment TEXT NOT NULL,
    platform_class TEXT NOT NULL,
    fill_count INTEGER NOT NULL CHECK (fill_count > 0),
    filled_notional_micro_usd BIGINT NOT NULL CHECK (filled_notional_micro_usd > 0),
    incremental_fee_micro_usd BIGINT NOT NULL CHECK (incremental_fee_micro_usd >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, event_id),
    UNIQUE (user_id, connector_result_commitment)
);

CREATE INDEX IF NOT EXISTS idx_private_agent_trading_usage_events_user_period
    ON private_agent_trading_usage_events(user_id, period_start, created_at DESC);

CREATE TABLE IF NOT EXISTS private_agent_trading_invoice_outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    period_start DATE NOT NULL,
    amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
    target_queued_fee_cents BIGINT NOT NULL CHECK (target_queued_fee_cents > 0),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'succeeded', 'failed')),
    stripe_invoice_item_id TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, period_start, target_queued_fee_cents)
);

CREATE INDEX IF NOT EXISTS idx_private_agent_trading_invoice_outbox_pending
    ON private_agent_trading_invoice_outbox(status, created_at);
