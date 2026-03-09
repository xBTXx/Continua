import { Pool, QueryResultRow } from "pg";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  process.env.POSTGRES_URL ??
  "postgres://app:change-me@db:5432/app";

let pool: Pool | null = null;
let schemaReady: Promise<void> | null = null;

function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: DATABASE_URL });
  }
  return pool;
}

export async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const client = getPool();
      await client.query(`
        CREATE TABLE IF NOT EXISTS conversations (
          id UUID PRIMARY KEY,
          title TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          archived_at TIMESTAMPTZ
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS messages (
          id UUID PRIMARY KEY,
          conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          attachments JSONB,
          attachments_expires_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS messages_conversation_created_at_idx
          ON messages(conversation_id, created_at);
      `);
      await client.query(`
        ALTER TABLE IF EXISTS messages
        ADD COLUMN IF NOT EXISTS attachments JSONB;
      `);
      await client.query(`
        ALTER TABLE IF EXISTS messages
        ADD COLUMN IF NOT EXISTS attachments_expires_at TIMESTAMPTZ;
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS conversations_updated_at_idx
          ON conversations(updated_at DESC);
      `);
      await client.query(`
        ALTER TABLE IF EXISTS conversations
        ADD COLUMN IF NOT EXISTS last_consolidated_at TIMESTAMPTZ DEFAULT NOW();
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS oauth_tokens (
          id UUID PRIMARY KEY,
          provider TEXT NOT NULL,
          account_id TEXT NOT NULL,
          access_token TEXT NOT NULL,
          refresh_token TEXT,
          expires_at TIMESTAMPTZ,
          scope TEXT,
          token_type TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS oauth_tokens_provider_account_idx
          ON oauth_tokens(provider, account_id);
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id UUID PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS users_created_at_idx
          ON users(created_at DESC);
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS personal_memory_contexts (
          id UUID PRIMARY KEY,
          personal_memory_id TEXT NOT NULL,
          conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
          messages JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS idle_action_queue (
          id UUID PRIMARY KEY,
          thought_text TEXT NOT NULL,
          seed_id TEXT NOT NULL,
          seed_source TEXT NOT NULL,
          actions JSONB NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          model TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS idle_action_log (
          id UUID PRIMARY KEY,
          action_type TEXT NOT NULL,
          summary TEXT NOT NULL,
          action_data JSONB,
          source TEXT NOT NULL DEFAULT 'queued',
          plan_id UUID,
          model TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS email_reply_log (
          id UUID PRIMARY KEY,
          account_id TEXT NOT NULL,
          action_type TEXT NOT NULL,
          message_id TEXT,
          draft_id TEXT,
          source TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS idle_tick_log (
          id UUID PRIMARY KEY,
          seeds_count INTEGER NOT NULL DEFAULT 0,
          thoughts_generated INTEGER NOT NULL DEFAULT 0,
          stored_count INTEGER NOT NULL DEFAULT 0,
          escalated_count INTEGER NOT NULL DEFAULT 0,
          deferred_count INTEGER NOT NULL DEFAULT 0,
          actions_queued INTEGER NOT NULL DEFAULT 0,
          scratchpad_notes INTEGER NOT NULL DEFAULT 0,
          persona_keyword_hits INTEGER NOT NULL DEFAULT 0,
          persona_semantic_hits INTEGER NOT NULL DEFAULT 0,
          energy DOUBLE PRECISION,
          model_lite TEXT,
          model_smart TEXT,
          error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        ALTER TABLE IF EXISTS idle_tick_log
        ADD COLUMN IF NOT EXISTS energy DOUBLE PRECISION;
      `);
      await client.query(`
        ALTER TABLE IF EXISTS idle_tick_log
        ADD COLUMN IF NOT EXISTS persona_keyword_hits INTEGER NOT NULL DEFAULT 0;
      `);
      await client.query(`
        ALTER TABLE IF EXISTS idle_tick_log
        ADD COLUMN IF NOT EXISTS persona_semantic_hits INTEGER NOT NULL DEFAULT 0;
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS idle_workspace_sessions (
          id UUID PRIMARY KEY,
          thought_text TEXT NOT NULL,
          seed_id TEXT NOT NULL,
          seed_source TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          model TEXT,
          final_thought TEXT,
          summary TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS idle_workspace_events (
          id UUID PRIMARY KEY,
          session_id UUID NOT NULL REFERENCES idle_workspace_sessions(id) ON DELETE CASCADE,
          event_type TEXT NOT NULL,
          payload JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS scratchpad_notes (
          id UUID PRIMARY KEY,
          content TEXT NOT NULL,
          metadata JSONB,
          model TEXT,
          assigned_conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
          assigned_at TIMESTAMPTZ,
          idle_processed_at TIMESTAMPTZ,
          consumed_at TIMESTAMPTZ,
          consumed_conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
          target_phase TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        ALTER TABLE IF EXISTS scratchpad_notes
        ADD COLUMN IF NOT EXISTS idle_processed_at TIMESTAMPTZ;
      `);
      await client.query(`
        ALTER TABLE IF EXISTS scratchpad_notes
        ADD COLUMN IF NOT EXISTS target_phase TEXT;
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS chat_injection_log (
          id UUID PRIMARY KEY,
          conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
          message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
          payload JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS conversation_memory_log (
          id UUID PRIMARY KEY,
          conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          scope TEXT NOT NULL,
          memory_id TEXT NOT NULL,
          content TEXT NOT NULL,
          metadata JSONB,
          memory_created_at TIMESTAMPTZ,
          added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS web_sessions (
          id UUID PRIMARY KEY,
          conversation_id TEXT,
          domain TEXT NOT NULL,
          crawl4ai_session_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at TIMESTAMPTZ,
          meta JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS web_artifacts (
          id UUID PRIMARY KEY,
          conversation_id TEXT,
          domain TEXT NOT NULL,
          url TEXT NOT NULL,
          normalized_url TEXT NOT NULL,
          title TEXT,
          snippet TEXT,
          content_digest TEXT,
          source_tool TEXT NOT NULL,
          fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          ttl_seconds INTEGER,
          meta JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS calendar_events (
          id UUID PRIMARY KEY,
          title TEXT NOT NULL,
          start_time TIMESTAMPTZ NOT NULL,
          end_time TIMESTAMPTZ,
          description TEXT,
          all_day BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        ALTER TABLE IF EXISTS calendar_events
        ADD COLUMN IF NOT EXISTS recurrence JSONB;
      `);
      await client.query(`
        ALTER TABLE IF EXISTS calendar_events
        ADD COLUMN IF NOT EXISTS next_trigger_at TIMESTAMPTZ;
      `);
      await client.query(`
        ALTER TABLE IF EXISTS calendar_events
        ADD COLUMN IF NOT EXISTS last_triggered_at TIMESTAMPTZ;
      `);
      await client.query(`
        ALTER TABLE IF EXISTS calendar_events
        ADD COLUMN IF NOT EXISTS last_reminded_at TIMESTAMPTZ;
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS calendar_events_start_time_idx
          ON calendar_events(start_time);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS calendar_events_next_trigger_at_idx
          ON calendar_events(next_trigger_at);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS personal_memory_contexts_memory_idx
          ON personal_memory_contexts(personal_memory_id);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS personal_memory_contexts_conversation_idx
          ON personal_memory_contexts(conversation_id);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idle_action_queue_created_at_idx
          ON idle_action_queue(created_at DESC);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idle_action_log_created_at_idx
          ON idle_action_log(created_at DESC);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS email_reply_log_created_at_idx
          ON email_reply_log(created_at DESC);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS email_reply_log_account_message_idx
          ON email_reply_log(account_id, message_id);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS email_reply_log_account_draft_idx
          ON email_reply_log(account_id, draft_id);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idle_tick_log_created_at_idx
          ON idle_tick_log(created_at DESC);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idle_workspace_sessions_created_at_idx
          ON idle_workspace_sessions(created_at DESC);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idle_workspace_sessions_status_idx
          ON idle_workspace_sessions(status);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idle_workspace_events_created_at_idx
          ON idle_workspace_events(created_at DESC);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idle_workspace_events_session_idx
          ON idle_workspace_events(session_id, created_at DESC);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS scratchpad_notes_created_at_idx
          ON scratchpad_notes(created_at DESC);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS scratchpad_notes_active_idx
          ON scratchpad_notes(consumed_at);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS scratchpad_notes_assigned_idx
          ON scratchpad_notes(assigned_conversation_id);
      `);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS chat_injection_log_message_idx
          ON chat_injection_log(message_id);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS chat_injection_log_conversation_idx
          ON chat_injection_log(conversation_id, created_at DESC);
      `);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS conversation_memory_log_unique_idx
          ON conversation_memory_log(conversation_id, scope, memory_id);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS conversation_memory_log_conversation_idx
          ON conversation_memory_log(conversation_id, scope, last_seen_at DESC);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS conversation_memory_log_last_seen_idx
          ON conversation_memory_log(conversation_id, last_seen_at DESC);
      `);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS web_sessions_conversation_domain_unique_idx
          ON web_sessions(conversation_id, domain);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS web_sessions_status_last_seen_idx
          ON web_sessions(status, last_seen_at DESC);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS web_sessions_expires_idx
          ON web_sessions(expires_at);
      `);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS web_artifacts_conversation_normalized_url_unique_idx
          ON web_artifacts(conversation_id, normalized_url);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS web_artifacts_conversation_domain_fetched_idx
          ON web_artifacts(conversation_id, domain, fetched_at DESC);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS web_artifacts_normalized_url_idx
          ON web_artifacts(normalized_url);
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ssef_skills (
          id UUID PRIMARY KEY,
          skill_id TEXT NOT NULL UNIQUE,
          name TEXT,
          description TEXT NOT NULL DEFAULT '',
          lifecycle_state TEXT NOT NULL DEFAULT 'draft',
          latest_version TEXT,
          active_version TEXT,
          metadata JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        ALTER TABLE IF EXISTS ssef_skills
        ADD COLUMN IF NOT EXISTS latest_version TEXT;
      `);
      await client.query(`
        ALTER TABLE IF EXISTS ssef_skills
        ADD COLUMN IF NOT EXISTS active_version TEXT;
      `);
      await client.query(`
        ALTER TABLE IF EXISTS ssef_skills
        ADD COLUMN IF NOT EXISTS metadata JSONB;
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ssef_skills_lifecycle_idx
          ON ssef_skills(lifecycle_state);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ssef_skills_updated_at_idx
          ON ssef_skills(updated_at DESC);
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ssef_skill_versions (
          id UUID PRIMARY KEY,
          skill_id UUID NOT NULL REFERENCES ssef_skills(id) ON DELETE CASCADE,
          version TEXT NOT NULL,
          lifecycle_state TEXT NOT NULL DEFAULT 'draft',
          manifest JSONB NOT NULL,
          permissions JSONB NOT NULL,
          test_cases JSONB NOT NULL,
          context_keys JSONB NOT NULL,
          runtime TEXT NOT NULL,
          entrypoint TEXT NOT NULL,
          security_summary JSONB,
          source_proposal_id UUID,
          metadata JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(skill_id, version)
        );
      `);
      await client.query(`
        ALTER TABLE IF EXISTS ssef_skill_versions
        ADD COLUMN IF NOT EXISTS context_keys JSONB NOT NULL DEFAULT '[]'::jsonb;
      `);
      await client.query(`
        ALTER TABLE IF EXISTS ssef_skill_versions
        ADD COLUMN IF NOT EXISTS lifecycle_state TEXT NOT NULL DEFAULT 'draft';
      `);
      await client.query(`
        ALTER TABLE IF EXISTS ssef_skill_versions
        ADD COLUMN IF NOT EXISTS security_summary JSONB;
      `);
      await client.query(`
        ALTER TABLE IF EXISTS ssef_skill_versions
        ADD COLUMN IF NOT EXISTS source_proposal_id UUID;
      `);
      await client.query(`
        ALTER TABLE IF EXISTS ssef_skill_versions
        ADD COLUMN IF NOT EXISTS metadata JSONB;
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ssef_skill_versions_skill_created_idx
          ON ssef_skill_versions(skill_id, created_at DESC);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ssef_skill_versions_lifecycle_idx
          ON ssef_skill_versions(lifecycle_state);
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ssef_proposals (
          id UUID PRIMARY KEY,
          proposal_type TEXT NOT NULL DEFAULT 'spark',
          status TEXT NOT NULL DEFAULT 'draft',
          skill_id UUID REFERENCES ssef_skills(id) ON DELETE SET NULL,
          requested_by TEXT,
          title TEXT,
          summary TEXT,
          spark JSONB NOT NULL DEFAULT '{}'::jsonb,
          constraints JSONB,
          priority TEXT,
          metadata JSONB,
          reviewed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        ALTER TABLE IF EXISTS ssef_proposals
        ADD COLUMN IF NOT EXISTS constraints JSONB;
      `);
      await client.query(`
        ALTER TABLE IF EXISTS ssef_proposals
        ADD COLUMN IF NOT EXISTS priority TEXT;
      `);
      await client.query(`
        ALTER TABLE IF EXISTS ssef_proposals
        ADD COLUMN IF NOT EXISTS metadata JSONB;
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ssef_proposals_status_created_at_idx
          ON ssef_proposals(status, created_at DESC);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ssef_proposals_skill_created_at_idx
          ON ssef_proposals(skill_id, created_at DESC);
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ssef_runs (
          id UUID PRIMARY KEY,
          proposal_id UUID REFERENCES ssef_proposals(id) ON DELETE SET NULL,
          skill_version_id UUID REFERENCES ssef_skill_versions(id) ON DELETE SET NULL,
          run_type TEXT NOT NULL,
          status TEXT NOT NULL,
          attempt INTEGER NOT NULL DEFAULT 1,
          started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          finished_at TIMESTAMPTZ,
          stdout_log_path TEXT,
          stderr_log_path TEXT,
          trace_log_path TEXT,
          error TEXT,
          result JSONB,
          metadata JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ssef_runs_status_started_at_idx
          ON ssef_runs(status, started_at DESC);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ssef_runs_proposal_started_at_idx
          ON ssef_runs(proposal_id, started_at DESC);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ssef_runs_skill_version_started_at_idx
          ON ssef_runs(skill_version_id, started_at DESC);
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ssef_audit_events (
          id UUID PRIMARY KEY,
          event_type TEXT NOT NULL,
          actor TEXT,
          skill_id UUID REFERENCES ssef_skills(id) ON DELETE SET NULL,
          skill_version_id UUID REFERENCES ssef_skill_versions(id) ON DELETE SET NULL,
          proposal_id UUID REFERENCES ssef_proposals(id) ON DELETE SET NULL,
          run_id UUID REFERENCES ssef_runs(id) ON DELETE SET NULL,
          payload JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ssef_audit_events_created_at_idx
          ON ssef_audit_events(created_at DESC);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ssef_audit_events_event_type_created_at_idx
          ON ssef_audit_events(event_type, created_at DESC);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ssef_audit_events_skill_created_at_idx
          ON ssef_audit_events(skill_id, created_at DESC);
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ssef_policy_incidents (
          id UUID PRIMARY KEY,
          run_id UUID REFERENCES ssef_runs(id) ON DELETE SET NULL,
          skill_version_id UUID REFERENCES ssef_skill_versions(id) ON DELETE SET NULL,
          severity TEXT NOT NULL,
          category TEXT NOT NULL,
          decision TEXT NOT NULL DEFAULT 'denied',
          message TEXT NOT NULL,
          details JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ssef_policy_incidents_created_at_idx
          ON ssef_policy_incidents(created_at DESC);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ssef_policy_incidents_run_created_at_idx
          ON ssef_policy_incidents(run_id, created_at DESC);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ssef_policy_incidents_severity_created_at_idx
          ON ssef_policy_incidents(severity, created_at DESC);
      `);
    })();
  }

  await schemaReady;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
) {
  const client = getPool();
  return client.query<T>(text, params);
}
