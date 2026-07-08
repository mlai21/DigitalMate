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
  });
});
