import { mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPersonalDataExport } from "@/server/admin/personal-data";
import { createRepositories } from "@/server/db/repositories";
import { createChannelSecretsKey } from "@/server/security/encrypted-secret";
import { deleteArtifactTree, writeArtifactFile } from "@/server/tasks/artifacts";

const roots: string[] = [];
const USER_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_ID = "10000000-0000-4000-8000-000000000011";
const CONNECTION_ID = "10000000-0000-4000-8000-000000000021";
const KEY_STATE = createChannelSecretsKey(
  Buffer.alloc(32, 31).toString("base64"),
);

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

  it("recursively removes internal channel payload fields from the final export", () => {
    const exported = buildPersonalDataExport({
      userId: USER_ID,
      exportedAt: new Date("2026-07-25T00:00:00Z"),
      tables: {
        channel_connections: [{
          id: CONNECTION_ID,
          user_id: USER_ID,
          agent_id: AGENT_ID,
          config: {
            endpoint: "https://example.test/hook",
            nested: {
              poll_token: "SENTINEL_POLL_TOKEN",
              temporary_url: "https://temporary.invalid/reply",
              raw_payload: { event: "SENTINEL_RAW_PAYLOAD" },
              provider_payload: "SENTINEL_PROVIDER_PAYLOAD",
              internal_path: "/private/channel/runtime",
            },
          },
        }],
      },
    });

    expect(exported.tables.channel_connections).toEqual([
      expect.objectContaining({
        agent_id: AGENT_ID,
        config: {
          endpoint: "https://example.test/hook",
          nested: {},
        },
      }),
    ]);
    expect(JSON.stringify(exported)).not.toMatch(
      /poll_token|temporary_url|raw_payload|provider_payload|internal_path|SENTINEL_/,
    );
  });

  it("fails closed when an allowed export value repeats a channel credential", () => {
    expect(() =>
      buildPersonalDataExport({
        userId: USER_ID,
        exportedAt: new Date("2026-07-25T00:00:00Z"),
        tables: {
          channel_connections: [{
            id: CONNECTION_ID,
            user_id: USER_ID,
            agent_id: AGENT_ID,
            config: {
              endpoint: "https://example.test/hook?token=long-export-secret",
            },
          }],
        },
        credentialValues: ["long-export-secret"],
      }),
    ).toThrow("personal_data_export_failed");
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
        poll_interval: 30,
        replyStyle: "温暖简洁",
        token: "SENTINEL_TOKEN_VALUE",
        nested: {
          reply_secret: "SENTINEL_REPLY_VALUE",
          replyToken: "SENTINEL_CAMEL_REPLY_VALUE",
          pollCursor: "SENTINEL_CAMEL_POLL_VALUE",
          temporaryPath: "SENTINEL_CAMEL_TEMPORARY_VALUE",
          authTag: "SENTINEL_CAMEL_AUTH_TAG_VALUE",
        },
        nestedArray: [{
          apiKey: "SENTINEL_API_KEY_VALUE",
          password: "SENTINEL_PASSWORD_VALUE",
          credentials: "SENTINEL_CREDENTIALS_VALUE",
          private_key: "SENTINEL_PRIVATE_KEY_VALUE",
          "access-key": "SENTINEL_ACCESS_KEY_VALUE",
          storageKey: "SENTINEL_STORAGE_KEY_VALUE",
          storage_path: "SENTINEL_STORAGE_PATH_VALUE",
          extractedText: "SENTINEL_NESTED_EXTRACTED_TEXT_VALUE",
          "reply-token": "SENTINEL_REPLY_TOKEN_VALUE",
          poll_cursor: "SENTINEL_POLL_CURSOR_VALUE",
          "temporary-path": "SENTINEL_TEMPORARY_PATH_VALUE",
          pollInterval: 60,
          reply_style: "自然",
        }],
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
      if (
        sql === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
        || sql === "COMMIT"
        || sql === "ROLLBACK"
        || sql.includes("FROM channel_secrets")
      ) {
        return { rows: [] };
      }
      return { rows: [safeRow] };
    });
    const repositories = createRepositories({
      query,
      connect: vi.fn(async () => ({ query, release: vi.fn() })),
    } as unknown as Pool);

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
    expect(exported.tables.task_runs).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          poll_interval: 30,
          replyStyle: "温暖简洁",
          nestedArray: [{
            pollInterval: 60,
            reply_style: "自然",
          }],
        }),
      }),
    ]);
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
    const repositories = createRepositories({
      query,
      connect: vi.fn(async () => ({ query, release: vi.fn() })),
    } as unknown as Pool);

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
    const repositories = createRepositories({
      query,
      connect: vi.fn(async () => ({ query, release: vi.fn() })),
    } as unknown as Pool);

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

  it("exports explicit channel and admin audit allow-lists without secret material", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("$1")) expect(params).toEqual([USER_ID]);
      if (
        sql === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
        || sql === "COMMIT"
        || sql === "ROLLBACK"
      ) {
        return { rows: [] };
      }
      if (sql.includes("FROM channel_connections") && !sql.includes("JOIN channel_connections")) {
        return {
          rows: [{
            id: CONNECTION_ID,
            user_id: USER_ID,
            agent_id: AGENT_ID,
            channel_type: "telegram",
            display_name: "Telegram",
            enabled: false,
            config: {
              allow_from: ["owner"],
              nested: {
                poll_token: "SENTINEL_POLL_TOKEN",
                temporary_url: "https://temporary.invalid",
              },
            },
            revision: 3,
            health_status: "disabled",
            health_detail: { code: "manually_disabled" },
            created_at: new Date("2026-07-25T00:00:00Z"),
            updated_at: new Date("2026-07-25T00:00:00Z"),
            runtime_node_id: "SENTINEL_RUNTIME_NODE",
            deleted_at: new Date("2026-07-25T00:00:00Z"),
            ciphertext: "SENTINEL_CIPHERTEXT",
          }],
        };
      }
      if (sql.includes("FROM admin_audit_logs")) {
        return {
          rows: [{
            id: "10000000-0000-4000-8000-000000000031",
            user_id: USER_ID,
            agent_id: AGENT_ID,
            action: "channel_connection.update",
            resource_type: "channel_connection",
            resource_id: CONNECTION_ID,
            before_summary: {
              enabled: false,
              nested: { bot_token: "SENTINEL_AUDIT_TOKEN" },
            },
            after_summary: { enabled: false },
            confirmation_source: {
              type: "console",
              poll_token: "SENTINEL_CONFIRMATION_TOKEN",
            },
            status: "success",
            error_code: null,
            created_at: new Date("2026-07-25T00:00:00Z"),
          }],
        };
      }
      if (sql.includes("FROM channel_secrets")) return { rows: [] };
      return { rows: [] };
    });
    const release = vi.fn();
    const pool = {
      query,
      connect: vi.fn(async () => ({ query, release })),
    } as unknown as Pool;
    const repositories = createRepositories(pool);

    const exported = await repositories.personalData.export(USER_ID);

    expect(exported.tables.channel_connections).toEqual([
      {
        id: CONNECTION_ID,
        user_id: USER_ID,
        agent_id: AGENT_ID,
        channel_type: "telegram",
        display_name: "Telegram",
        enabled: false,
        config: {
          allow_from: ["owner"],
          nested: {},
        },
        revision: 3,
        health_status: "disabled",
        health_detail: { code: "manually_disabled" },
        created_at: new Date("2026-07-25T00:00:00Z"),
        updated_at: new Date("2026-07-25T00:00:00Z"),
      },
    ]);
    expect(exported.tables.admin_audit_logs).toEqual([
      expect.objectContaining({
        user_id: USER_ID,
        agent_id: AGENT_ID,
        before_summary: { enabled: false, nested: {} },
        confirmation_source: { type: "console" },
      }),
    ]);
    const serialized = JSON.stringify(exported);
    expect(serialized).not.toMatch(
      /channel_secrets|ciphertext|nonce|auth_tag|key_version|SENTINEL_|poll_token|temporary_url|runtime_node_id|deleted_at/,
    );
    for (const [statement] of query.mock.calls) {
      expect(String(statement)).not.toMatch(/\bSELECT\s+\*/i);
      expect(String(statement)).not.toMatch(/\b\w+\.\*/i);
    }
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("decrypts owned channel secrets only for a fail-closed export scan", async () => {
    if (KEY_STATE.status !== "ready") throw new Error("test_key_not_ready");
    const plaintext = "long-export-secret";
    const encrypted = KEY_STATE.key.encrypt(plaintext, {
      userId: USER_ID,
      agentId: AGENT_ID,
      connectionId: CONNECTION_ID,
      fieldName: "bot_token",
    }).toStorageRecord();
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM channel_connections") && !sql.includes("JOIN channel_connections")) {
        return {
          rows: [{
            id: CONNECTION_ID,
            user_id: USER_ID,
            agent_id: AGENT_ID,
            channel_type: "telegram",
            display_name: "Telegram",
            enabled: false,
            config: {
              endpoint: `https://example.test/hook?token=${plaintext}`,
            },
            revision: 1,
            health_status: "disabled",
            health_detail: {},
            created_at: new Date("2026-07-25T00:00:00Z"),
            updated_at: new Date("2026-07-25T00:00:00Z"),
          }],
        };
      }
      if (sql.includes("FROM channel_secrets")) {
        return {
          rows: [{
            connection_id: CONNECTION_ID,
            field_name: "bot_token",
            ciphertext: encrypted.ciphertext,
            nonce: encrypted.nonce,
            auth_tag: encrypted.authTag,
            key_version: encrypted.keyVersion,
            user_id: USER_ID,
            agent_id: AGENT_ID,
          }],
        };
      }
      return { rows: [] };
    });
    const release = vi.fn();
    const repositories = createRepositories({
      query,
      connect: vi.fn(async () => ({ query, release })),
    } as unknown as Pool);

    await expect(
      repositories.personalData.export(USER_ID),
    ).rejects.toThrow("personal_data_export_failed");
    await expect(
      repositories.personalData.export(USER_ID, KEY_STATE.key),
    ).rejects.toThrow("personal_data_export_failed");

    const secretQuery = query.mock.calls.find(([sql]) =>
      String(sql).includes("FROM channel_secrets"),
    );
    expect(String(secretQuery?.[0])).toContain("JOIN channel_connections");
    expect(String(secretQuery?.[0])).toContain("channel_connections.user_id = $1");
    expect(release).toHaveBeenCalledTimes(2);
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
    const secretDelete = sql.findIndex((statement) =>
      statement.includes("DELETE FROM channel_secrets")
      && statement.includes("channel_connections")
      && statement.includes("user_id = $1"),
    );
    const connectionDelete = sql.findIndex((statement) =>
      statement.includes("DELETE FROM channel_connections")
      && statement.includes("user_id = $1"),
    );
    const auditDelete = sql.findIndex((statement) =>
      statement.includes("DELETE FROM admin_audit_logs")
      && statement.includes("user_id = $1"),
    );
    expect(secretDelete).toBeGreaterThan(0);
    expect(connectionDelete).toBeGreaterThan(secretDelete);
    expect(auditDelete).toBeGreaterThan(0);
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
