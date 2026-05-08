CREATE TABLE IF NOT EXISTS chat_agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    encrypted_config TEXT NOT NULL,
    display_order INTEGER NOT NULL DEFAULT 0,
    last_message_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_chat_agents_user ON chat_agents(user_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS chat_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL,
    encrypted_messages TEXT NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    snapshot_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_chat_snapshots_user ON chat_snapshots(user_id, agent_id);

CREATE TRIGGER set_chat_agents_updated_at
    BEFORE UPDATE ON chat_agents FOR EACH ROW EXECUTE FUNCTION set_updated_at();
