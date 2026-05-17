-- Private Balance top-ups.
-- Stripe settles the consumer-facing payment; this ledger records the funded
-- amount and whether it has been routed into the shielded stablecoin rail.
CREATE TABLE IF NOT EXISTS private_balance_deposits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount_usdc BIGINT NOT NULL CHECK (amount_usdc > 0),
    status TEXT NOT NULL DEFAULT 'checkout_pending'
        CHECK (status IN ('checkout_pending', 'paid', 'shield_pending', 'shielded', 'failed', 'refunded')),
    source TEXT NOT NULL DEFAULT 'stripe_checkout',
    stripe_session_id TEXT UNIQUE,
    stripe_payment_intent_id TEXT,
    stripe_customer_id TEXT,
    checkout_url TEXT,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now(),
    paid_at TIMESTAMPTZ,
    shielded_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_private_balance_deposits_user
    ON private_balance_deposits(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_private_balance_deposits_status
    ON private_balance_deposits(status);
