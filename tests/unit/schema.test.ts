import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
    expect(attachmentTable).toContain("'pending', 'ready', 'failed', 'deleting', 'bound'");
    const statusMigration = schema.match(
      /DO \$message_attachments_status\$[\s\S]*?\$message_attachments_status\$;/,
    )?.[0];
    expect(statusMigration).toBeDefined();
    expect(statusMigration).toContain("pg_get_constraintdef");
    expect(statusMigration).toContain("IF current_definition IS NULL THEN");
    expect(statusMigration).toContain("ELSIF position('deleting' IN current_definition) = 0 THEN");
    expect(statusMigration).toContain("DROP CONSTRAINT message_attachments_status_check");
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
});
