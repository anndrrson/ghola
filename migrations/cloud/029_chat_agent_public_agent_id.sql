ALTER TABLE chat_agents
    ADD COLUMN IF NOT EXISTS public_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_chat_agents_public_agent
    ON chat_agents(user_id, public_agent_id)
    WHERE public_agent_id IS NOT NULL;

-- Best-effort backfill for pre-link private-agent canaries: the mobile flow
-- inserts the encrypted config immediately after creating the public agent.
WITH candidates AS (
    SELECT
        ca.id AS chat_agent_id,
        a.id AS public_agent_id,
        COUNT(*) OVER (PARTITION BY ca.id) AS match_count
    FROM chat_agents ca
    JOIN agents a
      ON a.user_id = ca.user_id
     AND abs(extract(epoch FROM (ca.created_at - a.created_at))) <= 120
    WHERE ca.public_agent_id IS NULL
)
UPDATE chat_agents ca
SET public_agent_id = candidates.public_agent_id
FROM candidates
WHERE ca.id = candidates.chat_agent_id
  AND candidates.match_count = 1;
