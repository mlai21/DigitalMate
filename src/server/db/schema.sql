CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_data_epochs (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  epoch bigint NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO user_data_epochs (user_id)
SELECT id FROM users
ON CONFLICT (user_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS user_session_states (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel text NOT NULL DEFAULT 'web',
  title text NOT NULL DEFAULT '新的对话',
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  pinned boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE IF EXISTS conversations ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE IF EXISTS conversations ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content text NOT NULL,
  visible_to_user boolean NOT NULL DEFAULT true,
  memory_processed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE IF EXISTS messages
  ADD COLUMN IF NOT EXISTS client_turn_id uuid;
ALTER TABLE IF EXISTS messages
  ADD COLUMN IF NOT EXISTS client_turn_payload_hash text;
ALTER TABLE IF EXISTS messages
  ADD COLUMN IF NOT EXISTS client_turn_execution_started_at timestamptz;

CREATE TABLE IF NOT EXISTS message_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id uuid REFERENCES messages(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('image', 'document')),
  file_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes > 0),
  storage_key text NOT NULL UNIQUE,
  extracted_text text,
  text_truncated boolean NOT NULL DEFAULT false,
  status text NOT NULL,
  error_code text,
  deletion_claim_token uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_attachments_status_check
    CHECK (status IN ('pending', 'ready', 'failed', 'deleting', 'bound')),
  CONSTRAINT message_attachments_binding_check CHECK (
    (status = 'bound' AND message_id IS NOT NULL)
    OR (status <> 'bound' AND message_id IS NULL)
  )
);

ALTER TABLE IF EXISTS message_attachments
  ADD COLUMN IF NOT EXISTS deletion_claim_token uuid;

DO $message_attachments_status$
DECLARE
  current_definition text;
BEGIN
  SELECT pg_get_constraintdef(constraint_row.oid)
  INTO current_definition
  FROM pg_constraint AS constraint_row
  JOIN pg_class AS table_row ON table_row.oid = constraint_row.conrelid
  JOIN pg_namespace AS namespace_row ON namespace_row.oid = table_row.relnamespace
  WHERE namespace_row.nspname = current_schema()
    AND table_row.relname = 'message_attachments'
    AND constraint_row.conname = 'message_attachments_status_check';

  IF current_definition IS NULL THEN
    ALTER TABLE message_attachments
      ADD CONSTRAINT message_attachments_status_check
      CHECK (status IN ('pending', 'ready', 'failed', 'deleting', 'bound'));
  ELSIF position('deleting' IN current_definition) = 0 THEN
    ALTER TABLE message_attachments
      DROP CONSTRAINT message_attachments_status_check;
    ALTER TABLE message_attachments
      ADD CONSTRAINT message_attachments_status_check
      CHECK (status IN ('pending', 'ready', 'failed', 'deleting', 'bound'));
  END IF;
END
$message_attachments_status$;

CREATE TABLE IF NOT EXISTS conversation_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  summary text NOT NULL,
  message_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('episodic', 'profile', 'agent_self')),
  content text NOT NULL,
  confidence numeric(4, 3) NOT NULL DEFAULT 0.700,
  source_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  embedding vector(1536),
  expires_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tool_call_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  tool_name text NOT NULL,
  input_summary text NOT NULL,
  output_summary text NOT NULL,
  status text NOT NULL CHECK (status IN ('success', 'error')),
  duration_ms integer NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS proactive_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('reminder', 'follow_up', 'share')),
  content text NOT NULL,
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'cancelled', 'failed')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE IF EXISTS messages
  ADD COLUMN IF NOT EXISTS source_task_id uuid REFERENCES proactive_tasks(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS channel_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel text NOT NULL,
  external_user_id text NOT NULL,
  display_name text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, external_user_id)
);

CREATE TABLE IF NOT EXISTS channel_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  channel text NOT NULL,
  external_conversation_id text NOT NULL,
  external_message_id text NOT NULL,
  sender_id text NOT NULL,
  chat_type text NOT NULL CHECK (chat_type IN ('direct', 'group')),
  text text NOT NULL,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, external_message_id)
);

CREATE TABLE IF NOT EXISTS interjection_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  channel_message_id uuid REFERENCES channel_messages(id) ON DELETE SET NULL,
  channel text NOT NULL,
  external_conversation_id text NOT NULL,
  should_interject boolean NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reflections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  positives text[] NOT NULL DEFAULT '{}',
  negatives text[] NOT NULL DEFAULT '{}',
  suggestions text[] NOT NULL DEFAULT '{}',
  source_window jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded', 'applied', 'dismissed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  trigger text NOT NULL,
  content text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'enabled', 'disabled', 'rejected')),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'agent', 'task', 'imported')),
  source_url text,
  version integer NOT NULL DEFAULT 1,
  scan_report jsonb,
  usage_count integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE IF EXISTS skills ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';
ALTER TABLE IF EXISTS skills ADD COLUMN IF NOT EXISTS source_url text;
ALTER TABLE IF EXISTS skills ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE IF EXISTS skills ADD COLUMN IF NOT EXISTS scan_report jsonb;
ALTER TABLE IF EXISTS skills ADD COLUMN IF NOT EXISTS usage_count integer NOT NULL DEFAULT 0;
ALTER TABLE IF EXISTS skills ADD COLUMN IF NOT EXISTS last_used_at timestamptz;

CREATE TABLE IF NOT EXISTS skill_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_id uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  proposed_content text NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS skill_usage_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_id uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  triggered_by text NOT NULL DEFAULT 'auto' CHECK (triggered_by IN ('auto', 'explicit')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE IF EXISTS skill_usage_logs ADD COLUMN IF NOT EXISTS triggered_by text NOT NULL DEFAULT 'auto';

CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_user_identity
  ON skills(id, user_id);

DO $skill_owner_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'skill_revisions'::regclass
      AND conname = 'skill_revisions_skill_user_fkey'
  ) THEN
    ALTER TABLE skill_revisions
      ADD CONSTRAINT skill_revisions_skill_user_fkey
      FOREIGN KEY (skill_id, user_id)
      REFERENCES skills(id, user_id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'skill_usage_logs'::regclass
      AND conname = 'skill_usage_logs_skill_user_fkey'
  ) THEN
    ALTER TABLE skill_usage_logs
      ADD CONSTRAINT skill_usage_logs_skill_user_fkey
      FOREIGN KEY (skill_id, user_id)
      REFERENCES skills(id, user_id)
      ON DELETE CASCADE;
  END IF;
END
$skill_owner_constraints$;

CREATE TABLE IF NOT EXISTS task_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('sandbox', 'spreadsheet', 'presentation')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  input_summary text NOT NULL,
  output_summary text,
  error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_run_id uuid NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  storage_path text NOT NULL,
  temporary_storage_path text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tool_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL,
  command text NOT NULL,
  kind text NOT NULL DEFAULT 'script' CHECK (kind IN ('script', 'mcp')),
  mcp_tool_name text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'enabled', 'disabled', 'rejected')),
  requires_confirmation boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE IF EXISTS tool_registrations ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'script';
ALTER TABLE IF EXISTS tool_registrations ADD COLUMN IF NOT EXISTS mcp_tool_name text;

CREATE TABLE IF NOT EXISTS llm_usage_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  purpose text NOT NULL CHECK (purpose IN ('main', 'light')),
  model text NOT NULL,
  input_tokens integer NOT NULL,
  output_tokens integer NOT NULL,
  total_tokens integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  persona jsonb NOT NULL DEFAULT '{}'::jsonb,
  proactivity jsonb NOT NULL DEFAULT '{}'::jsonb,
  model_routing jsonb NOT NULL DEFAULT '{}'::jsonb,
  cadence jsonb NOT NULL DEFAULT '{}'::jsonb,
  search jsonb NOT NULL DEFAULT '{}'::jsonb,
  language text NOT NULL DEFAULT 'zh',
  timezone text NOT NULL DEFAULT 'Asia/Shanghai',
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE IF EXISTS settings ADD COLUMN IF NOT EXISTS search jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE IF EXISTS settings ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'zh';
ALTER TABLE IF EXISTS settings ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'Asia/Shanghai';
ALTER TABLE IF EXISTS settings ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS memory_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_ids uuid[] NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  contract jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'running', 'paused', 'needs_human', 'succeeded', 'failed_budget', 'failed_no_progress', 'cancelled')),
  progress_summary text NOT NULL DEFAULT '',
  report_draft text NOT NULL DEFAULT '',
  budget_used jsonb NOT NULL DEFAULT '{"rounds":0,"tokens":0,"costUsd":0}'::jsonb,
  no_progress_rounds integer NOT NULL DEFAULT 0,
  running_step uuid,
  needs_human_prompt text,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  next_run_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS goal_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id uuid NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  round integer NOT NULL,
  phase text NOT NULL CHECK (phase IN ('collecting', 'drafting', 'verifying', 'committed', 'failed')),
  intent text NOT NULL DEFAULT '',
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  candidate text NOT NULL DEFAULT '',
  verify_result jsonb,
  failed_paths jsonb NOT NULL DEFAULT '[]'::jsonb,
  tokens_used integer NOT NULL DEFAULT 0,
  duration_ms integer,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE IF EXISTS tool_call_logs ADD COLUMN IF NOT EXISTS goal_id uuid REFERENCES goals(id) ON DELETE SET NULL;

-- BEGIN DEFAULT DIGITAL AGENT MIGRATION

CREATE TABLE IF NOT EXISTS digital_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug text NOT NULL,
  display_name text NOT NULL,
  persona jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'archived')),
  is_default boolean NOT NULL DEFAULT false,
  inherits_user_resources boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, slug),
  UNIQUE (user_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_digital_agents_one_default
  ON digital_agents(user_id)
  WHERE is_default = true;

CREATE TABLE IF NOT EXISTS agent_resource_grants (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  resource_type text NOT NULL CHECK (resource_type IN ('model', 'skill', 'tool')),
  resource_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, resource_type, resource_id),
  CONSTRAINT agent_resource_grants_user_agent_fkey
    FOREIGN KEY (user_id, agent_id)
    REFERENCES digital_agents(user_id, id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_settings (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  persona jsonb NOT NULL DEFAULT '{}'::jsonb,
  proactivity jsonb NOT NULL DEFAULT '{}'::jsonb,
  cadence jsonb NOT NULL DEFAULT '{}'::jsonb,
  search jsonb NOT NULL DEFAULT '{}'::jsonb,
  model_routing_override jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, agent_id),
  CONSTRAINT agent_settings_user_agent_fkey
    FOREIGN KEY (user_id, agent_id)
    REFERENCES digital_agents(user_id, id)
    ON DELETE CASCADE
);

INSERT INTO digital_agents (user_id, slug, display_name, persona, is_default)
SELECT users.id, 'digitalmate', 'DigitalMate', COALESCE(settings.persona, '{}'::jsonb), true
FROM users
LEFT JOIN settings ON settings.user_id = users.id
WHERE NOT EXISTS (
  SELECT 1
  FROM digital_agents AS selected_default
  WHERE selected_default.user_id = users.id
    AND selected_default.is_default = true
)
ON CONFLICT (user_id, slug) DO UPDATE
SET is_default = true,
    updated_at = now();

INSERT INTO agent_settings (
  user_id, agent_id, persona, proactivity, cadence, search
)
SELECT settings.user_id,
       digital_agents.id,
       settings.persona,
       settings.proactivity,
       settings.cadence,
       settings.search
FROM settings
JOIN digital_agents
  ON digital_agents.user_id = settings.user_id
 AND digital_agents.is_default = true
ON CONFLICT (user_id, agent_id) DO NOTHING;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS agent_id uuid;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS agent_id uuid;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS agent_id uuid;
ALTER TABLE message_attachments ADD COLUMN IF NOT EXISTS agent_id uuid;
ALTER TABLE conversation_summaries ADD COLUMN IF NOT EXISTS agent_id uuid;
ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS agent_id uuid;
ALTER TABLE tool_call_logs ADD COLUMN IF NOT EXISTS agent_id uuid;
ALTER TABLE proactive_tasks ADD COLUMN IF NOT EXISTS agent_id uuid;
ALTER TABLE channel_identities ADD COLUMN IF NOT EXISTS agent_id uuid;
ALTER TABLE channel_messages ADD COLUMN IF NOT EXISTS agent_id uuid;
ALTER TABLE interjection_decisions ADD COLUMN IF NOT EXISTS agent_id uuid;
ALTER TABLE reflections ADD COLUMN IF NOT EXISTS agent_id uuid;
ALTER TABLE skill_usage_logs ADD COLUMN IF NOT EXISTS agent_id uuid;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS agent_id uuid;
ALTER TABLE task_artifacts ADD COLUMN IF NOT EXISTS agent_id uuid;
ALTER TABLE task_artifacts ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ready';
ALTER TABLE task_artifacts ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE task_artifacts ADD COLUMN IF NOT EXISTS temporary_storage_path text;
ALTER TABLE task_artifacts DROP CONSTRAINT IF EXISTS task_artifacts_status_check;
ALTER TABLE task_artifacts
  ADD CONSTRAINT task_artifacts_status_check CHECK (status IN ('pending', 'ready'));
ALTER TABLE task_artifacts ALTER COLUMN status SET DEFAULT 'pending';
ALTER TABLE llm_usage_logs ADD COLUMN IF NOT EXISTS agent_id uuid;
ALTER TABLE memory_jobs ADD COLUMN IF NOT EXISTS agent_id uuid;
ALTER TABLE goals ADD COLUMN IF NOT EXISTS agent_id uuid;
ALTER TABLE goal_steps ADD COLUMN IF NOT EXISTS agent_id uuid;

UPDATE projects AS scoped_row
SET agent_id = default_agent.id
FROM digital_agents AS default_agent
WHERE scoped_row.agent_id IS NULL
  AND default_agent.user_id = scoped_row.user_id
  AND default_agent.is_default = true;

UPDATE channel_identities AS scoped_row
SET agent_id = default_agent.id
FROM digital_agents AS default_agent
WHERE scoped_row.agent_id IS NULL
  AND default_agent.user_id = scoped_row.user_id
  AND default_agent.is_default = true;

UPDATE reflections AS scoped_row
SET agent_id = default_agent.id
FROM digital_agents AS default_agent
WHERE scoped_row.agent_id IS NULL
  AND default_agent.user_id = scoped_row.user_id
  AND default_agent.is_default = true;

UPDATE conversations AS scoped_row
SET agent_id = parent_row.agent_id
FROM projects AS parent_row
WHERE scoped_row.agent_id IS NULL
  AND parent_row.id = scoped_row.project_id;

UPDATE conversations AS scoped_row
SET agent_id = default_agent.id
FROM digital_agents AS default_agent
WHERE scoped_row.agent_id IS NULL
  AND default_agent.user_id = scoped_row.user_id
  AND default_agent.is_default = true;

UPDATE messages AS scoped_row
SET agent_id = parent_row.agent_id
FROM conversations AS parent_row
WHERE scoped_row.agent_id IS NULL
  AND parent_row.id = scoped_row.conversation_id;

UPDATE proactive_tasks AS scoped_row
SET agent_id = parent_row.agent_id
FROM conversations AS parent_row
WHERE scoped_row.agent_id IS NULL
  AND parent_row.id = scoped_row.conversation_id;

UPDATE message_attachments AS scoped_row
SET agent_id = parent_row.agent_id
FROM messages AS parent_row
WHERE scoped_row.agent_id IS NULL
  AND parent_row.id = scoped_row.message_id;

UPDATE message_attachments AS scoped_row
SET agent_id = default_agent.id
FROM digital_agents AS default_agent
WHERE scoped_row.agent_id IS NULL
  AND default_agent.user_id = scoped_row.user_id
  AND default_agent.is_default = true;

UPDATE conversation_summaries AS scoped_row
SET agent_id = parent_row.agent_id
FROM conversations AS parent_row
WHERE scoped_row.agent_id IS NULL
  AND parent_row.id = scoped_row.conversation_id;

UPDATE memory_entries AS scoped_row
SET agent_id = parent_row.agent_id
FROM messages AS parent_row
WHERE scoped_row.agent_id IS NULL
  AND parent_row.id = scoped_row.source_message_id;

UPDATE memory_entries AS scoped_row
SET agent_id = default_agent.id
FROM digital_agents AS default_agent
WHERE scoped_row.agent_id IS NULL
  AND default_agent.user_id = scoped_row.user_id
  AND default_agent.is_default = true;

UPDATE goals AS scoped_row
SET agent_id = parent_row.agent_id
FROM conversations AS parent_row
WHERE scoped_row.agent_id IS NULL
  AND parent_row.id = scoped_row.conversation_id;

UPDATE goals AS scoped_row
SET agent_id = default_agent.id
FROM digital_agents AS default_agent
WHERE scoped_row.agent_id IS NULL
  AND default_agent.user_id = scoped_row.user_id
  AND default_agent.is_default = true;

UPDATE tool_call_logs AS scoped_row
SET agent_id = parent_row.agent_id
FROM messages AS parent_row
WHERE scoped_row.agent_id IS NULL
  AND parent_row.id = scoped_row.message_id;

UPDATE tool_call_logs AS scoped_row
SET agent_id = parent_row.agent_id
FROM conversations AS parent_row
WHERE scoped_row.agent_id IS NULL
  AND parent_row.id = scoped_row.conversation_id;

UPDATE tool_call_logs AS scoped_row
SET agent_id = parent_row.agent_id
FROM goals AS parent_row
WHERE scoped_row.agent_id IS NULL
  AND parent_row.id = scoped_row.goal_id;

UPDATE tool_call_logs AS scoped_row
SET agent_id = default_agent.id
FROM digital_agents AS default_agent
WHERE scoped_row.agent_id IS NULL
  AND default_agent.user_id = scoped_row.user_id
  AND default_agent.is_default = true;

UPDATE channel_messages AS scoped_row
SET agent_id = parent_row.agent_id
FROM conversations AS parent_row
WHERE scoped_row.agent_id IS NULL
  AND parent_row.id = scoped_row.conversation_id;

UPDATE channel_messages AS scoped_row
SET agent_id = default_agent.id
FROM digital_agents AS default_agent
WHERE scoped_row.agent_id IS NULL
  AND default_agent.user_id = scoped_row.user_id
  AND default_agent.is_default = true;

UPDATE interjection_decisions AS scoped_row
SET agent_id = parent_row.agent_id
FROM channel_messages AS parent_row
WHERE scoped_row.agent_id IS NULL
  AND parent_row.id = scoped_row.channel_message_id;

UPDATE interjection_decisions AS scoped_row
SET agent_id = parent_row.agent_id
FROM conversations AS parent_row
WHERE scoped_row.agent_id IS NULL
  AND parent_row.id = scoped_row.conversation_id;

UPDATE interjection_decisions AS scoped_row
SET agent_id = default_agent.id
FROM digital_agents AS default_agent
WHERE scoped_row.agent_id IS NULL
  AND default_agent.user_id = scoped_row.user_id
  AND default_agent.is_default = true;

UPDATE skill_usage_logs AS scoped_row
SET agent_id = parent_row.agent_id
FROM conversations AS parent_row
WHERE scoped_row.agent_id IS NULL
  AND parent_row.id = scoped_row.conversation_id;

UPDATE skill_usage_logs AS scoped_row
SET agent_id = default_agent.id
FROM digital_agents AS default_agent
WHERE scoped_row.agent_id IS NULL
  AND default_agent.user_id = scoped_row.user_id
  AND default_agent.is_default = true;

UPDATE task_runs AS scoped_row
SET agent_id = parent_row.agent_id
FROM conversations AS parent_row
WHERE scoped_row.agent_id IS NULL
  AND parent_row.id = scoped_row.conversation_id;

UPDATE task_runs AS scoped_row
SET agent_id = default_agent.id
FROM digital_agents AS default_agent
WHERE scoped_row.agent_id IS NULL
  AND default_agent.user_id = scoped_row.user_id
  AND default_agent.is_default = true;

UPDATE task_artifacts AS scoped_row
SET agent_id = parent_row.agent_id
FROM task_runs AS parent_row
WHERE scoped_row.agent_id IS NULL
  AND parent_row.id = scoped_row.task_run_id;

UPDATE llm_usage_logs AS scoped_row
SET agent_id = parent_row.agent_id
FROM conversations AS parent_row
WHERE scoped_row.agent_id IS NULL
  AND parent_row.id = scoped_row.conversation_id;

UPDATE llm_usage_logs AS scoped_row
SET agent_id = default_agent.id
FROM digital_agents AS default_agent
WHERE scoped_row.agent_id IS NULL
  AND default_agent.user_id = scoped_row.user_id
  AND default_agent.is_default = true;

UPDATE memory_jobs AS scoped_row
SET agent_id = parent_row.agent_id
FROM conversations AS parent_row
WHERE scoped_row.agent_id IS NULL
  AND parent_row.id = scoped_row.conversation_id;

UPDATE goal_steps AS scoped_row
SET agent_id = parent_row.agent_id
FROM goals AS parent_row
WHERE scoped_row.agent_id IS NULL
  AND parent_row.id = scoped_row.goal_id;

DO $agent_scope_not_null$
DECLARE
  table_name text;
  has_null boolean;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'projects', 'conversations', 'messages', 'message_attachments',
    'conversation_summaries', 'memory_entries', 'tool_call_logs',
    'proactive_tasks', 'channel_identities', 'channel_messages',
    'interjection_decisions', 'reflections', 'skill_usage_logs',
    'task_runs', 'task_artifacts', 'llm_usage_logs', 'memory_jobs',
    'goals', 'goal_steps'
  ]
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE agent_id IS NULL)', table_name)
      INTO has_null;
    IF has_null THEN
      RAISE EXCEPTION 'agent_scope_backfill_failed:%', table_name
        USING ERRCODE = '23502';
    END IF;
    EXECUTE format('ALTER TABLE %I ALTER COLUMN agent_id SET NOT NULL', table_name);
  END LOOP;
END
$agent_scope_not_null$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_scope_identity
  ON projects(id, user_id, agent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_scope_identity
  ON conversations(id, user_id, agent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_scope_identity
  ON messages(id, user_id, agent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_proactive_tasks_scope_identity
  ON proactive_tasks(id, user_id, agent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_messages_scope_identity
  ON channel_messages(id, user_id, agent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_runs_scope_identity
  ON task_runs(id, user_id, agent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_goals_scope_identity
  ON goals(id, user_id, agent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_goals_agent_identity
  ON goals(id, agent_id);

DO $agent_scope_owner_constraints$
DECLARE
  table_name text;
  constraint_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'projects', 'conversations', 'messages', 'message_attachments',
    'conversation_summaries', 'memory_entries', 'tool_call_logs',
    'proactive_tasks', 'channel_identities', 'channel_messages',
    'interjection_decisions', 'reflections', 'skill_usage_logs',
    'task_runs', 'task_artifacts', 'llm_usage_logs', 'memory_jobs', 'goals'
  ]
  LOOP
    constraint_name := table_name || '_user_agent_fkey';
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = to_regclass(table_name)
        AND conname = constraint_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (user_id, agent_id) REFERENCES digital_agents(user_id, id) ON DELETE CASCADE',
        table_name,
        constraint_name
      );
    END IF;
  END LOOP;
END
$agent_scope_owner_constraints$;

DO $agent_scope_required_parent_constraints$
DECLARE
  relation_definition text;
  child_table text;
  child_column text;
  parent_table text;
  constraint_name text;
BEGIN
  FOREACH relation_definition IN ARRAY ARRAY[
    'messages|conversation_id|conversations|messages_conversation_scope_fkey',
    'message_attachments|message_id|messages|message_attachments_message_scope_fkey',
    'conversation_summaries|conversation_id|conversations|conversation_summaries_conversation_scope_fkey',
    'proactive_tasks|conversation_id|conversations|proactive_tasks_conversation_scope_fkey',
    'task_artifacts|task_run_id|task_runs|task_artifacts_task_run_scope_fkey',
    'memory_jobs|conversation_id|conversations|memory_jobs_conversation_scope_fkey'
  ]
  LOOP
    child_table := split_part(relation_definition, '|', 1);
    child_column := split_part(relation_definition, '|', 2);
    parent_table := split_part(relation_definition, '|', 3);
    constraint_name := split_part(relation_definition, '|', 4);
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = to_regclass(child_table)
        AND conname = constraint_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I, user_id, agent_id) REFERENCES %I(id, user_id, agent_id) ON DELETE CASCADE',
        child_table,
        constraint_name,
        child_column,
        parent_table
      );
    END IF;
  END LOOP;
END
$agent_scope_required_parent_constraints$;

DO $agent_scope_optional_parent_constraints$
DECLARE
  relation_definition text;
  child_table text;
  child_column text;
  parent_table text;
  constraint_name text;
BEGIN
  FOREACH relation_definition IN ARRAY ARRAY[
    'conversations|project_id|projects|conversations_project_scope_fkey',
    'messages|source_task_id|proactive_tasks|messages_source_task_scope_fkey',
    'memory_entries|source_message_id|messages|memory_entries_source_message_scope_fkey',
    'tool_call_logs|conversation_id|conversations|tool_call_logs_conversation_scope_fkey',
    'tool_call_logs|message_id|messages|tool_call_logs_message_scope_fkey',
    'tool_call_logs|goal_id|goals|tool_call_logs_goal_scope_fkey',
    'channel_messages|conversation_id|conversations|channel_messages_conversation_scope_fkey',
    'interjection_decisions|conversation_id|conversations|interjection_decisions_conversation_scope_fkey',
    'interjection_decisions|channel_message_id|channel_messages|interjection_decisions_channel_message_scope_fkey',
    'skill_usage_logs|conversation_id|conversations|skill_usage_logs_conversation_scope_fkey',
    'task_runs|conversation_id|conversations|task_runs_conversation_scope_fkey',
    'llm_usage_logs|conversation_id|conversations|llm_usage_logs_conversation_scope_fkey',
    'goals|conversation_id|conversations|goals_conversation_scope_fkey'
  ]
  LOOP
    child_table := split_part(relation_definition, '|', 1);
    child_column := split_part(relation_definition, '|', 2);
    parent_table := split_part(relation_definition, '|', 3);
    constraint_name := split_part(relation_definition, '|', 4);
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = to_regclass(child_table)
        AND conname = constraint_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I, user_id, agent_id) REFERENCES %I(id, user_id, agent_id) ON DELETE SET NULL (%I)',
        child_table,
        constraint_name,
        child_column,
        parent_table,
        child_column
      );
    END IF;
  END LOOP;
END
$agent_scope_optional_parent_constraints$;

DO $goal_steps_agent_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'goal_steps'::regclass
      AND conname = 'goal_steps_agent_id_fkey'
  ) THEN
    ALTER TABLE goal_steps
      ADD CONSTRAINT goal_steps_agent_id_fkey
      FOREIGN KEY (agent_id)
      REFERENCES digital_agents(id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'goal_steps'::regclass
      AND conname = 'goal_steps_goal_agent_fkey'
  ) THEN
    ALTER TABLE goal_steps
      ADD CONSTRAINT goal_steps_goal_agent_fkey
      FOREIGN KEY (goal_id, agent_id)
      REFERENCES goals(id, agent_id)
      ON DELETE CASCADE;
  END IF;
END
$goal_steps_agent_constraints$;

CREATE TABLE IF NOT EXISTS channel_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  channel_type text NOT NULL
    CONSTRAINT channel_connections_channel_type_check
    CHECK (btrim(channel_type) <> ''),
  display_name text NOT NULL
    CONSTRAINT channel_connections_display_name_check
    CHECK (btrim(display_name) <> ''),
  enabled boolean NOT NULL DEFAULT false,
  runtime_node_id uuid,
  config jsonb NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT channel_connections_config_object_check
    CHECK (jsonb_typeof(config) = 'object'),
  revision integer NOT NULL DEFAULT 1
    CONSTRAINT channel_connections_revision_check
    CHECK (revision > 0),
  health_status text NOT NULL DEFAULT 'disabled'
    CONSTRAINT channel_connections_health_status_check
    CHECK (
      health_status IN (
        'disabled', 'starting', 'connected', 'degraded',
        'disconnected', 'blocked'
      )
    ),
  health_detail jsonb NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT channel_connections_health_detail_object_check
    CHECK (jsonb_typeof(health_detail) = 'object'),
  last_connected_at timestamptz,
  last_disconnected_at timestamptz,
  last_event_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id, agent_id),
  CONSTRAINT channel_connections_user_agent_fkey
    FOREIGN KEY (user_id, agent_id)
    REFERENCES digital_agents(user_id, id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS channel_secrets (
  connection_id uuid NOT NULL,
  field_name text NOT NULL
    CONSTRAINT channel_secrets_field_name_check
    CHECK (
      btrim(field_name) <> ''
      AND length(field_name) <= 128
    ),
  ciphertext bytea NOT NULL
    CONSTRAINT channel_secrets_ciphertext_length_check
    CHECK (octet_length(ciphertext) > 0),
  nonce bytea NOT NULL
    CONSTRAINT channel_secrets_nonce_length_check
    CHECK (octet_length(nonce) = 12),
  auth_tag bytea NOT NULL
    CONSTRAINT channel_secrets_auth_tag_length_check
    CHECK (octet_length(auth_tag) = 16),
  key_version integer NOT NULL
    CONSTRAINT channel_secrets_key_version_check
    CHECK (key_version > 0),
  rotated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, field_name),
  CONSTRAINT channel_secrets_connection_id_fkey
    FOREIGN KEY (connection_id)
    REFERENCES channel_connections(id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id uuid,
  action text NOT NULL
    CONSTRAINT admin_audit_logs_action_check
    CHECK (btrim(action) <> ''),
  resource_type text NOT NULL
    CONSTRAINT admin_audit_logs_resource_type_check
    CHECK (btrim(resource_type) <> ''),
  resource_id text NOT NULL
    CONSTRAINT admin_audit_logs_resource_id_check
    CHECK (btrim(resource_id) <> ''),
  before_summary jsonb NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT admin_audit_logs_before_summary_object_check
    CHECK (jsonb_typeof(before_summary) = 'object'),
  after_summary jsonb NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT admin_audit_logs_after_summary_object_check
    CHECK (jsonb_typeof(after_summary) = 'object'),
  confirmation_source jsonb
    CONSTRAINT admin_audit_logs_confirmation_source_object_check
    CHECK (
      confirmation_source IS NULL
      OR jsonb_typeof(confirmation_source) = 'object'
    ),
  status text NOT NULL
    CONSTRAINT admin_audit_logs_status_check
    CHECK (status IN ('success', 'failed')),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_audit_logs_user_agent_fkey
    FOREIGN KEY (user_id, agent_id)
    REFERENCES digital_agents(user_id, id)
    ON DELETE SET NULL (agent_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_connections_scope_type_active
  ON channel_connections(user_id, agent_id, channel_type, created_at)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_channel_connections_scope_health
  ON channel_connections(user_id, agent_id, health_status)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_scope_created
  ON admin_audit_logs(user_id, agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_resource_created
  ON admin_audit_logs(user_id, resource_type, resource_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_turn_agent_role
  ON messages(user_id, agent_id, client_turn_id, role)
  WHERE client_turn_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_source_task_agent
  ON messages(agent_id, source_task_id)
  WHERE source_task_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_identities_agent_external_user
  ON channel_identities(agent_id, channel, external_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_messages_agent_external_message
  ON channel_messages(agent_id, channel, external_message_id);

DROP INDEX IF EXISTS idx_messages_client_turn_role;
DROP INDEX IF EXISTS idx_messages_source_task;
ALTER TABLE channel_identities
  DROP CONSTRAINT IF EXISTS channel_identities_channel_external_user_id_key;
ALTER TABLE channel_messages
  DROP CONSTRAINT IF EXISTS channel_messages_channel_external_message_id_key;

CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON conversations(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id, updated_at DESC) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_projects_user_updated ON projects(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_message_attachments_message ON message_attachments(message_id, created_at);
CREATE INDEX IF NOT EXISTS idx_message_attachments_stale ON message_attachments(status, created_at) WHERE message_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_conversation_summaries_conversation_created ON conversation_summaries(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_entries_user_active ON memory_entries(user_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_memory_entries_embedding ON memory_entries USING ivfflat (embedding vector_cosine_ops) WHERE embedding IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tool_call_logs_user_created ON tool_call_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_proactive_tasks_due ON proactive_tasks(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_channel_messages_channel_conversation ON channel_messages(channel, external_conversation_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_interjection_decisions_conversation ON interjection_decisions(channel, external_conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reflections_user_created ON reflections(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_skills_user_status ON skills(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_skill_revisions_user_status ON skill_revisions(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_skill_usage_logs_skill_created ON skill_usage_logs(skill_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_runs_user_status ON task_runs(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_artifacts_run ON task_artifacts(task_run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_artifacts_pending ON task_artifacts(agent_id, updated_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_tool_registrations_user_status ON tool_registrations(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_user_created ON llm_usage_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_goals_due ON goals(next_run_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_goals_user_status ON goals(user_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_goal_steps_goal ON goal_steps(goal_id, round);
