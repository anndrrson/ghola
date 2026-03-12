CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE business_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    did TEXT NOT NULL UNIQUE,
    business_name TEXT NOT NULL,
    handle TEXT UNIQUE,
    category TEXT NOT NULL DEFAULT 'service',
    description TEXT NOT NULL DEFAULT '',
    logo_url TEXT,
    website TEXT NOT NULL DEFAULT '',
    verified_domain TEXT,
    verified_at TIMESTAMPTZ,
    operating_hours JSONB,
    location JSONB,
    contact JSONB,
    services JSONB NOT NULL DEFAULT '[]',
    policies JSONB NOT NULL DEFAULT '[]',
    api_endpoints JSONB NOT NULL DEFAULT '[]',
    payment_methods JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE domain_verifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID NOT NULL REFERENCES business_profiles(id),
    domain TEXT NOT NULL,
    method TEXT NOT NULL,
    token TEXT NOT NULL,
    verified BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    key_hash TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT 'default',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ
);

CREATE TABLE usage_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID,
    endpoint TEXT NOT NULL,
    client_ip TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_business_profiles_user_id ON business_profiles(user_id);
CREATE INDEX idx_business_profiles_did ON business_profiles(did);
CREATE INDEX idx_business_profiles_handle ON business_profiles(handle);
CREATE INDEX idx_domain_verifications_profile ON domain_verifications(profile_id);
CREATE INDEX idx_usage_logs_profile ON usage_logs(profile_id);
CREATE INDEX idx_usage_logs_created ON usage_logs(created_at);
