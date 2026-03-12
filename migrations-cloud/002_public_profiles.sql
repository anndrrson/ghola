-- Add account_type to users
ALTER TABLE users ADD COLUMN account_type TEXT NOT NULL DEFAULT 'business';

-- Consumer public profiles
CREATE TABLE public_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    did TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    handle TEXT UNIQUE,
    avatar_url TEXT,
    bio TEXT,
    timezone TEXT,
    agent_preferences JSONB NOT NULL DEFAULT '{}',
    encrypted_wallet BYTEA,
    on_chain_registered BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_public_profiles_user_id ON public_profiles(user_id);
CREATE INDEX idx_public_profiles_did ON public_profiles(did);
CREATE INDEX idx_public_profiles_handle ON public_profiles(handle);
