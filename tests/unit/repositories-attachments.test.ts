import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { ATTACHMENT_LIMITS } from "@/server/attachments/types";
import { createRepositories } from "@/server/db/repositories";

const createdAt = new Date("2026-07-14T00:00:00Z");

function attachmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "attachment-1",
    user_id: "user-1",
    message_id: null,
    kind: "document",
    file_name: "notes.md",
    mime_type: "text/markdown",
    size_bytes: 12,
    storage_key: "storage-1",
    extracted_text: "hello",
    text_truncated: false,
    status: "ready",
    error_code: null,
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides,
  };
}

function messageRow() {
  return {
    id: "message-1",
    user_id: "user-1",
    conversation_id: "conversation-1",
    role: "user",
    content: "请看附件",
    created_at: createdAt,
  };
}

function createPool(query: ReturnType<typeof vi.fn>) {
  return { query } as unknown as Pool;
}

function createTransactionalPool(query: ReturnType<typeof vi.fn>) {
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const connect = vi.fn(async () => client);
  return {
    pool: { connect } as unknown as Pool,
    connect,
    release,
  };
}

describe("message attachments repository", () => {
  it("creates a ready attachment draft and maps private metadata", async () => {
    const query = vi.fn(async () => ({ rows: [attachmentRow()] }));
    const repositories = createRepositories(createPool(query));

    await expect(
      repositories.messageAttachments.createDraft({
        userId: "user-1",
        kind: "document",
        fileName: "notes.md",
        mimeType: "text/markdown",
        sizeBytes: 12,
        storageKey: "storage-1",
        extractedText: "hello",
      }),
    ).resolves.toMatchObject({
      id: "attachment-1",
      userId: "user-1",
      messageId: null,
      fileName: "notes.md",
      storageKey: "storage-1",
      status: "ready",
    });

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("INSERT INTO message_attachments");
    expect(params).toEqual([
      "user-1",
      "document",
      "notes.md",
      "text/markdown",
      12,
      "storage-1",
      "hello",
      false,
    ]);
  });

  it("only reads an attachment through its owning user", async () => {
    const query = vi.fn(async () => ({ rows: [attachmentRow()] }));
    const repositories = createRepositories(createPool(query));

    await expect(repositories.messageAttachments.getForUser("user-1", "attachment-1")).resolves.toMatchObject({
      id: "attachment-1",
      userId: "user-1",
    });

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("WHERE user_id = $1 AND id = $2");
    expect(params).toEqual(["user-1", "attachment-1"]);
  });

  it("lists attachments for user-owned message ids in one query", async () => {
    const query = vi.fn(async () => ({ rows: [attachmentRow({ message_id: "message-1", status: "bound" })] }));
    const repositories = createRepositories(createPool(query));

    await expect(repositories.messageAttachments.listForMessages("user-1", ["message-1"])).resolves.toHaveLength(1);

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("user_id = $1");
    expect(sql).toContain("message_id = ANY($2::uuid[])");
    expect(params).toEqual(["user-1", ["message-1"]]);
  });

  it("deletes and marks failed only unbound drafts owned by the user", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const repositories = createRepositories(createPool(query));

    await repositories.messageAttachments.deleteDraft("user-1", "attachment-1");
    await repositories.messageAttachments.markFailed("user-1", "attachment-2", "attachment_parse_failed");

    const [deleteSql, deleteParams] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(deleteSql).toContain("DELETE FROM message_attachments");
    expect(deleteSql).toContain("user_id = $1 AND id = $2 AND message_id IS NULL");
    expect(deleteParams).toEqual(["user-1", "attachment-1"]);

    const [failedSql, failedParams] = query.mock.calls[1] as unknown as [string, unknown[]];
    expect(failedSql).toContain("status = 'failed'");
    expect(failedSql).toContain("message_id IS NULL");
    expect(failedParams).toEqual(["user-1", "attachment-2", "attachment_parse_failed"]);
  });

  it("lists only ready or failed unbound drafts older than the requested lifetime", async () => {
    const query = vi.fn(async () => ({ rows: [attachmentRow()] }));
    const repositories = createRepositories(createPool(query));

    await expect(repositories.messageAttachments.listExpiredDrafts(24)).resolves.toHaveLength(1);

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("message_id IS NULL");
    expect(sql).toContain("status IN ('ready', 'failed')");
    expect(sql).toContain("created_at < now() - ($1 * interval '1 hour')");
    expect(sql).toContain("LIMIT $2");
    expect(params).toEqual([24, 100]);
  });
});

describe("messages.createWithAttachments", () => {
  it("locks ready drafts, creates one user message, binds attachments and commits on the same client", async () => {
    const readyRows = [
      attachmentRow(),
      attachmentRow({
        id: "attachment-2",
        storage_key: "storage-2",
        size_bytes: 20,
      }),
    ];
    const boundRows = readyRows.map((row) => ({ ...row, message_id: "message-1", status: "bound" }));
    const query = vi.fn(async (sql: unknown) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "COMMIT") return { rows: [] };
      if (text.includes("FROM conversations")) return { rows: [{ id: "conversation-1" }] };
      if (text.includes("SELECT * FROM message_attachments")) return { rows: readyRows };
      if (text.includes("INSERT INTO messages")) return { rows: [messageRow()] };
      if (text.includes("UPDATE message_attachments")) return { rows: boundRows };
      if (text.includes("UPDATE conversations")) return { rows: [] };
      throw new Error(`unexpected query: ${text}`);
    });
    const { pool, connect, release } = createTransactionalPool(query);
    const repositories = createRepositories(pool);

    await expect(
      repositories.messages.createWithAttachments({
        userId: "user-1",
        conversationId: "conversation-1",
        content: "请看附件",
        attachmentIds: ["attachment-1", "attachment-2"],
      }),
    ).resolves.toMatchObject({
      message: { id: "message-1", role: "user" },
      attachments: [
        { id: "attachment-1", messageId: "message-1", status: "bound" },
        { id: "attachment-2", messageId: "message-1", status: "bound" },
      ],
    });

    expect(connect).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(query.mock.calls.map(([sql]) => String(sql))).toEqual([
      "BEGIN",
      expect.stringContaining("FROM conversations"),
      expect.stringContaining("SELECT * FROM message_attachments"),
      expect.stringContaining("INSERT INTO messages"),
      expect.stringContaining("UPDATE message_attachments"),
      expect.stringContaining("UPDATE conversations"),
      "COMMIT",
    ]);

    const lockSql = String(query.mock.calls[2]?.[0]);
    expect(lockSql).toContain("FOR UPDATE");
    const bindSql = String(query.mock.calls[4]?.[0]);
    expect(bindSql).toContain("status = 'ready'");
    expect(bindSql).toContain("message_id IS NULL");
  });

  it.each([
    ["another user's", attachmentRow({ user_id: "user-2" })],
    ["failed", attachmentRow({ status: "failed", error_code: "attachment_parse_failed" })],
    ["already bound", attachmentRow({ status: "bound", message_id: "old-message" })],
  ])("rolls back before message creation for %s attachment", async (_label, invalidRow) => {
    const query = vi.fn(async (sql: unknown) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "ROLLBACK") return { rows: [] };
      if (text.includes("FROM conversations")) return { rows: [{ id: "conversation-1" }] };
      if (text.includes("SELECT * FROM message_attachments")) return { rows: [invalidRow] };
      throw new Error(`unexpected query: ${text}`);
    });
    const { pool, release } = createTransactionalPool(query);
    const repositories = createRepositories(pool);

    await expect(
      repositories.messages.createWithAttachments({
        userId: "user-1",
        conversationId: "conversation-1",
        content: "请看附件",
        attachmentIds: ["attachment-1"],
      }),
    ).rejects.toThrow("attachment_not_bindable");

    expect(query.mock.calls.map(([sql]) => String(sql))).toEqual([
      "BEGIN",
      expect.stringContaining("FROM conversations"),
      expect.stringContaining("SELECT * FROM message_attachments"),
      "ROLLBACK",
    ]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("rolls back when the attachment count exceeds the per-message limit", async () => {
    const query = vi.fn(async (sql: unknown) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "ROLLBACK") return { rows: [] };
      throw new Error(`unexpected query: ${text}`);
    });
    const { pool } = createTransactionalPool(query);
    const repositories = createRepositories(pool);

    await expect(
      repositories.messages.createWithAttachments({
        userId: "user-1",
        conversationId: "conversation-1",
        content: "太多附件",
        attachmentIds: Array.from({ length: ATTACHMENT_LIMITS.maxCount + 1 }, (_, index) => `attachment-${index}`),
      }),
    ).rejects.toThrow("attachment_count_exceeded");

    expect(query.mock.calls.map(([sql]) => String(sql))).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("rolls back when ready attachment bytes exceed the per-message limit", async () => {
    const query = vi.fn(async (sql: unknown) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "ROLLBACK") return { rows: [] };
      if (text.includes("FROM conversations")) return { rows: [{ id: "conversation-1" }] };
      if (text.includes("SELECT * FROM message_attachments")) {
        return { rows: [attachmentRow({ size_bytes: ATTACHMENT_LIMITS.maxMessageBytes + 1 })] };
      }
      throw new Error(`unexpected query: ${text}`);
    });
    const { pool } = createTransactionalPool(query);
    const repositories = createRepositories(pool);

    await expect(
      repositories.messages.createWithAttachments({
        userId: "user-1",
        conversationId: "conversation-1",
        content: "文件太大",
        attachmentIds: ["attachment-1"],
      }),
    ).rejects.toThrow("attachment_total_size_exceeded");

    expect(query.mock.calls.map(([sql]) => String(sql))).toEqual([
      "BEGIN",
      expect.stringContaining("FROM conversations"),
      expect.stringContaining("SELECT * FROM message_attachments"),
      "ROLLBACK",
    ]);
  });
});
