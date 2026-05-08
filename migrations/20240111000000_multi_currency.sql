-- Multi-currency stablecoin support: USDT primary, USDC secondary.
-- Existing `users.usdc_balance` is kept as a legacy column (writers stop using
-- it; can be dropped in a follow-up migration once all readers are off it).

-- Native multi-currency balance ledger.
CREATE TABLE IF NOT EXISTS currency_balances (
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    currency   VARCHAR(10) NOT NULL,
    balance    BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, currency)
);

CREATE INDEX IF NOT EXISTS idx_currency_balances_user ON currency_balances(user_id);

-- Tag every payment-touching row with which stablecoin moved. Default 'USDC'
-- preserves the meaning of pre-migration rows (everything was USDC).
ALTER TABLE deposits         ADD COLUMN IF NOT EXISTS currency VARCHAR(10) NOT NULL DEFAULT 'USDC';
ALTER TABLE payments         ADD COLUMN IF NOT EXISTS currency VARCHAR(10) NOT NULL DEFAULT 'USDC';

-- One-shot backfill: copy existing `users.usdc_balance` into currency_balances.
-- Idempotent via ON CONFLICT — safe to re-run.
INSERT INTO currency_balances (user_id, currency, balance)
SELECT id, 'USDC', usdc_balance FROM users WHERE usdc_balance > 0
ON CONFLICT (user_id, currency) DO NOTHING;
