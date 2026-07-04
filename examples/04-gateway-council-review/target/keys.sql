-- Per-user BYO LLM provider keys for agentgw.
--
-- Columns hold the raw provider keys. Access is restricted by RLS: only the
-- service role used by the gateway pooler connection can read or write. The
-- supabase anon and authenticated roles are denied all access by the policy
-- below, so the keys are protected at the row level.

CREATE TABLE IF NOT EXISTS user_provider_keys (
    user_id        UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    openai_key     TEXT,
    anthropic_key  TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE user_provider_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_provider_keys FORCE ROW LEVEL SECURITY;

-- Deny all non-service roles. The service role has BYPASSRLS, so the gateway
-- pooler connection still reads and writes normally.
DROP POLICY IF EXISTS user_provider_keys_deny_all ON user_provider_keys;
CREATE POLICY user_provider_keys_deny_all
    ON user_provider_keys
    AS RESTRICTIVE
    FOR ALL
    TO PUBLIC
    USING (false)
    WITH CHECK (false);
