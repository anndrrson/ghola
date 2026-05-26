CREATE TABLE IF NOT EXISTS treasury_intents (
    intent_id TEXT PRIMARY KEY,
    owner_did TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('simulated', 'submitted', 'settled', 'cancelled', 'failed')),
    policy_hash TEXT NOT NULL,
    intent_hash TEXT NOT NULL DEFAULT '',
    proposal_hash TEXT NOT NULL,
    proposal JSONB NOT NULL,
    approval JSONB,
    receipt JSONB,
    partner_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    partner_submissions JSONB NOT NULL DEFAULT '[]'::jsonb,
    partner_reconciliations JSONB NOT NULL DEFAULT '[]'::jsonb,
    blocking_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_treasury_intents_owner_updated
    ON treasury_intents (owner_did, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_treasury_intents_proposal_hash
    ON treasury_intents (proposal_hash);
