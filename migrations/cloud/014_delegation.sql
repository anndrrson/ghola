-- Phase 14: Programmable UCAN Delegation
-- Revocation registry + delegation grant tracking

CREATE TABLE IF NOT EXISTS ucan_revocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issuer_did TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    reason TEXT,
    revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ucan_revocations_hash ON ucan_revocations(token_hash);
CREATE INDEX IF NOT EXISTS idx_ucan_revocations_issuer ON ucan_revocations(issuer_did);

CREATE TABLE IF NOT EXISTS delegation_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issuer_did TEXT NOT NULL,
    audience_did TEXT NOT NULL,
    capabilities TEXT[] NOT NULL,
    token_hash TEXT NOT NULL,
    parent_token_hash TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_delegation_grants_issuer ON delegation_grants(issuer_did);
CREATE INDEX IF NOT EXISTS idx_delegation_grants_audience ON delegation_grants(audience_did);
CREATE INDEX IF NOT EXISTS idx_delegation_grants_token ON delegation_grants(token_hash);
