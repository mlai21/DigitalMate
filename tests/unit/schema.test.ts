import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const AGENT_SCOPED_TABLES = [
  "projects",
  "conversations",
  "messages",
  "message_attachments",
  "conversation_summaries",
  "memory_entries",
  "tool_call_logs",
  "proactive_tasks",
  "channel_identities",
  "channel_messages",
  "interjection_decisions",
  "reflections",
  "skill_usage_logs",
  "task_runs",
  "task_artifacts",
  "llm_usage_logs",
  "memory_jobs",
  "goals",
  "goal_steps",
] as const;

describe("database schema", () => {
  it("defines P0 business tables with user ownership", async () => {
    const schema = await readFile(path.join(process.cwd(), "src/server/db/schema.sql"), "utf8");

    for (const table of [
      "users",
      "conversations",
      "messages",
      "message_attachments",
      "conversation_summaries",
      "memory_entries",
      "tool_call_logs",
      "proactive_tasks",
      "channel_identities",
      "channel_messages",
      "interjection_decisions",
      "reflections",
      "skills",
      "task_runs",
      "task_artifacts",
      "tool_registrations",
      "llm_usage_logs",
      "settings",
    ]) {
      expect(schema).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }

    expect(schema).toContain("CREATE EXTENSION IF NOT EXISTS vector");
    const attachmentTable = schema.match(
      /CREATE TABLE IF NOT EXISTS message_attachments \([\s\S]*?\n\);/,
    )?.[0];
    expect(attachmentTable).toBeDefined();
    expect(attachmentTable).toContain("user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE");
    expect(attachmentTable).toContain("message_id uuid REFERENCES messages(id) ON DELETE CASCADE");
    expect(attachmentTable).toContain("CONSTRAINT message_attachments_status_check");
    expect(attachmentTable).toContain("CONSTRAINT message_attachments_binding_check");
    expect(attachmentTable).toContain("deletion_claim_token uuid");
    expect(attachmentTable).toContain("'pending', 'ready', 'failed', 'deleting', 'bound'");
    const statusMigration = schema.match(
      /DO \$message_attachments_status\$[\s\S]*?\$message_attachments_status\$;/,
    )?.[0];
    expect(statusMigration).toBeDefined();
    expect(statusMigration).toContain("pg_get_constraintdef");
    expect(statusMigration).toContain("IF current_definition IS NULL THEN");
    expect(statusMigration).toContain("ELSIF position('deleting' IN current_definition) = 0 THEN");
    expect(statusMigration).toContain("DROP CONSTRAINT message_attachments_status_check");
    expect(schema).toMatch(
      /ALTER TABLE IF EXISTS message_attachments\s+ADD COLUMN IF NOT EXISTS deletion_claim_token uuid/,
    );
    expect(schema).toContain("idx_message_attachments_message");
    expect(schema).toContain("idx_message_attachments_stale");
    expect(schema).toMatch(/memory_entries[\s\S]+user_id uuid NOT NULL/);
    expect(schema).toMatch(/conversation_summaries[\s\S]+conversation_id uuid NOT NULL/);
    expect(schema).toContain("idx_memory_entries_embedding");
    expect(schema).toContain("embedding vector_cosine_ops");
    expect(schema).toMatch(/tool_call_logs[\s\S]+user_id uuid NOT NULL/);
    expect(schema).toMatch(/channel_identities[\s\S]+user_id uuid NOT NULL/);
    expect(schema).toMatch(/skills[\s\S]+status text NOT NULL/);
    expect(schema).toMatch(/tool_registrations[\s\S]+status text NOT NULL DEFAULT 'pending'/);
    expect(schema).toMatch(/tool_registrations[\s\S]+kind text NOT NULL DEFAULT 'script'/);
    expect(schema).toMatch(/tool_registrations[\s\S]+mcp_tool_name text/);
    expect(schema).toMatch(/llm_usage_logs[\s\S]+total_tokens integer NOT NULL/);
    expect(schema).toMatch(/proactive_tasks[\s\S]+'share'/);
    expect(schema).toContain("source_task_id uuid REFERENCES proactive_tasks(id) ON DELETE SET NULL");
    expect(schema).toContain("CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_source_task");
  });

  it("defines goal mode tables for the loop ledger (P3-1)", async () => {
    const schema = await readFile(path.join(process.cwd(), "src/server/db/schema.sql"), "utf8");

    expect(schema).toContain("CREATE TABLE IF NOT EXISTS goals");
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS goal_steps");
    expect(schema).toMatch(/goals[\s\S]+user_id uuid NOT NULL/);
    expect(schema).toMatch(
      /goals[\s\S]+CHECK \(status IN \('draft', 'confirmed', 'running', 'paused', 'needs_human', 'succeeded', 'failed_budget', 'failed_no_progress', 'cancelled'\)\)/,
    );
    expect(schema).toMatch(/goal_steps[\s\S]+goal_id uuid NOT NULL REFERENCES goals\(id\) ON DELETE CASCADE/);
    expect(schema).toMatch(/goal_steps[\s\S]+CHECK \(phase IN \('collecting', 'drafting', 'verifying', 'committed', 'failed'\)\)/);
    expect(schema).toContain("ALTER TABLE IF EXISTS tool_call_logs ADD COLUMN IF NOT EXISTS goal_id uuid REFERENCES goals(id)");
    expect(schema).toContain("CREATE INDEX IF NOT EXISTS idx_goals_due ON goals(next_run_at) WHERE status = 'running'");
    expect(schema).toContain("idx_goal_steps_goal");
  });

  it("defines the default digital agent boundary for every agent-scoped table", async () => {
    const schema = await readFile(path.join(process.cwd(), "src/server/db/schema.sql"), "utf8");

    expect(schema).toContain("CREATE TABLE IF NOT EXISTS digital_agents");
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS agent_resource_grants");
    expect(schema).toContain("idx_digital_agents_one_default");
    expect(schema).toContain("UNIQUE (user_id, id)");
    expect(schema).toContain("-- BEGIN DEFAULT DIGITAL AGENT MIGRATION");

    for (const table of AGENT_SCOPED_TABLES) {
      expect(schema).toContain(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS agent_id uuid`);
    }

    expect(schema).toContain("idx_messages_client_turn_agent_role");
    expect(schema).toContain("ON messages(user_id, agent_id, client_turn_id, role)");
    expect(schema).toContain("idx_channel_identities_agent_external_user");
    expect(schema).toContain("idx_channel_messages_agent_external_message");
    expect(schema.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_turn_agent_role")).toBeLessThan(
      schema.indexOf("DROP INDEX IF EXISTS idx_messages_client_turn_role"),
    );
    expect(schema.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_identities_agent_external_user")).toBeLessThan(
      schema.indexOf("DROP CONSTRAINT IF EXISTS channel_identities_channel_external_user_id_key"),
    );
  });

  it("seeds the default agent before the default conversation without a future repository API", async () => {
    const seed = await readFile(path.join(process.cwd(), "src/server/db/seed.ts"), "utf8");

    expect(seed).toContain("INSERT INTO digital_agents");
    expect(seed).toContain("ON CONFLICT (user_id, slug)");
    expect(seed).toContain("INSERT INTO conversations (user_id, agent_id, title)");
    expect(seed.indexOf("INSERT INTO digital_agents")).toBeLessThan(seed.indexOf("INSERT INTO conversations"));
    expect(seed).not.toContain("repositories.agents");
    expect(seed).not.toContain("getOrCreateDefault(user.id)");
  });
});
