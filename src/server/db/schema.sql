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
ALTER TABLE IF EXISTS conversations ADD COLUMN IF NOT EXISTS archived_at timestamptz;

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
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
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
ALTER TABLE IF EXISTS skills
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;

DO $skills_revision_check$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'skills'::regclass
      AND conname = 'skills_revision_check'
  ) THEN
    ALTER TABLE skills
      ADD CONSTRAINT skills_revision_check
      CHECK (revision > 0);
  END IF;
END
$skills_revision_check$;

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
ALTER TABLE IF EXISTS tool_registrations
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;

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
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE IF EXISTS goals
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;

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
  heartbeat jsonb NOT NULL DEFAULT '{"enabled":false,"every":"6h","target":"inbox","timeoutSeconds":300,"activeHours":null,"authorization":null}'::jsonb,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, agent_id),
  CONSTRAINT agent_settings_user_agent_fkey
    FOREIGN KEY (user_id, agent_id)
    REFERENCES digital_agents(user_id, id)
  ON DELETE CASCADE
);

ALTER TABLE IF EXISTS agent_settings
  ADD COLUMN IF NOT EXISTS heartbeat jsonb NOT NULL
  DEFAULT '{"enabled":false,"every":"6h","target":"inbox","timeoutSeconds":300,"activeHours":null,"authorization":null}'::jsonb;

CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (btrim(name) <> ''),
  enabled boolean NOT NULL DEFAULT false,
  kind text NOT NULL
    CHECK (kind IN (
      'reminder', 'follow_up', 'scheduled_digest',
      'topic_subscription'
    )),
  schedule jsonb NOT NULL,
  task_type text NOT NULL CHECK (task_type IN ('text', 'agent')),
  content text NOT NULL,
  request jsonb,
  dispatch jsonb NOT NULL,
  runtime jsonb NOT NULL DEFAULT '{}'::jsonb,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  save_result_to_inbox boolean NOT NULL DEFAULT true,
  network_enabled boolean NOT NULL DEFAULT false,
  authorization_type text
    CHECK (
      authorization_type IS NULL
      OR authorization_type IN (
        'scheduled_digest', 'subscription', 'goal_contract'
      )
    ),
  authorization_source_id uuid,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  next_run_at timestamptz,
  last_run_at timestamptz,
  status text NOT NULL DEFAULT 'idle'
    CHECK (status IN ('idle', 'running', 'success', 'error', 'paused')),
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scheduled_jobs_user_agent_fkey
    FOREIGN KEY (user_id, agent_id)
    REFERENCES digital_agents(user_id, id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS scheduled_job_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
  proactive_task_id uuid REFERENCES proactive_tasks(id) ON DELETE SET NULL,
  scheduled_for timestamptz,
  run_at timestamptz NOT NULL,
  status text NOT NULL
    CHECK (status IN (
      'success', 'error', 'running', 'skipped', 'cancelled'
    )),
  trigger text NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
  error_code text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scheduled_job_runs_user_agent_fkey
    FOREIGN KEY (user_id, agent_id)
    REFERENCES digital_agents(user_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_due
  ON scheduled_jobs(enabled, next_run_at)
  WHERE enabled = true;
CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_job
  ON scheduled_job_runs(user_id, agent_id, job_id, run_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_job_runs_source
  ON scheduled_job_runs(job_id, scheduled_for)
  WHERE trigger = 'scheduled' AND scheduled_for IS NOT NULL;

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
  CONSTRAINT channel_connections_id_user_key
    UNIQUE (id, user_id),
  UNIQUE (id, user_id, agent_id),
  CONSTRAINT channel_connections_user_agent_fkey
    FOREIGN KEY (user_id, agent_id)
    REFERENCES digital_agents(user_id, id)
    ON DELETE CASCADE
);

DO $channel_connections_fingerprint_scope$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'channel_connections'::regclass
      AND conname = 'channel_connections_id_user_key'
  ) THEN
    ALTER TABLE channel_connections
      ADD CONSTRAINT channel_connections_id_user_key
      UNIQUE (id, user_id);
  END IF;
END
$channel_connections_fingerprint_scope$;

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

CREATE TABLE IF NOT EXISTS channel_secret_exposure_fingerprints (
  user_id uuid NOT NULL,
  connection_id uuid,
  field_name text NOT NULL
    CONSTRAINT channel_secret_exposure_fingerprints_field_name_check
    CHECK (
      btrim(field_name) <> ''
      AND length(field_name) <= 128
    ),
  key_version integer NOT NULL
    CONSTRAINT channel_secret_exposure_fingerprints_key_version_check
    CHECK (key_version > 0),
  digest bytea NOT NULL
    CONSTRAINT channel_secret_exposure_fingerprints_digest_length_check
    CHECK (octet_length(digest) = 32),
  utf8_bytes integer NOT NULL
    CONSTRAINT channel_secret_exposure_fingerprints_utf8_bytes_check
    CHECK (utf8_bytes > 0),
  character_length integer NOT NULL
    CONSTRAINT channel_secret_exposure_fingerprints_character_length_check
    CHECK (character_length > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key_version, digest),
  CONSTRAINT channel_secret_exposure_fingerprints_user_id_fkey
    FOREIGN KEY (user_id)
    REFERENCES users(id)
    ON DELETE CASCADE,
  CONSTRAINT channel_secret_exposure_fingerprints_connection_user_fkey
    FOREIGN KEY (connection_id, user_id)
    REFERENCES channel_connections(id, user_id)
    ON DELETE SET NULL (connection_id)
);

ALTER TABLE IF EXISTS channel_secret_exposure_fingerprints
  ADD COLUMN IF NOT EXISTS user_id uuid;

UPDATE channel_secret_exposure_fingerprints AS fingerprint
SET user_id = connection.user_id
FROM channel_connections AS connection
WHERE fingerprint.user_id IS NULL
  AND connection.id = fingerprint.connection_id;

DELETE FROM channel_secret_exposure_fingerprints
WHERE user_id IS NULL;

ALTER TABLE IF EXISTS channel_secret_exposure_fingerprints
  ALTER COLUMN user_id SET NOT NULL;

DO $channel_secret_exposure_fingerprint_keys$
DECLARE
  primary_definition text;
  connection_definition text;
BEGIN
  SELECT pg_get_constraintdef(oid)
  INTO primary_definition
  FROM pg_constraint
  WHERE conrelid =
      'channel_secret_exposure_fingerprints'::regclass
    AND contype = 'p';

  IF primary_definition IS NOT NULL
     AND primary_definition <>
       'PRIMARY KEY (user_id, key_version, digest)' THEN
    ALTER TABLE channel_secret_exposure_fingerprints
      DROP CONSTRAINT channel_secret_exposure_fingerprints_pkey;
  END IF;

  ALTER TABLE channel_secret_exposure_fingerprints
    DROP CONSTRAINT IF EXISTS
      channel_secret_exposure_fingerprints_connection_id_fkey;

  SELECT pg_get_constraintdef(oid)
  INTO connection_definition
  FROM pg_constraint
  WHERE conrelid =
      'channel_secret_exposure_fingerprints'::regclass
    AND conname =
      'channel_secret_exposure_fingerprints_connection_user_fkey';

  IF connection_definition IS NOT NULL
     AND connection_definition <>
       'FOREIGN KEY (connection_id, user_id) REFERENCES channel_connections(id, user_id) ON DELETE SET NULL (connection_id)' THEN
    ALTER TABLE channel_secret_exposure_fingerprints
      DROP CONSTRAINT
        channel_secret_exposure_fingerprints_connection_user_fkey;
  END IF;
END
$channel_secret_exposure_fingerprint_keys$;

ALTER TABLE IF EXISTS channel_secret_exposure_fingerprints
  ALTER COLUMN connection_id DROP NOT NULL;

UPDATE channel_secret_exposure_fingerprints AS fingerprint
SET connection_id = NULL
WHERE fingerprint.connection_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM channel_connections AS connection
    WHERE connection.id = fingerprint.connection_id
      AND connection.user_id = fingerprint.user_id
  );

DELETE FROM channel_secret_exposure_fingerprints AS duplicate
USING channel_secret_exposure_fingerprints AS retained
WHERE duplicate.user_id = retained.user_id
  AND duplicate.key_version = retained.key_version
  AND duplicate.digest = retained.digest
  AND duplicate.ctid > retained.ctid;

DO $channel_secret_exposure_fingerprint_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid =
        'channel_secret_exposure_fingerprints'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE channel_secret_exposure_fingerprints
      ADD CONSTRAINT channel_secret_exposure_fingerprints_pkey
      PRIMARY KEY (user_id, key_version, digest);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid =
        'channel_secret_exposure_fingerprints'::regclass
      AND conname =
        'channel_secret_exposure_fingerprints_user_id_fkey'
  ) THEN
    ALTER TABLE channel_secret_exposure_fingerprints
      ADD CONSTRAINT
        channel_secret_exposure_fingerprints_user_id_fkey
      FOREIGN KEY (user_id)
      REFERENCES users(id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid =
        'channel_secret_exposure_fingerprints'::regclass
      AND conname =
        'channel_secret_exposure_fingerprints_connection_user_fkey'
  ) THEN
    ALTER TABLE channel_secret_exposure_fingerprints
      ADD CONSTRAINT
        channel_secret_exposure_fingerprints_connection_user_fkey
      FOREIGN KEY (connection_id, user_id)
      REFERENCES channel_connections(id, user_id)
      ON DELETE SET NULL (connection_id);
  END IF;
END
$channel_secret_exposure_fingerprint_constraints$;

CREATE TABLE IF NOT EXISTS channel_runtime_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  display_name text NOT NULL
    CONSTRAINT channel_runtime_nodes_display_name_check
    CHECK (btrim(display_name) <> ''),
  certificate_fingerprint bytea NOT NULL
    CONSTRAINT channel_runtime_nodes_fingerprint_length_check
    CHECK (octet_length(certificate_fingerprint) = 32),
  supported_channel_types text[] NOT NULL DEFAULT '{}'::text[]
    CONSTRAINT channel_runtime_nodes_supported_types_check
    CHECK (cardinality(supported_channel_types) <= 17),
  status text NOT NULL DEFAULT 'disconnected'
    CONSTRAINT channel_runtime_nodes_status_check
    CHECK (status IN ('disconnected', 'connected', 'revoked')),
  last_sequence bigint NOT NULL DEFAULT 0
    CONSTRAINT channel_runtime_nodes_last_sequence_check
    CHECK (last_sequence >= 0),
  last_server_sequence bigint NOT NULL DEFAULT 0
    CONSTRAINT channel_runtime_nodes_last_server_sequence_check
    CHECK (last_server_sequence >= 0),
  client_version text
    CONSTRAINT channel_runtime_nodes_client_version_check
    CHECK (
      client_version IS NULL
      OR (
        btrim(client_version) <> ''
        AND length(client_version) <= 128
      )
    ),
  certificate_expires_at timestamptz NOT NULL,
  last_heartbeat_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  CONSTRAINT channel_runtime_nodes_id_user_agent_key
    UNIQUE (id, user_id, agent_id),
  CONSTRAINT channel_runtime_nodes_user_agent_fkey
    FOREIGN KEY (user_id, agent_id)
    REFERENCES digital_agents(user_id, id)
    ON DELETE CASCADE,
  UNIQUE (user_id, certificate_fingerprint)
);

ALTER TABLE IF EXISTS channel_runtime_nodes
  ADD COLUMN IF NOT EXISTS
    last_server_sequence bigint NOT NULL DEFAULT 0;
ALTER TABLE IF EXISTS channel_runtime_nodes
  ADD COLUMN IF NOT EXISTS client_version text;
ALTER TABLE IF EXISTS channel_runtime_nodes
  ADD COLUMN IF NOT EXISTS certificate_expires_at timestamptz;
ALTER TABLE IF EXISTS channel_runtime_nodes
  ADD COLUMN IF NOT EXISTS agent_id uuid;

UPDATE channel_runtime_nodes AS node
SET agent_id = selected.agent_id
FROM (
  SELECT runtime_node_id AS node_id, min(agent_id::text)::uuid AS agent_id
  FROM channel_connections
  WHERE runtime_node_id IS NOT NULL
  GROUP BY runtime_node_id
  HAVING count(DISTINCT agent_id) = 1
) AS selected
WHERE node.agent_id IS NULL
  AND node.id = selected.node_id;

UPDATE channel_runtime_nodes AS node
SET agent_id = selected.id
FROM digital_agents AS selected
WHERE node.agent_id IS NULL
  AND selected.user_id = node.user_id
  AND selected.is_default = true;

UPDATE channel_runtime_nodes
SET certificate_expires_at = now()
WHERE certificate_expires_at IS NULL;

ALTER TABLE channel_runtime_nodes
  ALTER COLUMN agent_id SET NOT NULL,
  ALTER COLUMN certificate_expires_at SET NOT NULL;

DO $channel_runtime_nodes_agent_scope$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'channel_runtime_nodes'::regclass
      AND conname =
        'channel_runtime_nodes_user_agent_fkey'
  ) THEN
    ALTER TABLE channel_runtime_nodes
      ADD CONSTRAINT
        channel_runtime_nodes_user_agent_fkey
      FOREIGN KEY (user_id, agent_id)
      REFERENCES digital_agents(user_id, id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'channel_runtime_nodes'::regclass
      AND conname =
        'channel_runtime_nodes_id_user_agent_key'
  ) THEN
    ALTER TABLE channel_runtime_nodes
      ADD CONSTRAINT
        channel_runtime_nodes_id_user_agent_key
      UNIQUE (id, user_id, agent_id);
  END IF;
END
$channel_runtime_nodes_agent_scope$;

DO $channel_runtime_nodes_server_sequence_constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'channel_runtime_nodes'::regclass
      AND conname =
        'channel_runtime_nodes_last_server_sequence_check'
  ) THEN
    ALTER TABLE channel_runtime_nodes
      ADD CONSTRAINT
        channel_runtime_nodes_last_server_sequence_check
      CHECK (last_server_sequence >= 0);
  END IF;
END
$channel_runtime_nodes_server_sequence_constraint$;

DO $channel_runtime_nodes_client_version_constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'channel_runtime_nodes'::regclass
      AND conname =
        'channel_runtime_nodes_client_version_check'
  ) THEN
    ALTER TABLE channel_runtime_nodes
      ADD CONSTRAINT
        channel_runtime_nodes_client_version_check
      CHECK (
        client_version IS NULL
        OR (
          btrim(client_version) <> ''
          AND length(client_version) <= 128
        )
      );
  END IF;
END
$channel_runtime_nodes_client_version_constraint$;

CREATE TABLE IF NOT EXISTS channel_node_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  node_id uuid NOT NULL,
  token_digest bytea NOT NULL
    CONSTRAINT channel_node_enrollments_token_digest_check
    CHECK (octet_length(token_digest) = 32),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_node_enrollments_node_scope_fkey
    FOREIGN KEY (node_id, user_id)
    REFERENCES channel_runtime_nodes(id, user_id)
    ON DELETE CASCADE,
  CONSTRAINT channel_node_enrollments_ttl_check
    CHECK (
      expires_at > created_at
      AND expires_at <= created_at + interval '10 minutes'
    ),
  CONSTRAINT channel_node_enrollments_consumed_check
    CHECK (
      consumed_at IS NULL
      OR consumed_at >= created_at
    ),
  UNIQUE (token_digest)
);

CREATE OR REPLACE FUNCTION
  notify_channel_runtime_node_revoked()
RETURNS trigger
LANGUAGE plpgsql
AS $channel_runtime_node_revoked_function$
BEGIN
  IF (
       NEW.status = 'revoked'
       AND OLD.status IS DISTINCT FROM NEW.status
     )
     OR NEW.certificate_fingerprint
          IS DISTINCT FROM OLD.certificate_fingerprint THEN
    PERFORM pg_notify(
      'channel_runtime_node_revoked',
      NEW.id::text
    );
  END IF;
  RETURN NEW;
END
$channel_runtime_node_revoked_function$;

DROP TRIGGER IF EXISTS
  channel_runtime_node_revoked_notify
  ON channel_runtime_nodes;
CREATE TRIGGER channel_runtime_node_revoked_notify
AFTER UPDATE OF status, certificate_fingerprint
ON channel_runtime_nodes
FOR EACH ROW
EXECUTE FUNCTION notify_channel_runtime_node_revoked();

DO $channel_connections_runtime_node_constraint$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM channel_connections AS connection
    WHERE connection.runtime_node_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM channel_runtime_nodes AS node
        WHERE node.id = connection.runtime_node_id
          AND node.user_id = connection.user_id
          AND node.agent_id = connection.agent_id
      )
  ) THEN
    RAISE EXCEPTION 'channel_runtime_node_binding_invalid'
      USING ERRCODE = '23503';
  END IF;

  ALTER TABLE channel_connections
    DROP CONSTRAINT IF EXISTS
      channel_connections_runtime_node_id_fkey;
  ALTER TABLE channel_connections
    ADD CONSTRAINT channel_connections_runtime_node_id_fkey
    FOREIGN KEY (runtime_node_id, user_id, agent_id)
    REFERENCES channel_runtime_nodes(id, user_id, agent_id)
    ON DELETE SET NULL (runtime_node_id);
END
$channel_connections_runtime_node_constraint$;

CREATE TABLE IF NOT EXISTS channel_node_bindings (
  connection_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  node_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_node_bindings_connection_scope_fkey
    FOREIGN KEY (connection_id, user_id, agent_id)
    REFERENCES channel_connections(id, user_id, agent_id)
    ON DELETE CASCADE,
  CONSTRAINT channel_node_bindings_node_scope_fkey
    FOREIGN KEY (node_id, user_id, agent_id)
    REFERENCES channel_runtime_nodes(id, user_id, agent_id)
    ON DELETE CASCADE,
  UNIQUE (node_id, connection_id)
);

ALTER TABLE channel_node_bindings
  DROP CONSTRAINT IF EXISTS
    channel_node_bindings_node_scope_fkey;
ALTER TABLE channel_node_bindings
  ADD CONSTRAINT channel_node_bindings_node_scope_fkey
  FOREIGN KEY (node_id, user_id, agent_id)
  REFERENCES channel_runtime_nodes(id, user_id, agent_id)
  ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS channel_node_inbound_receipts (
  user_id uuid NOT NULL,
  node_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  client_sequence bigint NOT NULL
    CONSTRAINT channel_node_inbound_receipts_sequence_check
    CHECK (client_sequence > 0),
  external_event_id text NOT NULL
    CONSTRAINT channel_node_inbound_receipts_event_id_check
    CHECK (btrim(external_event_id) <> ''),
  frame_digest bytea NOT NULL
    CONSTRAINT channel_node_inbound_receipts_digest_check
    CHECK (octet_length(frame_digest) = 32),
  ack jsonb NOT NULL
    CONSTRAINT channel_node_inbound_receipts_ack_check
    CHECK (
      jsonb_typeof(ack) = 'object'
      AND pg_column_size(ack) <= 65536
    ),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_node_inbound_receipts_node_scope_fkey
    FOREIGN KEY (node_id, user_id)
    REFERENCES channel_runtime_nodes(id, user_id)
    ON DELETE CASCADE,
  CONSTRAINT channel_node_inbound_receipts_connection_scope_fkey
    FOREIGN KEY (connection_id, user_id)
    REFERENCES channel_connections(id, user_id)
    ON DELETE CASCADE,
  PRIMARY KEY (node_id, client_sequence)
);

CREATE TABLE IF NOT EXISTS channel_inbound_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  channel_type text NOT NULL
    CONSTRAINT channel_inbound_events_channel_type_check
    CHECK (btrim(channel_type) <> ''),
  external_event_id text NOT NULL
    CONSTRAINT channel_inbound_events_external_event_id_check
    CHECK (btrim(external_event_id) <> ''),
  external_conversation_id text NOT NULL
    CONSTRAINT channel_inbound_events_external_conversation_id_check
    CHECK (btrim(external_conversation_id) <> ''),
  external_sender_id text NOT NULL
    CONSTRAINT channel_inbound_events_external_sender_id_check
    CHECK (btrim(external_sender_id) <> ''),
  chat_type text NOT NULL
    CONSTRAINT channel_inbound_events_chat_type_check
    CHECK (chat_type IN ('direct', 'group')),
  normalized_payload jsonb NOT NULL
    CONSTRAINT channel_inbound_events_payload_object_check
    CHECK (jsonb_typeof(normalized_payload) = 'object'),
  permission_envelope jsonb NOT NULL
    CONSTRAINT channel_inbound_events_permission_object_check
    CHECK (jsonb_typeof(permission_envelope) = 'object'),
  reply_handle_required boolean NOT NULL DEFAULT false,
  client_turn_id uuid NOT NULL,
  payload_hash text NOT NULL
    CONSTRAINT channel_inbound_events_payload_hash_check
    CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'accepted'
    CONSTRAINT channel_inbound_events_status_check
    CHECK (status IN (
      'pending_attachments', 'accepted', 'running', 'completed', 'failed'
    )),
  claim_owner text,
  claim_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0
    CONSTRAINT channel_inbound_events_attempts_check
    CHECK (attempts >= 0),
  failure_code text,
  assistant_message_id uuid,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_inbound_events_claim_state_check
    CHECK (
      (status = 'running'
        AND claim_owner IS NOT NULL
        AND claim_expires_at IS NOT NULL)
      OR status <> 'running'
    ),
  CONSTRAINT channel_inbound_events_user_agent_fkey
    FOREIGN KEY (user_id, agent_id)
    REFERENCES digital_agents(user_id, id)
    ON DELETE CASCADE,
  CONSTRAINT channel_inbound_events_connection_scope_fkey
    FOREIGN KEY (connection_id, user_id, agent_id)
    REFERENCES channel_connections(id, user_id, agent_id)
    ON DELETE CASCADE,
  CONSTRAINT channel_inbound_events_message_scope_fkey
    FOREIGN KEY (assistant_message_id, user_id, agent_id)
    REFERENCES messages(id, user_id, agent_id)
    ON DELETE SET NULL (assistant_message_id),
  UNIQUE (id, user_id, agent_id),
  UNIQUE (connection_id, external_event_id),
  UNIQUE (user_id, agent_id, client_turn_id)
);

ALTER TABLE IF EXISTS channel_inbound_events
  ADD COLUMN IF NOT EXISTS
    reply_handle_required boolean NOT NULL DEFAULT false;

ALTER TABLE IF EXISTS channel_inbound_events
  DROP CONSTRAINT IF EXISTS channel_inbound_events_status_check;

ALTER TABLE IF EXISTS channel_inbound_events
  ADD CONSTRAINT channel_inbound_events_status_check
  CHECK (status IN (
    'pending_attachments', 'accepted', 'running', 'completed', 'failed'
  ));

CREATE TABLE IF NOT EXISTS channel_execution_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  event_id uuid NOT NULL,
  step_key text NOT NULL
    CONSTRAINT channel_execution_steps_step_key_check
    CHECK (btrim(step_key) <> ''),
  kind text NOT NULL
    CONSTRAINT channel_execution_steps_kind_check
    CHECK (
      kind IN (
        'llm', 'search', 'tool', 'persist_reply',
        'schedule', 'delivery'
      )
    ),
  request_hash text NOT NULL
    CONSTRAINT channel_execution_steps_request_hash_check
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL
    CONSTRAINT channel_execution_steps_status_check
    CHECK (status IN ('started', 'completed', 'failed', 'ambiguous')),
  output jsonb
    CONSTRAINT channel_execution_steps_output_size_check
    CHECK (output IS NULL OR pg_column_size(output) <= 65536),
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT channel_execution_steps_user_agent_fkey
    FOREIGN KEY (user_id, agent_id)
    REFERENCES digital_agents(user_id, id)
    ON DELETE CASCADE,
  CONSTRAINT channel_execution_steps_event_scope_fkey
    FOREIGN KEY (event_id, user_id, agent_id)
    REFERENCES channel_inbound_events(id, user_id, agent_id)
    ON DELETE CASCADE,
  UNIQUE (event_id, step_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_message_attachments_scope_identity
  ON message_attachments(id, user_id, agent_id);

CREATE TABLE IF NOT EXISTS channel_event_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  event_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  external_attachment_id text NOT NULL
    CONSTRAINT channel_event_attachments_external_id_check
    CHECK (btrim(external_attachment_id) <> ''),
  file_name text,
  declared_mime_type text,
  declared_size_bytes bigint
    CONSTRAINT channel_event_attachments_declared_size_check
    CHECK (declared_size_bytes IS NULL OR declared_size_bytes > 0),
  source_locator_ciphertext bytea
    CONSTRAINT channel_event_attachments_locator_ciphertext_check
    CHECK (octet_length(source_locator_ciphertext) > 0),
  source_locator_nonce bytea
    CONSTRAINT channel_event_attachments_locator_nonce_check
    CHECK (octet_length(source_locator_nonce) = 12),
  source_locator_auth_tag bytea
    CONSTRAINT channel_event_attachments_locator_auth_tag_check
    CHECK (octet_length(source_locator_auth_tag) = 16),
  source_locator_key_version integer
    CONSTRAINT channel_event_attachments_locator_key_version_check
    CHECK (source_locator_key_version > 0),
  locator_expires_at timestamptz NOT NULL,
  locator_cleared_at timestamptz,
  private_attachment_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_event_attachments_locator_state_check
    CHECK (
      (
        locator_cleared_at IS NULL
        AND source_locator_ciphertext IS NOT NULL
        AND source_locator_nonce IS NOT NULL
        AND source_locator_auth_tag IS NOT NULL
        AND source_locator_key_version IS NOT NULL
      )
      OR (
        locator_cleared_at IS NOT NULL
        AND source_locator_ciphertext IS NULL
        AND source_locator_nonce IS NULL
        AND source_locator_auth_tag IS NULL
        AND source_locator_key_version IS NULL
      )
    ),
  CONSTRAINT channel_event_attachments_user_agent_fkey
    FOREIGN KEY (user_id, agent_id)
    REFERENCES digital_agents(user_id, id)
    ON DELETE CASCADE,
  CONSTRAINT channel_event_attachments_event_scope_fkey
    FOREIGN KEY (event_id, user_id, agent_id)
    REFERENCES channel_inbound_events(id, user_id, agent_id)
    ON DELETE CASCADE,
  CONSTRAINT channel_event_attachments_connection_scope_fkey
    FOREIGN KEY (connection_id, user_id, agent_id)
    REFERENCES channel_connections(id, user_id, agent_id)
    ON DELETE CASCADE,
  CONSTRAINT channel_event_attachments_private_scope_fkey
    FOREIGN KEY (private_attachment_id, user_id, agent_id)
    REFERENCES message_attachments(id, user_id, agent_id)
    ON DELETE SET NULL (private_attachment_id),
  UNIQUE (event_id, external_attachment_id)
);

ALTER TABLE IF EXISTS channel_event_attachments
  ADD COLUMN IF NOT EXISTS connection_id uuid;

UPDATE channel_event_attachments AS attachment
SET connection_id = event.connection_id
FROM channel_inbound_events AS event
WHERE attachment.connection_id IS NULL
  AND event.id = attachment.event_id
  AND event.user_id = attachment.user_id
  AND event.agent_id = attachment.agent_id;

DO $channel_event_attachment_locator_migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM channel_event_attachments
    WHERE connection_id IS NULL
  ) THEN
    RAISE EXCEPTION 'channel_attachment_connection_backfill_failed'
      USING ERRCODE = '23502';
  END IF;

  ALTER TABLE channel_event_attachments
    ALTER COLUMN connection_id SET NOT NULL,
    ALTER COLUMN source_locator_ciphertext DROP NOT NULL,
    ALTER COLUMN source_locator_nonce DROP NOT NULL,
    ALTER COLUMN source_locator_auth_tag DROP NOT NULL,
    ALTER COLUMN source_locator_key_version DROP NOT NULL;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'channel_event_attachments'::regclass
      AND conname =
        'channel_event_attachments_locator_state_check'
  ) THEN
    ALTER TABLE channel_event_attachments
      ADD CONSTRAINT
        channel_event_attachments_locator_state_check
      CHECK (
        (
          locator_cleared_at IS NULL
          AND source_locator_ciphertext IS NOT NULL
          AND source_locator_nonce IS NOT NULL
          AND source_locator_auth_tag IS NOT NULL
          AND source_locator_key_version IS NOT NULL
        )
        OR (
          locator_cleared_at IS NOT NULL
          AND source_locator_ciphertext IS NULL
          AND source_locator_nonce IS NULL
          AND source_locator_auth_tag IS NULL
          AND source_locator_key_version IS NULL
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'channel_event_attachments'::regclass
      AND conname =
        'channel_event_attachments_connection_scope_fkey'
  ) THEN
    ALTER TABLE channel_event_attachments
      ADD CONSTRAINT
        channel_event_attachments_connection_scope_fkey
      FOREIGN KEY (connection_id, user_id, agent_id)
      REFERENCES channel_connections(id, user_id, agent_id)
      ON DELETE CASCADE;
  END IF;
END
$channel_event_attachment_locator_migration$;

CREATE TABLE IF NOT EXISTS channel_reply_handles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  event_id uuid NOT NULL,
  public_fields jsonb NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT channel_reply_handles_public_fields_check
    CHECK (
      jsonb_typeof(public_fields) = 'object'
      AND pg_column_size(public_fields) <= 65536
    ),
  secret_ciphertext bytea NOT NULL
    CONSTRAINT channel_reply_handles_secret_ciphertext_check
    CHECK (octet_length(secret_ciphertext) > 0),
  secret_nonce bytea NOT NULL
    CONSTRAINT channel_reply_handles_secret_nonce_check
    CHECK (octet_length(secret_nonce) = 12),
  secret_auth_tag bytea NOT NULL
    CONSTRAINT channel_reply_handles_secret_auth_tag_check
    CHECK (octet_length(secret_auth_tag) = 16),
  key_version integer NOT NULL
    CONSTRAINT channel_reply_handles_key_version_check
    CHECK (key_version > 0),
  expires_at timestamptz,
  invalidated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_reply_handles_user_agent_fkey
    FOREIGN KEY (user_id, agent_id)
    REFERENCES digital_agents(user_id, id)
    ON DELETE CASCADE,
  CONSTRAINT channel_reply_handles_event_scope_fkey
    FOREIGN KEY (event_id, user_id, agent_id)
    REFERENCES channel_inbound_events(id, user_id, agent_id)
    ON DELETE CASCADE,
  UNIQUE (id, user_id, agent_id),
  UNIQUE (event_id)
);

ALTER TABLE IF EXISTS channel_reply_handles
  ADD COLUMN IF NOT EXISTS invalidated_at timestamptz;

CREATE TABLE IF NOT EXISTS channel_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  event_id uuid,
  source_task_id uuid,
  connection_id uuid NOT NULL,
  assistant_message_id uuid NOT NULL,
  reply_handle_id uuid,
  body text NOT NULL
    CONSTRAINT channel_deliveries_body_size_check
    CHECK (octet_length(body) <= 1048576),
  recipient jsonb NOT NULL
    CONSTRAINT channel_deliveries_recipient_check
    CHECK (
      jsonb_typeof(recipient) = 'object'
      AND pg_column_size(recipient) <= 65536
    ),
  status text NOT NULL DEFAULT 'queued'
    CONSTRAINT channel_deliveries_status_check
    CHECK (
      status IN (
        'queued', 'running', 'retry', 'waiting_node',
        'sent', 'dead_letter', 'cancelled'
      )
    ),
  claim_owner text,
  claim_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0
    CONSTRAINT channel_deliveries_attempts_check
    CHECK (attempts >= 0),
  attempt_cycle_baseline integer NOT NULL DEFAULT 0
    CONSTRAINT channel_deliveries_attempt_cycle_check
    CHECK (
      attempt_cycle_baseline >= 0
      AND attempt_cycle_baseline <= attempts
    ),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error_code text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_deliveries_claim_state_check
    CHECK (
      (status = 'running'
        AND claim_owner IS NOT NULL
        AND claim_expires_at IS NOT NULL)
      OR status <> 'running'
    ),
  CONSTRAINT channel_deliveries_source_check
    CHECK (num_nonnulls(event_id, source_task_id) = 1),
  CONSTRAINT channel_deliveries_user_agent_fkey
    FOREIGN KEY (user_id, agent_id)
    REFERENCES digital_agents(user_id, id)
    ON DELETE CASCADE,
  CONSTRAINT channel_deliveries_event_scope_fkey
    FOREIGN KEY (event_id, user_id, agent_id)
    REFERENCES channel_inbound_events(id, user_id, agent_id)
    ON DELETE CASCADE,
  CONSTRAINT channel_deliveries_source_task_scope_fkey
    FOREIGN KEY (source_task_id, user_id, agent_id)
    REFERENCES proactive_tasks(id, user_id, agent_id)
    ON DELETE CASCADE,
  CONSTRAINT channel_deliveries_connection_scope_fkey
    FOREIGN KEY (connection_id, user_id, agent_id)
    REFERENCES channel_connections(id, user_id, agent_id)
    ON DELETE CASCADE,
  CONSTRAINT channel_deliveries_message_scope_fkey
    FOREIGN KEY (assistant_message_id, user_id, agent_id)
    REFERENCES messages(id, user_id, agent_id)
    ON DELETE CASCADE,
  CONSTRAINT channel_deliveries_reply_handle_scope_fkey
    FOREIGN KEY (reply_handle_id, user_id, agent_id)
    REFERENCES channel_reply_handles(id, user_id, agent_id)
    ON DELETE SET NULL (reply_handle_id),
  UNIQUE (id, user_id, agent_id),
  UNIQUE (event_id),
  UNIQUE (connection_id, assistant_message_id)
);

ALTER TABLE IF EXISTS channel_deliveries
  ADD COLUMN IF NOT EXISTS
    attempt_cycle_baseline integer NOT NULL DEFAULT 0;

ALTER TABLE IF EXISTS channel_deliveries
  ADD COLUMN IF NOT EXISTS source_task_id uuid;

ALTER TABLE IF EXISTS channel_deliveries
  ADD COLUMN IF NOT EXISTS frozen_segments jsonb;

DO $channel_deliveries_frozen_segments_constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname =
      'channel_deliveries_frozen_segments_check'
  ) THEN
    ALTER TABLE channel_deliveries
      ADD CONSTRAINT
        channel_deliveries_frozen_segments_check
      CHECK (
        frozen_segments IS NULL
        OR (
          jsonb_typeof(frozen_segments) = 'array'
          AND pg_column_size(frozen_segments) <= 2097152
        )
      );
  END IF;
END
$channel_deliveries_frozen_segments_constraint$;

ALTER TABLE IF EXISTS channel_deliveries
  ALTER COLUMN event_id DROP NOT NULL;

DO $channel_delivery_source_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'channel_deliveries'::regclass
      AND conname = 'channel_deliveries_source_check'
  ) THEN
    ALTER TABLE channel_deliveries
      ADD CONSTRAINT channel_deliveries_source_check
      CHECK (num_nonnulls(event_id, source_task_id) = 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'channel_deliveries'::regclass
      AND conname = 'channel_deliveries_source_task_scope_fkey'
  ) THEN
    ALTER TABLE channel_deliveries
      ADD CONSTRAINT channel_deliveries_source_task_scope_fkey
      FOREIGN KEY (source_task_id, user_id, agent_id)
      REFERENCES proactive_tasks(id, user_id, agent_id)
      ON DELETE CASCADE;
  END IF;
END
$channel_delivery_source_constraints$;

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_channel_deliveries_source_task
  ON channel_deliveries(source_task_id)
  WHERE source_task_id IS NOT NULL;

DO $channel_delivery_attempt_cycle_constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'channel_deliveries'::regclass
      AND conname = 'channel_deliveries_attempt_cycle_check'
  ) THEN
    ALTER TABLE channel_deliveries
      ADD CONSTRAINT channel_deliveries_attempt_cycle_check
      CHECK (
        attempt_cycle_baseline >= 0
        AND attempt_cycle_baseline <= attempts
      );
  END IF;
END
$channel_delivery_attempt_cycle_constraint$;

CREATE TABLE IF NOT EXISTS channel_delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  attempt_no integer NOT NULL
    CONSTRAINT channel_delivery_attempts_attempt_no_check
    CHECK (attempt_no > 0),
  segment_no integer NOT NULL DEFAULT 1
    CONSTRAINT channel_delivery_attempts_segment_no_check
    CHECK (segment_no > 0),
  status text NOT NULL
    CONSTRAINT channel_delivery_attempts_status_check
    CHECK (status IN ('started', 'sent', 'retryable', 'failed')),
  platform_result jsonb
    CONSTRAINT channel_delivery_attempts_result_size_check
    CHECK (
      platform_result IS NULL
      OR pg_column_size(platform_result) <= 65536
    ),
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT channel_delivery_attempts_user_agent_fkey
    FOREIGN KEY (user_id, agent_id)
    REFERENCES digital_agents(user_id, id)
    ON DELETE CASCADE,
  CONSTRAINT channel_delivery_attempts_delivery_scope_fkey
    FOREIGN KEY (delivery_id, user_id, agent_id)
    REFERENCES channel_deliveries(id, user_id, agent_id)
    ON DELETE CASCADE,
  UNIQUE (delivery_id, attempt_no, segment_no)
);

CREATE TABLE IF NOT EXISTS channel_access_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  chat_type text NOT NULL
    CONSTRAINT channel_access_rules_chat_type_check
    CHECK (chat_type IN ('direct', 'group')),
  target_kind text NOT NULL
    CONSTRAINT channel_access_rules_target_kind_check
    CHECK (target_kind IN ('sender', 'conversation')),
  target_id text NOT NULL
    CONSTRAINT channel_access_rules_target_id_check
    CHECK (btrim(target_id) <> ''),
  effect text NOT NULL
    CONSTRAINT channel_access_rules_effect_check
    CHECK (effect IN ('allow', 'deny')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_access_rules_user_agent_fkey
    FOREIGN KEY (user_id, agent_id)
    REFERENCES digital_agents(user_id, id)
    ON DELETE CASCADE,
  CONSTRAINT channel_access_rules_connection_scope_fkey
    FOREIGN KEY (connection_id, user_id, agent_id)
    REFERENCES channel_connections(id, user_id, agent_id)
    ON DELETE CASCADE,
  UNIQUE (
    connection_id, chat_type, target_kind, target_id
  )
);

ALTER TABLE IF EXISTS channel_access_rules
  ADD COLUMN IF NOT EXISTS remark text NOT NULL DEFAULT '';
ALTER TABLE IF EXISTS channel_access_rules
  ADD COLUMN IF NOT EXISTS username text NOT NULL DEFAULT '';
ALTER TABLE IF EXISTS channel_access_rules
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
ALTER TABLE IF EXISTS channel_access_rules
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS channel_access_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  event_id uuid NOT NULL,
  chat_type text NOT NULL
    CONSTRAINT channel_access_requests_chat_type_check
    CHECK (chat_type IN ('direct', 'group')),
  external_sender_id text NOT NULL
    CONSTRAINT channel_access_requests_sender_check
    CHECK (btrim(external_sender_id) <> ''),
  external_conversation_id text NOT NULL
    CONSTRAINT channel_access_requests_conversation_check
    CHECK (btrim(external_conversation_id) <> ''),
  status text NOT NULL DEFAULT 'pending'
    CONSTRAINT channel_access_requests_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT channel_access_requests_user_agent_fkey
    FOREIGN KEY (user_id, agent_id)
    REFERENCES digital_agents(user_id, id)
    ON DELETE CASCADE,
  CONSTRAINT channel_access_requests_connection_scope_fkey
    FOREIGN KEY (connection_id, user_id, agent_id)
    REFERENCES channel_connections(id, user_id, agent_id)
    ON DELETE CASCADE,
  CONSTRAINT channel_access_requests_event_scope_fkey
    FOREIGN KEY (event_id, user_id, agent_id)
    REFERENCES channel_inbound_events(id, user_id, agent_id)
    ON DELETE CASCADE,
  UNIQUE (event_id)
);

ALTER TABLE IF EXISTS channel_access_requests
  ADD COLUMN IF NOT EXISTS remark text NOT NULL DEFAULT '';
ALTER TABLE IF EXISTS channel_access_requests
  ADD COLUMN IF NOT EXISTS username text NOT NULL DEFAULT '';
ALTER TABLE IF EXISTS channel_access_requests
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
ALTER TABLE IF EXISTS channel_access_requests
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_access_requests_pending
  ON channel_access_requests(
    connection_id, chat_type, external_sender_id,
    external_conversation_id
  )
  WHERE status = 'pending';

ALTER TABLE IF EXISTS skill_revisions
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS channel_node_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  node_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  sequence bigint NOT NULL
    CONSTRAINT channel_node_outbox_sequence_check
    CHECK (sequence > 0),
  frame jsonb NOT NULL
    CONSTRAINT channel_node_outbox_frame_check
    CHECK (
      jsonb_typeof(frame) = 'object'
      AND pg_column_size(frame) <= 1048576
    ),
  size_bytes integer NOT NULL
    CONSTRAINT channel_node_outbox_size_check
    CHECK (size_bytes > 0 AND size_bytes <= 1048576),
  status text NOT NULL DEFAULT 'pending'
    CONSTRAINT channel_node_outbox_status_check
    CHECK (status IN ('pending', 'sent', 'failed', 'expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT channel_node_outbox_user_agent_fkey
    FOREIGN KEY (user_id, agent_id)
    REFERENCES digital_agents(user_id, id)
    ON DELETE CASCADE,
  CONSTRAINT channel_node_outbox_node_scope_fkey
    FOREIGN KEY (node_id, user_id, agent_id)
    REFERENCES channel_runtime_nodes(id, user_id, agent_id)
    ON DELETE CASCADE,
  CONSTRAINT channel_node_outbox_connection_scope_fkey
    FOREIGN KEY (connection_id, user_id, agent_id)
    REFERENCES channel_connections(id, user_id, agent_id)
    ON DELETE CASCADE,
  CONSTRAINT channel_node_outbox_delivery_scope_fkey
    FOREIGN KEY (delivery_id, user_id, agent_id)
    REFERENCES channel_deliveries(id, user_id, agent_id)
    ON DELETE CASCADE,
  UNIQUE (node_id, sequence),
  UNIQUE (delivery_id)
);

ALTER TABLE channel_node_outbox
  DROP CONSTRAINT IF EXISTS
    channel_node_outbox_node_scope_fkey;
ALTER TABLE channel_node_outbox
  ADD CONSTRAINT channel_node_outbox_node_scope_fkey
  FOREIGN KEY (node_id, user_id, agent_id)
  REFERENCES channel_runtime_nodes(id, user_id, agent_id)
  ON DELETE CASCADE;

UPDATE channel_runtime_nodes AS node
SET last_server_sequence = GREATEST(
      node.last_server_sequence,
      existing.last_sequence
    )
FROM (
  SELECT node_id, MAX(sequence) AS last_sequence
  FROM channel_node_outbox
  GROUP BY node_id
) AS existing
WHERE node.id = existing.node_id
  AND node.last_server_sequence < existing.last_sequence;

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

CREATE TABLE IF NOT EXISTS admin_inbox_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  source_type text NOT NULL
    CONSTRAINT admin_inbox_states_source_type_check
    CHECK (btrim(source_type) <> ''),
  source_id text NOT NULL
    CONSTRAINT admin_inbox_states_source_id_check
    CHECK (btrim(source_id) <> ''),
  read_at timestamptz,
  dismissed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_inbox_states_user_agent_fkey
    FOREIGN KEY (user_id, agent_id)
    REFERENCES digital_agents(user_id, id)
    ON DELETE CASCADE,
  UNIQUE (user_id, agent_id, source_type, source_id)
);

CREATE INDEX IF NOT EXISTS idx_admin_inbox_states_scope
  ON admin_inbox_states(user_id, agent_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_channel_connections_scope_type_active
  ON channel_connections(user_id, agent_id, channel_type, created_at)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_channel_connections_scope_health
  ON channel_connections(user_id, agent_id, health_status)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_channel_inbound_events_claimable
  ON channel_inbound_events(status, claim_expires_at, received_at)
  WHERE status IN ('accepted', 'running');
CREATE INDEX IF NOT EXISTS idx_channel_inbound_events_scope_received
  ON channel_inbound_events(
    user_id, agent_id, connection_id, received_at DESC
  );
CREATE INDEX IF NOT EXISTS idx_channel_deliveries_claimable
  ON channel_deliveries(status, next_attempt_at, claim_expires_at)
  WHERE status IN ('queued', 'retry', 'running');
CREATE INDEX IF NOT EXISTS idx_channel_deliveries_scope_created
  ON channel_deliveries(user_id, agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_channel_runtime_nodes_heartbeat
  ON channel_runtime_nodes(status, last_heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_channel_node_inbound_receipts_connection
  ON channel_node_inbound_receipts(connection_id);
CREATE INDEX IF NOT EXISTS idx_channel_node_outbox_pending
  ON channel_node_outbox(node_id, sequence)
  WHERE status = 'pending';
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
