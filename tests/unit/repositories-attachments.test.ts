import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ATTACHMENT_LIMITS } from "@/server/attachments/types";
import { createRepositories } from "@/server/db/repositories";

const createdAt = new Date("2026-07-14T00:00:00Z");
const USER_1 = "00000000-0000-4000-8000-000000000001";
const USER_2 = "00000000-0000-4000-8000-000000000002";
const CONVERSATION_1 = "10000000-0000-4000-8000-000000000001";
const MESSAGE_1 = "20000000-0000-4000-8000-000000000001";
const OLD_MESSAGE = "20000000-0000-4000-8000-000000000002";
const ATTACHMENT_1 = "30000000-0000-4000-8000-000000000001";
const ATTACHMENT_2 = "30000000-0000-4000-8000-000000000002";

function attachmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ATTACHMENT_1,
    user_id: USER_1,
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
    id: MESSAGE_1,
    user_id: USER_1,
    conversation_id: CONVERSATION_1,
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
        userId: USER_1,
        kind: "document",
        fileName: "notes.md",
        mimeType: "text/markdown",
        sizeBytes: 12,
        storageKey: "storage-1",
        extractedText: "hello",
      }),
    ).resolves.toMatchObject({
      id: ATTACHMENT_1,
      userId: USER_1,
      messageId: null,
      fileName: "notes.md",
      storageKey: "storage-1",
      status: "ready",
    });

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("INSERT INTO message_attachments");
    expect(params).toEqual([
      USER_1,
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

    await expect(repositories.messageAttachments.getForUser(USER_1, ATTACHMENT_1)).resolves.toMatchObject({
      id: ATTACHMENT_1,
      userId: USER_1,
    });

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("WHERE user_id = $1 AND id = $2");
    expect(params).toEqual([USER_1, ATTACHMENT_1]);
  });

  it("lists attachments for user-owned message ids in one query", async () => {
    const query = vi.fn(async () => ({ rows: [attachmentRow({ message_id: MESSAGE_1, status: "bound" })] }));
    const repositories = createRepositories(createPool(query));

    await expect(repositories.messageAttachments.listForMessages(USER_1, [MESSAGE_1])).resolves.toHaveLength(1);

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("user_id = $1");
    expect(sql).toContain("message_id = ANY($2::uuid[])");
    expect(params).toEqual([USER_1, [MESSAGE_1]]);
  });

  it("does not query when no message ids are requested", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const repositories = createRepositories(createPool(query));

    await expect(repositories.messageAttachments.listForMessages(USER_1, [])).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("deletes and marks failed only unbound drafts owned by the user", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const repositories = createRepositories(createPool(query));

    await repositories.messageAttachments.deleteDraft(USER_1, ATTACHMENT_1);
    await repositories.messageAttachments.markFailed(USER_1, ATTACHMENT_2, "attachment_parse_failed");

    const [deleteSql, deleteParams] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(deleteSql).toContain("DELETE FROM message_attachments");
    expect(deleteSql).toContain("user_id = $1 AND id = $2 AND message_id IS NULL");
    expect(deleteParams).toEqual([USER_1, ATTACHMENT_1]);

    const [failedSql, failedParams] = query.mock.calls[1] as unknown as [string, unknown[]];
    expect(failedSql).toContain("status = 'failed'");
    expect(failedSql).toContain("message_id IS NULL");
    expect(failedSql).toContain("status IN ('pending', 'ready', 'failed')");
    expect(failedParams).toEqual([USER_1, ATTACHMENT_2, "attachment_parse_failed"]);
  });

  it("atomically claims expired ready or failed drafts for deletion", async () => {
    const query = vi.fn(async () => ({ rows: [attachmentRow({ status: "deleting" })] }));
    const repositories = createRepositories(createPool(query));

    await expect(repositories.messageAttachments.claimExpiredDrafts(24)).resolves.toEqual([
      expect.objectContaining({ id: ATTACHMENT_1, status: "deleting" }),
    ]);

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("WITH candidates AS");
    expect(sql).toContain("message_id IS NULL");
    expect(sql).toContain("status IN ('ready', 'failed')");
    expect(sql).toContain("created_at < now() - ($1 * interval '1 hour')");
    expect(sql).toContain("ORDER BY id");
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("SET status = 'deleting'");
    expect(sql).toContain("RETURNING attachment.*");
    expect(sql).toContain("LIMIT $2");
    expect(params).toEqual([24, 100]);
  });

  it("caps the deletion claim batch size at one hundred", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const repositories = createRepositories(createPool(query));

    await repositories.messageAttachments.claimExpiredDrafts(24, 1_000);

    const [, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(params).toEqual([24, 100]);
  });

  it("releases a deletion claim back to failed only for its owning unbound draft", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const repositories = createRepositories(createPool(query));

    await repositories.messageAttachments.releaseDeletionClaim(USER_1, ATTACHMENT_1, "attachment_cleanup_failed");

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("SET status = 'failed'");
    expect(sql).toContain("user_id = $1 AND id = $2");
    expect(sql).toContain("message_id IS NULL AND status = 'deleting'");
    expect(params).toEqual([USER_1, ATTACHMENT_1, "attachment_cleanup_failed"]);
  });

  it.each([
    [Number.NaN, 100],
    [Number.POSITIVE_INFINITY, 100],
    [24.5, 100],
    [24, Number.NaN],
    [24, Number.POSITIVE_INFINITY],
    [24, 1.5],
  ])("rejects unsafe expiry claim parameters hours=%s limit=%s", async (hours, limit) => {
    const query = vi.fn(async () => ({ rows: [] }));
    const repositories = createRepositories(createPool(query));

    await expect(repositories.messageAttachments.claimExpiredDrafts(hours, limit)).rejects.toThrow(
      "invalid_attachment_claim_limit",
    );
    expect(query).not.toHaveBeenCalled();
  });
});

describe("messages.createWithAttachments", () => {
  it("locks ready drafts, creates one user message, binds attachments and commits on the same client", async () => {
    const readyRows = [
      attachmentRow(),
      attachmentRow({
        id: ATTACHMENT_2,
        storage_key: "storage-2",
        size_bytes: 20,
      }),
    ];
    const boundRows = readyRows.map((row) => ({ ...row, message_id: MESSAGE_1, status: "bound" }));
    const query = vi.fn(async (sql: unknown) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "COMMIT") return { rows: [] };
      if (text.includes("FROM conversations")) return { rows: [{ id: CONVERSATION_1 }] };
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
        userId: USER_1,
        conversationId: CONVERSATION_1,
        content: "请看附件",
        attachmentIds: [ATTACHMENT_1, ATTACHMENT_2],
      }),
    ).resolves.toMatchObject({
      message: { id: MESSAGE_1, role: "user" },
      attachments: [
        { id: ATTACHMENT_1, messageId: MESSAGE_1, status: "bound" },
        { id: ATTACHMENT_2, messageId: MESSAGE_1, status: "bound" },
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
    const [, lockParams] = query.mock.calls[2] as unknown as [unknown, unknown[]];
    expect(lockSql).toContain("user_id = $2");
    expect(lockSql).toContain("ORDER BY id");
    expect(lockSql).toContain("FOR UPDATE");
    expect(lockParams).toEqual([[ATTACHMENT_1, ATTACHMENT_2], USER_1]);
    const bindSql = String(query.mock.calls[4]?.[0]);
    expect(bindSql).toContain("status = 'ready'");
    expect(bindSql).toContain("message_id IS NULL");
  });

  it.each([
    ["another user's", attachmentRow({ user_id: USER_2 })],
    ["failed", attachmentRow({ status: "failed", error_code: "attachment_parse_failed" })],
    ["already bound", attachmentRow({ status: "bound", message_id: OLD_MESSAGE })],
    ["claimed for deletion", attachmentRow({ status: "deleting" })],
  ])("rolls back before message creation for %s attachment", async (_label, invalidRow) => {
    const query = vi.fn(async (sql: unknown) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "ROLLBACK") return { rows: [] };
      if (text.includes("FROM conversations")) return { rows: [{ id: CONVERSATION_1 }] };
      if (text.includes("SELECT * FROM message_attachments")) return { rows: [invalidRow] };
      throw new Error(`unexpected query: ${text}`);
    });
    const { pool, release } = createTransactionalPool(query);
    const repositories = createRepositories(pool);

    await expect(
      repositories.messages.createWithAttachments({
        userId: USER_1,
        conversationId: CONVERSATION_1,
        content: "请看附件",
        attachmentIds: [ATTACHMENT_1],
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
        userId: USER_1,
        conversationId: CONVERSATION_1,
        content: "太多附件",
        attachmentIds: Array.from(
          { length: ATTACHMENT_LIMITS.maxCount + 1 },
          (_, index) => `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        ),
      }),
    ).rejects.toThrow("attachment_count_exceeded");

    expect(query.mock.calls.map(([sql]) => String(sql))).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("rolls back when ready attachment bytes exceed the per-message limit", async () => {
    const query = vi.fn(async (sql: unknown) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "ROLLBACK") return { rows: [] };
      if (text.includes("FROM conversations")) return { rows: [{ id: CONVERSATION_1 }] };
      if (text.includes("SELECT * FROM message_attachments")) {
        return { rows: [attachmentRow({ size_bytes: ATTACHMENT_LIMITS.maxMessageBytes + 1 })] };
      }
      throw new Error(`unexpected query: ${text}`);
    });
    const { pool } = createTransactionalPool(query);
    const repositories = createRepositories(pool);

    await expect(
      repositories.messages.createWithAttachments({
        userId: USER_1,
        conversationId: CONVERSATION_1,
        content: "文件太大",
        attachmentIds: [ATTACHMENT_1],
      }),
    ).rejects.toThrow("attachment_total_size_exceeded");

    expect(query.mock.calls.map(([sql]) => String(sql))).toEqual([
      "BEGIN",
      expect.stringContaining("FROM conversations"),
      expect.stringContaining("SELECT * FROM message_attachments"),
      "ROLLBACK",
    ]);
  });

  it("rolls back duplicate attachment ids before taking row locks", async () => {
    const query = vi.fn(async (sql: unknown) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "ROLLBACK") return { rows: [] };
      throw new Error(`unexpected query: ${text}`);
    });
    const { pool } = createTransactionalPool(query);
    const repositories = createRepositories(pool);

    await expect(
      repositories.messages.createWithAttachments({
        userId: USER_1,
        conversationId: CONVERSATION_1,
        content: "重复附件",
        attachmentIds: [ATTACHMENT_1, ATTACHMENT_1],
      }),
    ).rejects.toThrow("attachment_not_bindable");

    expect(query.mock.calls.map(([sql]) => String(sql))).toEqual(["BEGIN", "ROLLBACK"]);
  });
});

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("message attachment PostgreSQL concurrency", () => {
  const schemaName = `attachment_repository_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let databasePool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: TEST_DATABASE_URL });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    databasePool = new Pool({
      connectionString: TEST_DATABASE_URL,
      options: `-c search_path=${schemaName} -c statement_timeout=5000 -c lock_timeout=3000`,
    });
    await databasePool.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY
      );
      CREATE TABLE conversations (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE messages (
        id uuid PRIMARY KEY DEFAULT (md5(random()::text || clock_timestamp()::text)::uuid),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role text NOT NULL,
        content text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE message_attachments (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message_id uuid REFERENCES messages(id) ON DELETE CASCADE,
        kind text NOT NULL,
        file_name text NOT NULL,
        mime_type text NOT NULL,
        size_bytes integer NOT NULL,
        storage_key text NOT NULL UNIQUE,
        extracted_text text,
        text_truncated boolean NOT NULL DEFAULT false,
        status text NOT NULL CHECK (status IN ('pending', 'ready', 'failed', 'deleting', 'bound')),
        error_code text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  });

  afterAll(async () => {
    await databasePool?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await adminPool.end();
    }
  });

  async function seedConversation(userId: string, conversationId: string): Promise<void> {
    await databasePool.query("INSERT INTO users (id) VALUES ($1)", [userId]);
    await databasePool.query("INSERT INTO conversations (id, user_id) VALUES ($1, $2)", [conversationId, userId]);
  }

  async function seedAttachment(input: {
    id: string;
    userId: string;
    storageKey: string;
    createdAt?: Date;
  }): Promise<void> {
    await databasePool.query(
      `INSERT INTO message_attachments
       (id, user_id, kind, file_name, mime_type, size_bytes, storage_key, status, created_at, updated_at)
       VALUES ($1, $2, 'document', 'notes.md', 'text/markdown', 12, $3, 'ready', $4, $4)`,
      [input.id, input.userId, input.storageKey, input.createdAt ?? new Date()],
    );
  }

  it("allows only one message transaction to bind the same ready attachment", async () => {
    const userId = "40000000-0000-4000-8000-000000000001";
    const conversationId = "41000000-0000-4000-8000-000000000001";
    const attachmentId = "42000000-0000-4000-8000-000000000001";
    await seedConversation(userId, conversationId);
    await seedAttachment({ id: attachmentId, userId, storageKey: "pg-race-one" });
    const repositories = createRepositories(databasePool);

    const results = await Promise.allSettled([
      repositories.messages.createWithAttachments({
        userId,
        conversationId,
        content: "first",
        attachmentIds: [attachmentId],
      }),
      repositories.messages.createWithAttachments({
        userId,
        conversationId,
        content: "second",
        attachmentIds: [attachmentId],
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: expect.objectContaining({ message: "attachment_not_bindable" }) });
    const messageCount = await databasePool.query<{ count: string }>(
      "SELECT count(*) AS count FROM messages WHERE conversation_id = $1",
      [conversationId],
    );
    expect(Number(messageCount.rows[0].count)).toBe(1);
  });

  it("uses a stable row lock order for reverse attachment arrays", async () => {
    const userId = "40000000-0000-4000-8000-000000000002";
    const conversationId = "41000000-0000-4000-8000-000000000002";
    const lowerId = "42000000-0000-4000-8000-000000000010";
    const higherId = "42000000-0000-4000-8000-000000000011";
    await seedConversation(userId, conversationId);
    await seedAttachment({ id: lowerId, userId, storageKey: "pg-lock-lower" });
    await seedAttachment({ id: higherId, userId, storageKey: "pg-lock-higher" });
    const repositories = createRepositories(databasePool);

    const results = await Promise.allSettled([
      repositories.messages.createWithAttachments({
        userId,
        conversationId,
        content: "ascending",
        attachmentIds: [lowerId, higherId],
      }),
      repositories.messages.createWithAttachments({
        userId,
        conversationId,
        content: "descending",
        attachmentIds: [higherId, lowerId],
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: expect.objectContaining({ message: "attachment_not_bindable" }) });
  });

  it("makes an expired deletion claim and message binding mutually exclusive", async () => {
    const userId = "40000000-0000-4000-8000-000000000003";
    const conversationId = "41000000-0000-4000-8000-000000000003";
    const attachmentId = "42000000-0000-4000-8000-000000000020";
    await seedConversation(userId, conversationId);
    await seedAttachment({
      id: attachmentId,
      userId,
      storageKey: "pg-claim-bind",
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });
    const repositories = createRepositories(databasePool);

    const [claimResult, bindResult] = await Promise.allSettled([
      repositories.messageAttachments.claimExpiredDrafts(24, 1),
      repositories.messages.createWithAttachments({
        userId,
        conversationId,
        content: "bind while cleanup starts",
        attachmentIds: [attachmentId],
      }),
    ]);

    expect(claimResult.status).toBe("fulfilled");
    if (claimResult.status !== "fulfilled") return;
    const bindSucceeded = bindResult.status === "fulfilled";
    expect(claimResult.value.length + Number(bindSucceeded)).toBe(1);
    if (!bindSucceeded) {
      expect(bindResult).toMatchObject({ reason: expect.objectContaining({ message: "attachment_not_bindable" }) });
    }
    const stored = await databasePool.query<{ status: string; message_id: string | null }>(
      "SELECT status, message_id FROM message_attachments WHERE id = $1",
      [attachmentId],
    );
    expect(stored.rows[0].status).toBe(bindSucceeded ? "bound" : "deleting");
    expect(Boolean(stored.rows[0].message_id)).toBe(bindSucceeded);
  });
});
