import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ATTACHMENT_LIMITS } from "@/server/attachments/types";
import { cleanupStaleAttachments } from "@/server/attachments/cleanup";
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
    deletion_claim_token: null,
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
  it("creates a pending attachment draft before private storage publication", async () => {
    const query = vi.fn(async () => ({ rows: [attachmentRow({ status: "pending" })] }));
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
      status: "pending",
    });

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("INSERT INTO message_attachments");
    expect(sql).toContain("'pending'");
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

  it("marks only an owned pending draft ready after storage publication", async () => {
    const query = vi.fn(async () => ({ rows: [attachmentRow()] }));
    const repositories = createRepositories(createPool(query));

    await expect(
      repositories.messageAttachments.markReady(USER_1, ATTACHMENT_1),
    ).resolves.toMatchObject({ id: ATTACHMENT_1, status: "ready" });

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("SET status = 'ready'");
    expect(sql).toContain("message_id IS NULL AND status = 'pending'");
    expect(sql).toContain("deletion_claim_token = NULL");
    expect(params).toEqual([USER_1, ATTACHMENT_1]);
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
    expect(sql).toContain("ORDER BY created_at ASC, id ASC");
    expect(params).toEqual([USER_1, [MESSAGE_1]]);
  });

  it("does not query when no message ids are requested", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const repositories = createRepositories(createPool(query));

    await expect(repositories.messageAttachments.listForMessages(USER_1, [])).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("lists only storage keys that still have attachment rows", async () => {
    const query = vi.fn(async () => ({ rows: [{ storage_key: "stored-key" }] }));
    const repositories = createRepositories(createPool(query));

    await expect(
      repositories.messageAttachments.listExistingStorageKeys(["stored-key", "orphan-key"]),
    ).resolves.toEqual(["stored-key"]);

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("storage_key = ANY($1::text[])");
    expect(params).toEqual([["stored-key", "orphan-key"]]);
  });

  it("atomically fences one owned unbound draft for interactive deletion", async () => {
    const claimToken = "50000000-0000-4000-8000-000000000001";
    const query = vi.fn(async () => ({
      rows: [attachmentRow({ status: "deleting", deletion_claim_token: claimToken })],
    }));
    const repositories = createRepositories(createPool(query));

    await expect(
      repositories.messageAttachments.claimDraftForDeletion(USER_1, ATTACHMENT_1),
    ).resolves.toMatchObject({
      id: ATTACHMENT_1,
      userId: USER_1,
      messageId: null,
      status: "deleting",
      deletionClaimToken: claimToken,
    });

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("UPDATE message_attachments");
    expect(sql).toContain("SET status = 'deleting'");
    expect(sql).toContain("deletion_claim_token = gen_random_uuid()");
    expect(sql).toContain("user_id = $1 AND id = $2");
    expect(sql).toContain("message_id IS NULL AND status IN ('ready', 'failed', 'deleting')");
    expect(sql).toContain("RETURNING *");
    expect(params).toEqual([USER_1, ATTACHMENT_1]);
  });

  it("deletes only the matching fenced claim and marks upload drafts failed", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const repositories = createRepositories(createPool(query));
    const claimToken = "50000000-0000-4000-8000-000000000001";

    await repositories.messageAttachments.deleteDraft(USER_1, ATTACHMENT_1, claimToken);
    await repositories.messageAttachments.markFailed(USER_1, ATTACHMENT_2, "attachment_parse_failed");

    const [deleteSql, deleteParams] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(deleteSql).toContain("DELETE FROM message_attachments");
    expect(deleteSql).toContain("user_id = $1 AND id = $2");
    expect(deleteSql).toContain("status = 'deleting'");
    expect(deleteSql).toContain("deletion_claim_token = $3");
    expect(deleteParams).toEqual([USER_1, ATTACHMENT_1, claimToken]);

    const [failedSql, failedParams] = query.mock.calls[1] as unknown as [string, unknown[]];
    expect(failedSql).toContain("status = 'failed'");
    expect(failedSql).toContain("message_id IS NULL");
    expect(failedSql).toContain("status IN ('pending', 'ready', 'failed')");
    expect(failedParams).toEqual([USER_1, ATTACHMENT_2, "attachment_parse_failed"]);
  });

  it("atomically claims expired drafts with leases, retry backoff and fair ordering", async () => {
    const query = vi.fn(async () => ({ rows: [attachmentRow({ status: "deleting" })] }));
    const repositories = createRepositories(createPool(query));

    await expect(repositories.messageAttachments.claimExpiredDrafts(24)).resolves.toEqual([
      expect.objectContaining({ id: ATTACHMENT_1, status: "deleting" }),
    ]);

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("WITH candidates AS");
    expect(sql).toContain("message_id IS NULL");
    expect(sql).toContain("status = 'ready'");
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain("status = 'failed'");
    expect(sql).toContain("status = 'deleting'");
    expect(sql).toContain("created_at < now() - ($1 * interval '1 hour')");
    expect(sql).toContain("updated_at < now() - interval '5 minutes'");
    expect(sql).toContain("updated_at < now() - interval '15 minutes'");
    expect(sql).toContain("ORDER BY updated_at ASC, id ASC");
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("SET status = 'deleting'");
    expect(sql).toContain("deletion_claim_token = gen_random_uuid()");
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

  it("releases only the matching deletion claim back to failed", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const repositories = createRepositories(createPool(query));
    const claimToken = "50000000-0000-4000-8000-000000000001";

    await repositories.messageAttachments.releaseDeletionClaim(
      USER_1,
      ATTACHMENT_1,
      claimToken,
      "attachment_cleanup_failed",
    );

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("SET status = 'failed'");
    expect(sql).toContain("user_id = $1 AND id = $2");
    expect(sql).toContain("message_id IS NULL AND status = 'deleting'");
    expect(sql).toContain("deletion_claim_token = $3");
    expect(sql).toContain("deletion_claim_token = NULL");
    expect(params).toEqual([USER_1, ATTACHMENT_1, claimToken, "attachment_cleanup_failed"]);
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

async function readAttachmentStatusMigration(): Promise<string> {
  const schema = await readFile(path.join(process.cwd(), "src/server/db/schema.sql"), "utf8");
  const migration = schema.match(
    /DO \$message_attachments_status\$[\s\S]*?\$message_attachments_status\$;/,
  )?.[0];
  if (!migration) throw new Error("message_attachments_status_migration_missing");
  return migration;
}

async function readAttachmentClaimTokenMigration(): Promise<string> {
  const schema = await readFile(path.join(process.cwd(), "src/server/db/schema.sql"), "utf8");
  const migration = schema.match(
    /ALTER TABLE IF EXISTS message_attachments\s+ADD COLUMN IF NOT EXISTS deletion_claim_token uuid;/,
  )?.[0];
  if (!migration) throw new Error("message_attachment_claim_token_migration_missing");
  return migration;
}

async function readClientTurnMigration(): Promise<string> {
  const schema = await readFile(path.join(process.cwd(), "src/server/db/schema.sql"), "utf8");
  const columnMigration = schema.match(
    /ALTER TABLE IF EXISTS messages\s+ADD COLUMN IF NOT EXISTS client_turn_id uuid;[\s\S]*?ADD COLUMN IF NOT EXISTS client_turn_payload_hash text;[\s\S]*?ADD COLUMN IF NOT EXISTS client_turn_execution_started_at timestamptz;/,
  )?.[0];
  const uniqueIndex = schema.match(
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_turn_role[\s\S]*?WHERE client_turn_id IS NOT NULL;/,
  )?.[0];
  if (!columnMigration || !uniqueIndex) throw new Error("client_turn_migration_missing");
  return `${columnMigration}\n${uniqueIndex}`;
}

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("postgres_test_port_unavailable"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

describe("message attachment PostgreSQL concurrency", () => {
  const schemaName = `attachment_repository_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let databasePool: Pool;
  let embeddedPostgres: EmbeddedPostgres | null = null;
  let embeddedDatabaseDirectory: string | null = null;
  let databaseUrl: string;
  let legacyConstraintDefinition: string;
  let migratedConstraintOid: number;

  async function readStatusConstraint(): Promise<{ oid: number; definition: string }> {
    const result = await databasePool.query<{ oid: number; definition: string }>(
      `SELECT constraint_row.oid, pg_get_constraintdef(constraint_row.oid) AS definition
       FROM pg_constraint AS constraint_row
       JOIN pg_class AS table_row ON table_row.oid = constraint_row.conrelid
       JOIN pg_namespace AS namespace_row ON namespace_row.oid = table_row.relnamespace
       WHERE namespace_row.nspname = current_schema()
         AND table_row.relname = 'message_attachments'
         AND constraint_row.conname = 'message_attachments_status_check'`,
    );
    return result.rows[0];
  }

  beforeAll(async () => {
    databaseUrl = process.env.TEST_DATABASE_URL ?? "";
    if (!databaseUrl) {
      const port = await reservePort();
      embeddedDatabaseDirectory = await mkdtemp(path.join(os.tmpdir(), "digitalmate-postgres-"));
      embeddedPostgres = new EmbeddedPostgres({
        databaseDir: embeddedDatabaseDirectory,
        port,
        user: "postgres",
        password: "digitalmate-test",
        persistent: false,
        onLog: () => undefined,
        onError: () => undefined,
      });
      await embeddedPostgres.initialise();
      await embeddedPostgres.start();
      databaseUrl = `postgresql://postgres:digitalmate-test@127.0.0.1:${port}/postgres`;
    }

    adminPool = new Pool({ connectionString: databaseUrl });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    databasePool = new Pool({
      connectionString: databaseUrl,
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
        status text NOT NULL,
        error_code text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT message_attachments_status_check
          CHECK (status IN ('pending', 'ready', 'failed', 'bound')),
        CONSTRAINT message_attachments_binding_check CHECK (
          (status = 'bound' AND message_id IS NOT NULL)
          OR (status <> 'bound' AND message_id IS NULL)
        )
      );
    `);
    legacyConstraintDefinition = (await readStatusConstraint()).definition;
    await databasePool.query(await readAttachmentClaimTokenMigration());
    await databasePool.query(await readAttachmentStatusMigration());
    await databasePool.query(await readClientTurnMigration());
    migratedConstraintOid = (await readStatusConstraint()).oid;
  }, 30_000);

  afterAll(async () => {
    await databasePool?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await adminPool.end();
    }
    await embeddedPostgres?.stop();
    if (embeddedDatabaseDirectory) {
      await rm(embeddedDatabaseDirectory, { recursive: true, force: true });
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
    updatedAt?: Date;
    status?: "pending" | "ready" | "failed" | "deleting";
  }): Promise<void> {
    const createdAt = input.createdAt ?? new Date();
    await databasePool.query(
      `INSERT INTO message_attachments
       (id, user_id, kind, file_name, mime_type, size_bytes, storage_key, status, created_at, updated_at)
       VALUES ($1, $2, 'document', 'notes.md', 'text/markdown', 12, $3, $4, $5, $6)`,
      [input.id, input.userId, input.storageKey, input.status ?? "ready", createdAt, input.updatedAt ?? createdAt],
    );
  }

  it("migrates the legacy status constraint once and keeps reruns idempotent", async () => {
    expect(legacyConstraintDefinition).not.toContain("deleting");
    const migrated = await readStatusConstraint();
    expect(migrated.definition).toContain("deleting");
    expect(migrated.oid).toBe(migratedConstraintOid);

    await databasePool.query(await readAttachmentStatusMigration());
    await databasePool.query(await readAttachmentClaimTokenMigration());

    const rerun = await readStatusConstraint();
    expect(rerun.definition).toContain("deleting");
    expect(rerun.oid).toBe(migratedConstraintOid);
    const tokenColumn = await databasePool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'message_attachments'
         AND column_name = 'deletion_claim_token'`,
    );
    expect(tokenColumn.rows).toHaveLength(1);
  });

  it("migrates client turn columns and its partial role uniqueness idempotently", async () => {
    await databasePool.query(await readClientTurnMigration());
    const columns = await databasePool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'messages'
         AND column_name IN ('client_turn_id', 'client_turn_payload_hash', 'client_turn_execution_started_at')
       ORDER BY column_name`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "client_turn_execution_started_at",
      "client_turn_id",
      "client_turn_payload_hash",
    ]);
    const index = await databasePool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = current_schema() AND indexname = 'idx_messages_client_turn_role'`,
    );
    expect(index.rows[0].indexdef).toContain("UNIQUE");
    expect(index.rows[0].indexdef).toContain("(user_id, client_turn_id, role)");
    expect(index.rows[0].indexdef).toContain("WHERE (client_turn_id IS NOT NULL)");
  });

  it("returns the same user turn after an accepted event is lost", async () => {
    const userId = "50000000-0000-4000-8000-000000000001";
    const conversationId = "51000000-0000-4000-8000-000000000001";
    const clientTurnId = "52000000-0000-4000-8000-000000000001";
    await seedConversation(userId, conversationId);
    const repositories = createRepositories(databasePool);
    const input = {
      userId,
      conversationId,
      clientTurnId,
      payloadHash: "payload-one",
      content: "accepted 丢失后重试",
      attachmentIds: [],
    };

    const first = await repositories.messages.createIdempotentUserTurn(input);
    const retry = await repositories.messages.createIdempotentUserTurn(input);

    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.message.id).toBe(first.message.id);
    const count = await databasePool.query<{ count: string }>(
      "SELECT count(*) AS count FROM messages WHERE user_id = $1 AND client_turn_id = $2 AND role = 'user'",
      [userId, clientTurnId],
    );
    expect(Number(count.rows[0].count)).toBe(1);
  });

  it("durably lets only the first process claim one client turn execution", async () => {
    const userId = "50000000-0000-4000-8000-000000000009";
    const conversationId = "51000000-0000-4000-8000-000000000009";
    const clientTurnId = "52000000-0000-4000-8000-000000000009";
    await seedConversation(userId, conversationId);
    const firstRepositories = createRepositories(databasePool);
    await firstRepositories.messages.createIdempotentUserTurn({
      userId,
      conversationId,
      clientTurnId,
      payloadHash: "durable-execution-claim",
      content: "服务重启也不能重复执行",
      attachmentIds: [],
    });

    await expect(
      firstRepositories.messages.claimClientTurnExecution(userId, clientTurnId),
    ).resolves.toBe(true);

    const restartedRepositories = createRepositories(databasePool);
    await expect(
      restartedRepositories.messages.claimClientTurnExecution(userId, clientTurnId),
    ).resolves.toBe(false);
    const persisted = await databasePool.query<{ client_turn_execution_started_at: Date | null }>(
      `SELECT client_turn_execution_started_at FROM messages
       WHERE user_id = $1 AND client_turn_id = $2 AND role = 'user'`,
      [userId, clientTurnId],
    );
    expect(persisted.rows[0]?.client_turn_execution_started_at).toBeInstanceOf(Date);
  });

  it("makes concurrent copies of one turn share a user row and bound attachment", async () => {
    const userId = "50000000-0000-4000-8000-000000000002";
    const conversationId = "51000000-0000-4000-8000-000000000002";
    const clientTurnId = "52000000-0000-4000-8000-000000000002";
    const attachmentId = "53000000-0000-4000-8000-000000000002";
    await seedConversation(userId, conversationId);
    await seedAttachment({ id: attachmentId, userId, storageKey: "turn-concurrent-attachment" });
    const repositories = createRepositories(databasePool);
    const input = {
      userId,
      conversationId,
      clientTurnId,
      payloadHash: "payload-with-attachment",
      content: "并发相同 turn",
      attachmentIds: [attachmentId],
    };

    const [first, second] = await Promise.all([
      repositories.messages.createIdempotentUserTurn(input),
      repositories.messages.createIdempotentUserTurn(input),
    ]);
    const retryAfterBound = await repositories.messages.createIdempotentUserTurn(input);

    expect(new Set([first.message.id, second.message.id, retryAfterBound.message.id]).size).toBe(1);
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    expect(retryAfterBound.created).toBe(false);
    expect(retryAfterBound.attachments.map((attachment) => attachment.id)).toEqual([attachmentId]);
    expect(retryAfterBound.attachments[0]).toMatchObject({ status: "bound", messageId: first.message.id });
  });

  it("rejects a reused client turn with a different payload", async () => {
    const userId = "50000000-0000-4000-8000-000000000003";
    const conversationId = "51000000-0000-4000-8000-000000000003";
    const clientTurnId = "52000000-0000-4000-8000-000000000003";
    await seedConversation(userId, conversationId);
    const repositories = createRepositories(databasePool);
    await repositories.messages.createIdempotentUserTurn({
      userId,
      conversationId,
      clientTurnId,
      payloadHash: "payload-original",
      content: "原始正文",
      attachmentIds: [],
    });

    await expect(repositories.messages.createIdempotentUserTurn({
      userId,
      conversationId,
      clientTurnId,
      payloadHash: "payload-changed",
      content: "修改后的正文",
      attachmentIds: [],
    })).rejects.toThrow("client_turn_conflict");
  });

  it("lets concurrent normal and fallback assistant writes create only one visible row", async () => {
    const userId = "50000000-0000-4000-8000-000000000004";
    const conversationId = "51000000-0000-4000-8000-000000000004";
    const clientTurnId = "52000000-0000-4000-8000-000000000004";
    await seedConversation(userId, conversationId);
    const repositories = createRepositories(databasePool);

    const [normal, fallback] = await Promise.all([
      repositories.messages.createIdempotentAssistantTurn({
        userId, conversationId, clientTurnId, content: "正常回复",
      }),
      repositories.messages.createIdempotentAssistantTurn({
        userId, conversationId, clientTurnId, content: "降级回复",
      }),
    ]);

    expect(normal.message.id).toBe(fallback.message.id);
    expect([normal.created, fallback.created].filter(Boolean)).toHaveLength(1);
    expect(normal.message.content).toBe(fallback.message.content);
    const count = await databasePool.query<{ count: string }>(
      "SELECT count(*) AS count FROM messages WHERE user_id = $1 AND client_turn_id = $2 AND role = 'assistant'",
      [userId, clientTurnId],
    );
    expect(Number(count.rows[0].count)).toBe(1);
  });

  it("holds one database execution lock per client turn until the owner releases it", async () => {
    const repositories = createRepositories(databasePool);
    const userId = "50000000-0000-4000-8000-000000000005";
    const clientTurnId = "52000000-0000-4000-8000-000000000005";
    const releaseFirst = await repositories.messages.acquireClientTurnExecutionLock(userId, clientTurnId);
    let secondAcquired = false;
    const secondLock = repositories.messages.acquireClientTurnExecutionLock(userId, clientTurnId).then((release) => {
      secondAcquired = true;
      return release;
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(secondAcquired).toBe(false);

    await releaseFirst();
    const releaseSecond = await secondLock;
    expect(secondAcquired).toBe(true);
    await releaseSecond();
  });

  it("serializes attachment uploads and personal-data clearing for one user", async () => {
    const repositories = createRepositories(databasePool);
    const userId = "50000000-0000-4000-8000-000000000010";
    const releaseUpload = await repositories.messageAttachments.acquireUserMutationLock(userId);
    let clearLockAcquired = false;
    const clearLock = repositories.messageAttachments.acquireUserMutationLock(userId).then((release) => {
      clearLockAcquired = true;
      return release;
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(clearLockAcquired).toBe(false);
    await releaseUpload();
    const releaseClear = await clearLock;
    expect(clearLockAcquired).toBe(true);
    await releaseClear();
  });

  it("keeps the business pool available while many copies wait for one turn lock", async () => {
    const repositories = createRepositories(databasePool);
    const userId = "50000000-0000-4000-8000-000000000006";
    const clientTurnId = "52000000-0000-4000-8000-000000000006";
    const releaseOwner = await repositories.messages.acquireClientTurnExecutionLock(userId, clientTurnId);
    const waiters = Array.from({ length: 12 }, () =>
      repositories.messages.acquireClientTurnExecutionLock(userId, clientTurnId).then(async (release) => {
        await release();
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    let businessQueryCompleted = false;
    const businessQuery = databasePool.query("SELECT 1").then(() => {
      businessQueryCompleted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const completedBeforeOwnerRelease = businessQueryCompleted;

    await releaseOwner();
    await Promise.all([...waiters, businessQuery]);
    expect(completedBeforeOwnerRelease).toBe(true);
  });

  it("isolates different turn owners from a small business connection pool", async () => {
    const poolOptions = `-c search_path=${schemaName} -c statement_timeout=5000 -c lock_timeout=3000`;
    const smallBusinessPool = new Pool({ connectionString: databaseUrl, options: poolOptions, max: 2 });
    const smallLockPool = new Pool({ connectionString: databaseUrl, options: poolOptions, max: 2 });
    const repositories = createRepositories(smallBusinessPool, smallLockPool);
    let releaseFirst: (() => Promise<void>) | undefined;
    let releaseSecond: (() => Promise<void>) | undefined;
    try {
      releaseFirst = await repositories.messages.acquireClientTurnExecutionLock(
        "50000000-0000-4000-8000-000000000007",
        "52000000-0000-4000-8000-000000000007",
      );
      releaseSecond = await repositories.messages.acquireClientTurnExecutionLock(
        "50000000-0000-4000-8000-000000000008",
        "52000000-0000-4000-8000-000000000008",
      );
      let businessQueryCompleted = false;
      const businessQuery = smallBusinessPool.query("SELECT 1").then(() => {
        businessQueryCompleted = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const completedWhileBothLocksHeld = businessQueryCompleted;

      await releaseFirst();
      releaseFirst = undefined;
      await releaseSecond();
      releaseSecond = undefined;
      await businessQuery;
      expect(completedWhileBothLocksHeld).toBe(true);
    } finally {
      await releaseFirst?.();
      await releaseSecond?.();
      await smallBusinessPool.end();
      await smallLockPool.end();
    }
  });

  it("prevents an old deletion token from releasing or deleting a newer claim", async () => {
    const userId = "40000000-0000-4000-8000-000000000007";
    const conversationId = "41000000-0000-4000-8000-000000000007";
    const attachmentId = "42000000-0000-4000-8000-000000000060";
    await seedConversation(userId, conversationId);
    await seedAttachment({ id: attachmentId, userId, storageKey: "pg-token-fence" });
    const repositories = createRepositories(databasePool);

    const firstClaim = await repositories.messageAttachments.claimDraftForDeletion(userId, attachmentId);
    const secondClaim = await repositories.messageAttachments.claimDraftForDeletion(userId, attachmentId);
    expect(firstClaim?.deletionClaimToken).toBeTruthy();
    expect(secondClaim?.deletionClaimToken).toBeTruthy();
    expect(secondClaim?.deletionClaimToken).not.toBe(firstClaim?.deletionClaimToken);

    await expect(
      repositories.messageAttachments.releaseDeletionClaim(
        userId,
        attachmentId,
        firstClaim!.deletionClaimToken!,
        "old_worker",
      ),
    ).resolves.toBe(false);
    await expect(
      repositories.messageAttachments.deleteDraft(
        userId,
        attachmentId,
        firstClaim!.deletionClaimToken!,
      ),
    ).resolves.toBe(false);

    const stored = await repositories.messageAttachments.getForUser(userId, attachmentId);
    expect(stored).toMatchObject({
      status: "deleting",
      deletionClaimToken: secondClaim!.deletionClaimToken,
    });
    await expect(
      repositories.messageAttachments.deleteDraft(
        userId,
        attachmentId,
        secondClaim!.deletionClaimToken!,
      ),
    ).resolves.toBe(true);
  });

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

  it("claims an expired pending upload while excluding an old bound attachment", async () => {
    const userId = "40000000-0000-4000-8000-000000000008";
    const conversationId = "41000000-0000-4000-8000-000000000008";
    const pendingId = "42000000-0000-4000-8000-000000000070";
    const boundId = "42000000-0000-4000-8000-000000000071";
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await seedConversation(userId, conversationId);
    await seedAttachment({
      id: pendingId,
      userId,
      storageKey: "pg-expired-pending",
      createdAt: old,
      updatedAt: old,
      status: "pending",
    });
    await seedAttachment({
      id: boundId,
      userId,
      storageKey: "pg-old-bound",
      createdAt: old,
      updatedAt: old,
    });
    const repositories = createRepositories(databasePool);
    await repositories.messages.createWithAttachments({
      userId,
      conversationId,
      content: "bind old attachment",
      attachmentIds: [boundId],
    });

    const claimed = await repositories.messageAttachments.claimExpiredDrafts(24, 10);

    expect(claimed.map((attachment) => attachment.id)).toEqual([pendingId]);
    const bound = await repositories.messageAttachments.getForUser(userId, boundId);
    expect(bound).toMatchObject({ status: "bound", messageId: expect.any(String) });
  });

  it("lets two cleanup workers claim disjoint batches", async () => {
    const userId = "40000000-0000-4000-8000-000000000004";
    const conversationId = "41000000-0000-4000-8000-000000000004";
    await seedConversation(userId, conversationId);
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const attachmentIds = Array.from(
      { length: 4 },
      (_, index) => `42000000-0000-4000-8000-${String(30 + index).padStart(12, "0")}`,
    );
    await Promise.all(
      attachmentIds.map((id, index) =>
        seedAttachment({ id, userId, storageKey: `pg-worker-${index}`, createdAt: old, updatedAt: old }),
      ),
    );
    const repositories = createRepositories(databasePool);

    const [first, second] = await Promise.all([
      repositories.messageAttachments.claimExpiredDrafts(24, 2),
      repositories.messageAttachments.claimExpiredDrafts(24, 2),
    ]);

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    const claimedIds = [...first, ...second].map((attachment) => attachment.id);
    expect(new Set(claimedIds)).toEqual(new Set(attachmentIds));
    const claimTokens = [...first, ...second].map((attachment) => attachment.deletionClaimToken);
    expect(claimTokens.every(Boolean)).toBe(true);
    expect(new Set(claimTokens).size).toBe(4);
  });

  it("reclaims an abandoned deleting lease after fifteen minutes", async () => {
    const userId = "40000000-0000-4000-8000-000000000005";
    const conversationId = "41000000-0000-4000-8000-000000000005";
    const staleId = "42000000-0000-4000-8000-000000000040";
    const freshId = "42000000-0000-4000-8000-000000000041";
    await seedConversation(userId, conversationId);
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await seedAttachment({
      id: staleId,
      userId,
      storageKey: "pg-stale-lease",
      createdAt: old,
      updatedAt: new Date(Date.now() - 16 * 60 * 1000),
      status: "deleting",
    });
    await seedAttachment({
      id: freshId,
      userId,
      storageKey: "pg-fresh-lease",
      createdAt: old,
      updatedAt: new Date(),
      status: "deleting",
    });
    const repositories = createRepositories(databasePool);

    const claimed = await repositories.messageAttachments.claimExpiredDrafts(24, 10);

    expect(claimed.map((attachment) => attachment.id)).toEqual([staleId]);
  });

  it("backs off failed cleanup and lets an older eligible record proceed", async () => {
    const userId = "40000000-0000-4000-8000-000000000006";
    const conversationId = "41000000-0000-4000-8000-000000000006";
    const failedLowId = "42000000-0000-4000-8000-000000000050";
    const readyHighId = "42000000-0000-4000-8000-000000000051";
    await seedConversation(userId, conversationId);
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await seedAttachment({
      id: failedLowId,
      userId,
      storageKey: "pg-failed-backoff",
      createdAt: old,
      updatedAt: new Date(),
      status: "failed",
    });
    await seedAttachment({
      id: readyHighId,
      userId,
      storageKey: "pg-ready-fair",
      createdAt: old,
      updatedAt: old,
    });
    const repositories = createRepositories(databasePool);

    const firstClaim = await repositories.messageAttachments.claimExpiredDrafts(24, 1);
    expect(firstClaim.map((attachment) => attachment.id)).toEqual([readyHighId]);

    await databasePool.query(
      "UPDATE message_attachments SET updated_at = now() - interval '6 minutes' WHERE id = $1",
      [failedLowId],
    );
    const retryClaim = await repositories.messageAttachments.claimExpiredDrafts(24, 1);
    expect(retryClaim.map((attachment) => attachment.id)).toEqual([failedLowId]);
  });

  it("removes a safely aged private file only after confirming PostgreSQL has no attachment row", async () => {
    const userId = "40000000-0000-4000-8000-000000000009";
    const conversationId = "41000000-0000-4000-8000-000000000009";
    const attachmentId = "42000000-0000-4000-8000-000000000080";
    const referencedKey = "43000000-0000-4000-8000-000000000080";
    const orphanKey = "43000000-0000-4000-8000-000000000081";
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), "digitalmate-orphan-cleanup-"));
    try {
      await seedConversation(userId, conversationId);
      await seedAttachment({ id: attachmentId, userId, storageKey: referencedKey });
      await Promise.all([
        writeFile(path.join(storageRoot, referencedKey), "referenced"),
        writeFile(path.join(storageRoot, orphanKey), "orphan"),
      ]);
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
      await Promise.all([
        utimes(path.join(storageRoot, referencedKey), old, old),
        utimes(path.join(storageRoot, orphanKey), old, old),
      ]);

      const result = await cleanupStaleAttachments({
        repositories: createRepositories(databasePool),
        storageDirectory: storageRoot,
        logger: { info: vi.fn(), error: vi.fn() },
      });

      expect((await readdir(storageRoot)).sort()).toEqual([referencedKey]);
      expect(result.orphanedFiles).toEqual({ deleted: 1, failed: 0 });
      await expect(
        createRepositories(databasePool).messageAttachments.getForUser(userId, attachmentId),
      ).resolves.toMatchObject({ storageKey: referencedKey });
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });
});
