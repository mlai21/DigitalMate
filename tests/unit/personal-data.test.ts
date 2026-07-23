import { mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPersonalDataExport } from "@/server/admin/personal-data";
import { createRepositories } from "@/server/db/repositories";
import { deleteArtifactTree, writeArtifactFile } from "@/server/tasks/artifacts";

const roots: string[] = [];

describe("personal data helpers", () => {
  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await deleteArtifactTree(root, "user-1");
    }
  });

  it("wraps exported tables with ownership and timestamp metadata", () => {
    const exportedAt = new Date("2026-07-05T10:00:00+08:00");

    expect(
      buildPersonalDataExport({
        userId: "user-1",
        exportedAt,
        tables: {
          conversations: [{ id: "c1", user_id: "user-1" }],
          messages: [{ id: "m1", user_id: "user-1" }],
        },
      }),
    ).toEqual({
      userId: "user-1",
      exportedAt: exportedAt.toISOString(),
      tables: {
        conversations: [{ id: "c1", user_id: "user-1" }],
        messages: [{ id: "m1", user_id: "user-1" }],
      },
    });
  });

  it("deletes stored task artifacts for one user", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "digitalmate-artifacts-"));
    roots.push(root);
    const artifact = await writeArtifactFile({
      root,
      userId: "user-1",
      taskRunId: "task-1",
      fileName: "report.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("ok"),
    });

    await deleteArtifactTree(root, "user-1");

    await expect(stat(path.join(root, artifact.storagePath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("exports only explicit allow-listed fields and strips internal capability data recursively", async () => {
    const safeRow = {
      id: "attachment-1",
      user_id: "user-1",
      agent_id: "agent-1",
      message_id: "message-1",
      kind: "document",
      file_name: "notes.md",
      mime_type: "text/markdown",
      size_bytes: 12,
      text_truncated: false,
      status: "bound",
      error_code: null,
      created_at: new Date("2026-07-14T00:00:00Z"),
      updated_at: new Date("2026-07-14T00:00:00Z"),
      metadata: {
        label: "合法元数据",
        token: "SENTINEL_TOKEN_VALUE",
        nested: {
          reply_secret: "SENTINEL_REPLY_VALUE",
          replyToken: "SENTINEL_CAMEL_REPLY_VALUE",
          pollCursor: "SENTINEL_CAMEL_POLL_VALUE",
          temporaryPath: "SENTINEL_CAMEL_TEMPORARY_VALUE",
          authTag: "SENTINEL_CAMEL_AUTH_TAG_VALUE",
        },
      },
      raw_payload: { poll_token: "SENTINEL_RAW_VALUE" },
      storage_path: "SENTINEL_ARTIFACT_PATH",
      storage_key: "SENTINEL_ATTACHMENT_KEY",
      extracted_text: "SENTINEL_EXTRACTED_TEXT",
      secret: "SENTINEL_SECRET_VALUE",
      ciphertext: "SENTINEL_CIPHERTEXT_VALUE",
      nonce: "SENTINEL_NONCE_VALUE",
      auth_tag: "SENTINEL_AUTH_TAG_VALUE",
      temporary_path: "SENTINEL_TEMPORARY_VALUE",
    };
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      void params;
      return { rows: [safeRow] };
    });
    const repositories = createRepositories({ query } as unknown as Pool);

    const exported = await repositories.personalData.export("user-1");

    expect(exported.tables.message_attachments).toEqual([
      expect.objectContaining({
        id: "attachment-1",
        user_id: "user-1",
        agent_id: "agent-1",
        file_name: "notes.md",
      }),
    ]);
    const serialized = JSON.stringify(exported);
    for (const forbidden of [
      "raw_payload",
      "storage_path",
      "storage_key",
      "extracted_text",
      "secret",
      "ciphertext",
      "nonce",
      "auth_tag",
      "\"token\":",
      "temporary_path",
      "reply_secret",
      "replyToken",
      "poll_token",
      "pollCursor",
      "temporaryPath",
      "authTag",
      "SENTINEL_",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).toContain("agent_id");
    expect(serialized).toContain("合法元数据");
    for (const [statement] of query.mock.calls) {
      expect(String(statement)).not.toMatch(/\bSELECT\s+\*/i);
      expect(String(statement)).not.toMatch(/\b\w+\.\*/i);
    }
  });

  it("lists only the requested user's attachment storage keys before clearing rows", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      void sql;
      void params;
      return { rows: [{ storage_key: "owned-key" }] };
    });
    const repositories = createRepositories({ query } as unknown as Pool);

    await expect(repositories.personalData.listAttachmentStorageKeys("user-1")).resolves.toEqual(["owned-key"]);

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("FROM message_attachments");
    expect(sql).toContain("WHERE user_id = $1");
    expect(params).toEqual(["user-1"]);
  });

  it("clears unbound attachment rows as well as message-bound attachments", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      void params;
      if (sql.includes("SELECT id") && sql.includes("FROM digital_agents")) {
        return { rows: [{ id: "agent-default" }] };
      }
      return { rows: [] };
    });
    const repositories = createRepositories({
      connect: vi.fn(async () => ({ query, release: vi.fn() })),
    } as unknown as Pool);

    await repositories.personalData.clear("user-1");

    const attachmentDelete = query.mock.calls.find(([sql]) =>
      String(sql).includes("DELETE FROM message_attachments"),
    );
    expect(attachmentDelete?.[1]).toEqual(["user-1"]);
  });

  it("exports agent identities, settings, grants, and agent-scoped goal steps", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      void sql;
      void params;
      return { rows: [] };
    });
    const repositories = createRepositories({ query } as unknown as Pool);

    await repositories.personalData.export("user-1");

    const sql = query.mock.calls.map(([statement]) => String(statement));
    expect(sql.some((statement) =>
      statement.includes("FROM digital_agents") && statement.includes("id, user_id"),
    )).toBe(true);
    expect(sql.some((statement) =>
      statement.includes("FROM agent_settings") && statement.includes("agent_id"),
    )).toBe(true);
    expect(sql.some((statement) =>
      statement.includes("FROM agent_resource_grants") && statement.includes("agent_id"),
    )).toBe(true);
    expect(sql.some((statement) =>
      statement.includes("FROM goal_steps") && statement.includes("goals.user_id = $1"),
    )).toBe(true);
  });

  it("clears and normalizes agent identity inside one database transaction", async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT id") && sql.includes("FROM digital_agents")) {
        return { rows: [{ id: "agent-default" }] };
      }
      return { rows: [] };
    });
    const release = vi.fn();
    const connect = vi.fn(async () => ({ query: clientQuery, release }));
    const repositories = createRepositories({ connect } as unknown as Pool);

    await repositories.personalData.clear("user-1");

    const sql = clientQuery.mock.calls.map(([statement]) => String(statement));
    expect(sql[0]).toBe("BEGIN");
    expect(sql.at(-1)).toBe("COMMIT");
    expect(sql).toContain("DELETE FROM agent_resource_grants WHERE user_id = $1");
    expect(sql.some((statement) =>
      statement.includes("DELETE FROM digital_agents")
      && statement.includes("id <> $2"),
    )).toBe(true);
    expect(sql.some((statement) =>
      statement.includes("UPDATE digital_agents")
      && statement.includes("slug = 'digitalmate'")
      && statement.includes("display_name = 'DigitalMate'")
      && statement.includes("status = 'active'")
      && statement.includes("is_default = true")
      && statement.includes("inherits_user_resources = true"),
    )).toBe(true);
    expect(sql.some((statement) =>
      statement.includes("agent_settings")
      && statement.includes("model_routing_override = '{}'::jsonb"),
    )).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rolls back the complete database clear when any statement fails", async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.includes("DELETE FROM messages")) throw new Error("delete_failed");
      if (sql.includes("SELECT id") && sql.includes("FROM digital_agents")) {
        return { rows: [{ id: "agent-default" }] };
      }
      return { rows: [] };
    });
    const release = vi.fn();
    const repositories = createRepositories({
      connect: vi.fn(async () => ({ query: clientQuery, release })),
    } as unknown as Pool);

    await expect(repositories.personalData.clear("user-1")).rejects.toThrow("delete_failed");

    const sql = clientQuery.mock.calls.map(([statement]) => String(statement));
    expect(sql).toContain("ROLLBACK");
    expect(sql).not.toContain("COMMIT");
    expect(release).toHaveBeenCalledTimes(1);
  });
});
