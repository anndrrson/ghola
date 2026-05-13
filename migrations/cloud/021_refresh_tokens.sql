-- Refresh-token rotation (OAuth2-style, single-use).
--
-- The client gets a long-lived refresh token at sign-in. When the short-lived
-- access JWT expires, the client POSTs the refresh token to /v1/auth/refresh
-- and gets back a NEW access token AND a NEW refresh token. The old refresh
-- row is marked revoked and linked forward via `rotated_to_hash`, which makes
-- refresh-token theft detectable: if the same token is replayed after rotation
-- the new chain can be revoked.
--
-- Mirrors the equivalent table embedded in thumper-cloud's db.rs schema. The
-- two backends share the same access-token TTL (30 days) and the same refresh
-- TTL (180 days), so a Seeker / Solflare user can sign in once and stay signed
-- in across both surfaces without an interactive SIWS prompt.

CREATE TABLE IF NOT EXISTS refresh_tokens (
    token_hash       TEXT PRIMARY KEY,                     -- SHA-256(refresh_token)
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    issued_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at       TIMESTAMPTZ NOT NULL,
    revoked_at       TIMESTAMPTZ,
    rotated_to_hash  TEXT
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user
    ON refresh_tokens(user_id) WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires
    ON refresh_tokens(expires_at);
