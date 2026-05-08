-- Expanded usage tracking
ALTER TABLE usage_logs ADD COLUMN user_agent TEXT;
ALTER TABLE usage_logs ADD COLUMN response_status INTEGER;
ALTER TABLE usage_logs ADD COLUMN did_resolved TEXT;

-- Agent interaction logs
CREATE TABLE agent_interactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID NOT NULL REFERENCES business_profiles(id),
    agent_identifier TEXT,
    tool_used TEXT,
    service_name TEXT,
    query_text TEXT,
    response_status TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_interactions_profile ON agent_interactions(profile_id);
CREATE INDEX idx_agent_interactions_created ON agent_interactions(created_at);

-- Discovery funnel tracking
CREATE TABLE discovery_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID REFERENCES business_profiles(id),
    event_type TEXT NOT NULL,  -- 'agents_txt_fetched', 'well_known_fetched', 'profile_resolved', 'service_called'
    source_domain TEXT,
    agent_identifier TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_discovery_events_profile ON discovery_events(profile_id);
CREATE INDEX idx_discovery_events_type ON discovery_events(event_type);
CREATE INDEX idx_discovery_events_created ON discovery_events(created_at);
