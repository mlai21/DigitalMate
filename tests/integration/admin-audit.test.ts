import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";

import EmbeddedPostgres from "embedded-postgres";
import { Pool, type PoolClient } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { createChannelConnectionAuditService } from "@/server/admin/audit";
import { migrateSchema } from "@/server/db/migrate";
import {
  createChannelSecretsKey,
  encryptedSecretFromStorage,
} from "@/server/security/encrypted-secret";
import {
  trackEmbeddedPostgresPool,
  type EmbeddedPostgresLifecycle,
} from "./embedded-postgres-lifecycle";

const USER_A = "10000000-0000-4000-8000-000000000001";
const USER_B = "20000000-0000-4000-8000-000000000002";
const AGENT_A = "10000000-0000-4000-8000-000000000011";
const AGENT_A2 = "10000000-0000-4000-8000-000000000012";
const AGENT_B = "20000000-0000-4000-8000-000000000011";
const CONNECTION_A = "10000000-0000-4000-8000-000000000021";
const CONNECTION_A2 = "10000000-0000-4000-8000-000000000022";
const CONNECTION_B = "20000000-0000-4000-8000-000000000021";
const REQUEST_ID = "10000000-0000-4000-8000-000000000031";
const TEST_SECRET = "task5-database-super-secret";
const OTHER_SECRET = "task5-second-super-secret";
const ENCODED_KEY = Buffer.alloc(32, 17).toString("base64");
let requestSequence = 0;

describe("channel config revision, secret and audit transaction", () => {
  let embeddedPostgres: EmbeddedPostgres;
  let databaseDirectory: string;
  let databaseUrl: string;
  let primaryPool: Pool;
  let secondaryPool: Pool;
  let databaseLifecycle: EmbeddedPostgresLifecycle;
  let schema: string;
  const keyState = createChannelSecretsKey(ENCODED_KEY);

  beforeAll(async () => {
    if (keyState.status !== "ready") throw new Error("test_key_not_ready");
    const port = await reservePort();
    databaseDirectory = await mkdtemp(
      path.join(os.tmpdir(), "digitalmate-admin-audit-"),
    );
    embeddedPostgres = new EmbeddedPostgres({
      databaseDir: databaseDirectory,
      port,
      user: "postgres",
      password: "digitalmate-test",
      persistent: false,
      onLog: () => undefined,
      onError: () => undefined,
    });
    await embeddedPostgres.initialise();
    await embeddedPostgres.start();
    databaseUrl =
      `postgresql://postgres:digitalmate-test@127.0.0.1:${port}/postgres`;
    const poolOptions = {
      connectionString: databaseUrl,
      options: "-c statement_timeout=15000 -c lock_timeout=5000",
    };
    primaryPool = new Pool(poolOptions);
    secondaryPool = new Pool(poolOptions);
    databaseLifecycle = trackEmbeddedPostgresPool(primaryPool);
    schema = adaptSchemaForEmbeddedPostgres(
      await readFile(
        path.join(process.cwd(), "src/server/db/schema.sql"),
        "utf8",
      ),
    );
    await installVectorCompatibility(primaryPool);
    await primaryPool.query(schema);
    await primaryPool.query(schema);
  }, 60_000);

  beforeEach(async () => {
    requestSequence = 0;
    await primaryPool.query(`
      TRUNCATE admin_audit_logs, channel_secrets, channel_connections,
        digital_agents, users CASCADE
    `);
    await primaryPool.query(
      `INSERT INTO users (id, display_name)
       VALUES ($1, 'User A'), ($2, 'User B')`,
      [USER_A, USER_B],
    );
    await primaryPool.query(
      `INSERT INTO digital_agents (
         id, user_id, slug, display_name, is_default
       )
       VALUES
         ($1, $2, 'default-a', 'Agent A', true),
         ($3, $2, 'second-a', 'Agent A2', false),
         ($4, $5, 'default-b', 'Agent B', true)`,
      [AGENT_A, USER_A, AGENT_A2, AGENT_B, USER_B],
    );
    await primaryPool.query(
      `INSERT INTO channel_connections (
         id, user_id, agent_id, channel_type, display_name, config
       )
       VALUES
         ($1, $2, $3, 'telegram', 'Telegram A', '{"endpoint":"old-a"}'),
         ($4, $2, $5, 'telegram', 'Telegram A2', '{"endpoint":"old-a2"}'),
         ($6, $7, $8, 'telegram', 'Telegram B', '{"endpoint":"old-b"}')`,
      [
        CONNECTION_A,
        USER_A,
        AGENT_A,
        CONNECTION_A2,
        AGENT_A2,
        CONNECTION_B,
        USER_B,
        AGENT_B,
      ],
    );
  });

  afterAll(async () => {
    await secondaryPool?.end();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await databaseLifecycle?.stop(embeddedPostgres);
    if (databaseDirectory) {
      await rm(databaseDirectory, { recursive: true, force: true });
    }
  });

  it("runs the schema twice and serializes concurrent migrations on an empty schema", async () => {
    await primaryPool.query(schema);
    await primaryPool.query(schema);

    const schemaName = `admin_audit_migration_${process.pid}_${Date.now()}`;
    await primaryPool.query(`CREATE SCHEMA "${schemaName}"`);
    const firstPool = new Pool({
      connectionString: databaseUrl,
      options:
        `-c search_path=${schemaName} -c statement_timeout=15000 -c lock_timeout=5000`,
    });
    const secondPool = new Pool({
      connectionString: databaseUrl,
      options:
        `-c search_path=${schemaName} -c statement_timeout=15000 -c lock_timeout=5000`,
    });
    try {
      await installVectorCompatibility(firstPool);
      await Promise.all([
        migrateSchema(firstPool, schema),
        migrateSchema(secondPool, schema),
      ]);
      const tables = await firstPool.query<{ name: string | null }>(
        `SELECT to_regclass(name)::text AS name
         FROM unnest(ARRAY[
           'channel_connections',
           'channel_secrets',
           'channel_secret_exposure_fingerprints',
           'admin_audit_logs'
         ]) AS name`,
      );
      expect(tables.rows.map((row) => row.name)).toEqual([
        "channel_connections",
        "channel_secrets",
        "channel_secret_exposure_fingerprints",
        "admin_audit_logs",
      ]);

      await firstPool.query(`
        ALTER TABLE channel_secret_exposure_fingerprints
          DROP CONSTRAINT
            channel_secret_exposure_fingerprints_user_id_fkey,
          DROP CONSTRAINT
            channel_secret_exposure_fingerprints_connection_id_fkey,
          DROP CONSTRAINT
            channel_secret_exposure_fingerprints_pkey,
          DROP COLUMN user_id;
        ALTER TABLE channel_secret_exposure_fingerprints
          ALTER COLUMN connection_id SET NOT NULL,
          ADD CONSTRAINT channel_secret_exposure_fingerprints_pkey
            PRIMARY KEY (
              connection_id, field_name, key_version, digest
            ),
          ADD CONSTRAINT
            channel_secret_exposure_fingerprints_connection_id_fkey
            FOREIGN KEY (connection_id)
            REFERENCES channel_connections(id)
            ON DELETE CASCADE;
      `);
      const migrationUserId =
        "90000000-0000-4000-8000-000000000001";
      const migrationAgentId =
        "90000000-0000-4000-8000-000000000011";
      const migrationConnectionId =
        "90000000-0000-4000-8000-000000000021";
      await firstPool.query(
        "INSERT INTO users (id, display_name) VALUES ($1, 'Migration user')",
        [migrationUserId],
      );
      await firstPool.query(
        `INSERT INTO digital_agents (
           id, user_id, slug, display_name, is_default
         )
         VALUES ($1, $2, 'default', 'Migration agent', true)`,
        [migrationAgentId, migrationUserId],
      );
      await firstPool.query(
        `INSERT INTO channel_connections (
           id, user_id, agent_id, channel_type, display_name
         )
         VALUES ($1, $2, $3, 'telegram', 'Migration channel')`,
        [
          migrationConnectionId,
          migrationUserId,
          migrationAgentId,
        ],
      );
      await firstPool.query(
        `INSERT INTO channel_secret_exposure_fingerprints (
           connection_id, field_name, key_version, digest,
           utf8_bytes, character_length
         )
         VALUES ($1, 'bot_token', 1, $2, 16, 16)`,
        [
          migrationConnectionId,
          Buffer.alloc(32, 7),
        ],
      );

      await migrateSchema(firstPool, schema);
      const migrated = await firstPool.query<{
        user_id: string;
        connection_id: string | null;
        primary_definition: string;
        delete_action: string;
      }>(
        `SELECT fingerprint.user_id,
                fingerprint.connection_id,
                (
                  SELECT pg_get_constraintdef(oid)
                  FROM pg_constraint
                  WHERE conrelid =
                    'channel_secret_exposure_fingerprints'::regclass
                    AND contype = 'p'
                ) AS primary_definition,
                (
                  SELECT confdeltype::text
                  FROM pg_constraint
                  WHERE conrelid =
                    'channel_secret_exposure_fingerprints'::regclass
                    AND conname =
                      'channel_secret_exposure_fingerprints_connection_id_fkey'
                ) AS delete_action
         FROM channel_secret_exposure_fingerprints AS fingerprint`,
      );
      expect(migrated.rows[0]).toMatchObject({
        user_id: migrationUserId,
        connection_id: migrationConnectionId,
        primary_definition:
          "PRIMARY KEY (user_id, key_version, digest)",
        delete_action: "n",
      });
      await firstPool.query(
        "DELETE FROM channel_connections WHERE id = $1",
        [migrationConnectionId],
      );
      const retained = await firstPool.query<{
        user_id: string;
        connection_id: string | null;
      }>(
        `SELECT user_id, connection_id
         FROM channel_secret_exposure_fingerprints`,
      );
      expect(retained.rows).toEqual([{
        user_id: migrationUserId,
        connection_id: null,
      }]);
    } finally {
      await firstPool.end();
      await secondPool.end();
      await primaryPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    }
  }, 60_000);

  it("allows only one concurrent writer for the same revision across pools", async () => {
    if (keyState.status !== "ready") throw new Error("test_key_not_ready");
    const first = createChannelConnectionAuditService(
      primaryPool,
      keyState.key,
    );
    const second = createChannelConnectionAuditService(
      secondaryPool,
      keyState.key,
    );

    const outcomes = await Promise.allSettled([
      first.update(
        updateInput({
          config: { endpoint: "winner-one" },
          secret: TEST_SECRET,
        }),
      ),
      second.update(
        updateInput({
          config: { endpoint: "winner-two" },
          secret: OTHER_SECRET,
        }),
      ),
    ]);

    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected",
    );
    expect(rejected?.reason).toMatchObject({
      status: 409,
      code: "config_revision_conflict",
      message: "config_revision_conflict",
    });
    const connection = await primaryPool.query<{
      config: { endpoint: string };
      revision: number;
    }>(
      `SELECT config, revision
       FROM channel_connections
       WHERE id = $1`,
      [CONNECTION_A],
    );
    expect(connection.rows[0].revision).toBe(2);
    const audits = await primaryPool.query<{
      before_summary: Record<string, unknown>;
      after_summary: Record<string, unknown>;
      status: string;
    }>(
      `SELECT before_summary, after_summary, status
       FROM admin_audit_logs
       WHERE resource_id = $1`,
      [CONNECTION_A],
    );
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0]).toMatchObject({
      status: "success",
      before_summary: {
        revision: 1,
        config: { endpoint: "old-a" },
        secrets: { bot_token: { configured: false } },
      },
      after_summary: {
        revision: 2,
        secrets: { bot_token: { configured: true } },
      },
    });
    const stored = await primaryPool.query<{
      ciphertext: Buffer;
      nonce: Buffer;
      auth_tag: Buffer;
      key_version: number;
    }>(
      `SELECT ciphertext, nonce, auth_tag, key_version
       FROM channel_secrets
       WHERE connection_id = $1 AND field_name = 'bot_token'`,
      [CONNECTION_A],
    );
    expect(stored.rows).toHaveLength(1);
    const decrypted = keyState.key.decrypt(
      encryptedSecretFromStorage({
        ciphertext: stored.rows[0].ciphertext,
        nonce: stored.rows[0].nonce,
        authTag: stored.rows[0].auth_tag,
        keyVersion: stored.rows[0].key_version,
      }),
      {
        userId: USER_A,
        agentId: AGENT_A,
        connectionId: CONNECTION_A,
        fieldName: "bot_token",
      },
    );
    expect([TEST_SECRET, OTHER_SECRET]).toContain(decrypted);
    expect(connection.rows[0].config.endpoint).toBe(
      decrypted === TEST_SECRET ? "winner-one" : "winner-two",
    );
  });

  it("recovers a committed update after COMMIT loses its response", async () => {
    if (keyState.status !== "ready") throw new Error("test_key_not_ready");
    const harness = createAuditCommitHarness(primaryPool, "committed");
    const service = createChannelConnectionAuditService(
      harness.pool,
      keyState.key,
    );

    await expect(
      service.update(updateInput({ secret: TEST_SECRET })),
    ).resolves.toEqual({ revision: 2 });
    expect(harness.releases[0]).toEqual([true]);
    expect(harness.releases[1]).toEqual([]);
    const persisted = await primaryPool.query<{
      revision: number;
      audits: string;
      audit_text: string;
    }>(
      `SELECT revision,
              (SELECT count(*) FROM admin_audit_logs) AS audits,
              (
                SELECT concat(
                  before_summary::text,
                  after_summary::text,
                  confirmation_source::text
                )
                FROM admin_audit_logs
                WHERE resource_id = $1::text
              ) AS audit_text
       FROM channel_connections WHERE id = $1::uuid`,
      [CONNECTION_A],
    );
    expect(persisted.rows[0]).toMatchObject({
      revision: 2,
      audits: "1",
    });
    expect(persisted.rows[0].audit_text).not.toContain(TEST_SECRET);
  });

  it("does not report success for an ambiguous COMMIT without a request id", async () => {
    if (keyState.status !== "ready") throw new Error("test_key_not_ready");
    const harness = createAuditCommitHarness(primaryPool, "committed");
    const service = createChannelConnectionAuditService(
      harness.pool,
      keyState.key,
    );

    await expect(
      service.update({
        ...updateInput({ secret: TEST_SECRET }),
        confirmationSource: { type: "console" },
      }),
    ).rejects.toMatchObject({
      code: "channel_config_update_failed",
    });
    expect(harness.releases[0]).toEqual([true]);
    const persisted = await primaryPool.query<{
      revision: number;
      audits: string;
    }>(
      `SELECT revision,
              (SELECT count(*) FROM admin_audit_logs) AS audits
       FROM channel_connections WHERE id = $1`,
      [CONNECTION_A],
    );
    expect(persisted.rows[0]).toEqual({
      revision: 2,
      audits: "1",
    });
  });

  it.each([
    ["not_committed", "channel_config_update_failed"],
    ["mismatch", "operation_id_reused"],
    ["unknown", "channel_config_update_failed"],
  ] as const)(
    "fails safely when COMMIT recovery is %s",
    async (outcome, expectedCode) => {
      if (keyState.status !== "ready") throw new Error("test_key_not_ready");
      const harness = createAuditCommitHarness(primaryPool, outcome);
      const service = createChannelConnectionAuditService(
        harness.pool,
        keyState.key,
      );

      await expect(
        service.update(updateInput({ secret: TEST_SECRET })),
      ).rejects.toMatchObject({ code: expectedCode });
      expect(harness.releases[0]).toEqual([true]);
      if (outcome !== "unknown") {
        expect(harness.releases[1]).toEqual([]);
      }
    },
  );

  it("retries an already committed request exactly once and rejects request-id reuse", async () => {
    if (keyState.status !== "ready") throw new Error("test_key_not_ready");
    const service = createChannelConnectionAuditService(
      primaryPool,
      keyState.key,
    );
    const input = updateInput({ secret: TEST_SECRET });
    await expect(service.update(input)).resolves.toEqual({ revision: 2 });
    await expect(service.update(input)).resolves.toEqual({ revision: 2 });
    await expect(service.update({
      ...input,
      config: { endpoint: "different" },
      secretChanges: [{
        fieldName: "bot_token",
        operation: "set",
        value: OTHER_SECRET,
      }],
    })).rejects.toMatchObject({
      status: 409,
      code: "operation_id_reused",
    });
    const counts = await primaryPool.query<{
      revision: number;
      audits: string;
    }>(
      `SELECT revision,
              (SELECT count(*) FROM admin_audit_logs) AS audits
       FROM channel_connections WHERE id = $1`,
      [CONNECTION_A],
    );
    expect(counts.rows[0]).toEqual({
      revision: 2,
      audits: "1",
    });
  });

  it("recovers an exact retry when its read-only COMMIT response is lost", async () => {
    if (keyState.status !== "ready") throw new Error("test_key_not_ready");
    const input = updateInput({ secret: TEST_SECRET });
    await createChannelConnectionAuditService(
      primaryPool,
      keyState.key,
    ).update(input);
    const harness = createAuditCommitHarness(primaryPool, "committed");
    const service = createChannelConnectionAuditService(
      harness.pool,
      keyState.key,
    );

    await expect(service.update(input)).resolves.toEqual({ revision: 2 });
    expect(harness.releases[0]).toEqual([true]);
    expect(harness.releases[1]).toEqual([]);
    const counts = await primaryPool.query<{
      revision: number;
      audits: string;
    }>(
      `SELECT revision,
              (SELECT count(*) FROM admin_audit_logs) AS audits
       FROM channel_connections WHERE id = $1`,
      [CONNECTION_A],
    );
    expect(counts.rows[0]).toEqual({
      revision: 2,
      audits: "1",
    });
  });

  it("aborts a real row-lock wait promptly and leaves the connection reusable", async () => {
    if (keyState.status !== "ready") throw new Error("test_key_not_ready");
    const auditPool = new Pool({
      connectionString: databaseUrl,
      options: "-c statement_timeout=1000 -c lock_timeout=250",
    });
    const blocker = await secondaryPool.connect();
    const controller = new AbortController();
    const service = createChannelConnectionAuditService(
      auditPool,
      keyState.key,
    );
    let captured: unknown;
    let elapsedMs = 0;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        `SELECT id
         FROM channel_connections
         WHERE id = $1
         FOR UPDATE`,
        [CONNECTION_A],
      );
      const startedAt = Date.now();
      const abortTimer = setTimeout(() => {
        controller.abort(new Error(`sensitive-${TEST_SECRET}`));
      }, 25);
      try {
        await service.update(
          updateInput({ secret: TEST_SECRET }),
          controller.signal,
        );
      } catch (error) {
        captured = error;
      } finally {
        clearTimeout(abortTimer);
        elapsedMs = Date.now() - startedAt;
      }
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }

    try {
      expect(captured).toMatchObject({
        status: 500,
        code: "channel_config_update_failed",
        message: "channel_config_update_failed",
      });
      expect(
        `${String(captured)} ${inspect(captured)} ${JSON.stringify(captured)}`,
      ).not.toContain(TEST_SECRET);
      expect(elapsedMs).toBeLessThan(1_000);
      await expect(
        service.update(updateInput({ secret: TEST_SECRET })),
      ).resolves.toEqual({ revision: 2 });
    } finally {
      await auditPool.end();
    }
  });

  it("upserts and explicitly deletes secrets while auditing configured state only", async () => {
    if (keyState.status !== "ready") throw new Error("test_key_not_ready");
    const service = createChannelConnectionAuditService(
      primaryPool,
      keyState.key,
    );
    await service.update(updateInput({ secret: TEST_SECRET }));
    const result = await service.update({
      ...updateInput({ expectedRevision: 2, secret: TEST_SECRET }),
      secretChanges: [
        { fieldName: "bot_token", operation: "delete" },
      ],
    });

    expect(result).toEqual({ revision: 3 });
    const secretCount = await primaryPool.query<{ count: string }>(
      `SELECT count(*) AS count
       FROM channel_secrets
       WHERE connection_id = $1`,
      [CONNECTION_A],
    );
    expect(secretCount.rows[0].count).toBe("0");
    const audit = await primaryPool.query<{
      before_summary: Record<string, unknown>;
      after_summary: Record<string, unknown>;
    }>(
      `SELECT before_summary, after_summary
       FROM admin_audit_logs
       WHERE resource_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [CONNECTION_A],
    );
    expect(audit.rows[0]).toMatchObject({
      before_summary: {
        secrets: { bot_token: { configured: true } },
      },
      after_summary: {
        secrets: { bot_token: { configured: false } },
      },
    });
    expect(JSON.stringify(audit.rows[0])).not.toContain(TEST_SECRET);
  });

  it("blocks Task 5 public config from reusing a rotated historical secret", async () => {
    if (keyState.status !== "ready") throw new Error("test_key_not_ready");
    const service = createChannelConnectionAuditService(
      primaryPool,
      keyState.key,
    );
    await service.update(updateInput({ secret: TEST_SECRET }));
    await service.update(updateInput({
      expectedRevision: 2,
      secret: OTHER_SECRET,
    }));

    await expect(service.update({
      ...updateInput({
        expectedRevision: 3,
        secret: OTHER_SECRET,
      }),
      config: {
        endpoint:
          `https://example.test/hook?token=${TEST_SECRET}`,
      },
      secretChanges: [],
    })).rejects.toMatchObject({
      status: 400,
      code: "secret_in_public_config",
    });
    const persisted = await primaryPool.query<{
      revision: number;
      fingerprints: string;
    }>(
      `SELECT revision,
              (
                SELECT count(*)
                FROM channel_secret_exposure_fingerprints
                WHERE connection_id = channel_connections.id
              ) AS fingerprints
       FROM channel_connections
       WHERE id = $1`,
      [CONNECTION_A],
    );
    expect(persisted.rows[0]).toEqual({
      revision: 3,
      fingerprints: "2",
    });
  });

  it("rejects a credential from another connection owned by the same user", async () => {
    if (keyState.status !== "ready") throw new Error("test_key_not_ready");
    const service = createChannelConnectionAuditService(
      primaryPool,
      keyState.key,
    );
    await service.update(updateInput({ secret: TEST_SECRET }));

    await expect(service.update({
      ...updateInput({ secret: OTHER_SECRET }),
      scope: { userId: USER_A, agentId: AGENT_A2 },
      connectionId: CONNECTION_A2,
      config: { endpoint: `Bearer ${TEST_SECRET}` },
    })).rejects.toMatchObject({
      status: 400,
      code: "secret_in_public_config",
    });
    const second = await primaryPool.query<{
      revision: number;
      audits: string;
    }>(
      `SELECT revision,
              (
                SELECT count(*)
                FROM admin_audit_logs
                WHERE resource_id = $1::text
              ) AS audits
       FROM channel_connections
       WHERE id = $1::uuid`,
      [CONNECTION_A2],
    );
    expect(second.rows[0]).toEqual({
      revision: 1,
      audits: "0",
    });
  });

  it("does not apply another user's credential history", async () => {
    if (keyState.status !== "ready") throw new Error("test_key_not_ready");
    const service = createChannelConnectionAuditService(
      primaryPool,
      keyState.key,
    );
    await service.update(updateInput({ secret: TEST_SECRET }));

    await expect(service.update({
      ...updateInput({ secret: OTHER_SECRET }),
      scope: { userId: USER_B, agentId: AGENT_B },
      connectionId: CONNECTION_B,
      config: { endpoint: `Bearer ${TEST_SECRET}` },
    })).resolves.toEqual({ revision: 2 });
  });

  it.each([
    {
      label: "stale revision",
      scope: { userId: USER_A, agentId: AGENT_A },
      connectionId: CONNECTION_A,
      expectedRevision: 99,
    },
    {
      label: "missing connection",
      scope: { userId: USER_A, agentId: AGENT_A },
      connectionId: "10000000-0000-4000-8000-000000000099",
      expectedRevision: 1,
    },
    {
      label: "other user",
      scope: { userId: USER_A, agentId: AGENT_A },
      connectionId: CONNECTION_B,
      expectedRevision: 1,
    },
    {
      label: "other agent",
      scope: { userId: USER_A, agentId: AGENT_A },
      connectionId: CONNECTION_A2,
      expectedRevision: 1,
    },
  ])("uses one non-enumerating conflict for $label", async ({
    scope,
    connectionId,
    expectedRevision,
  }) => {
    if (keyState.status !== "ready") throw new Error("test_key_not_ready");
    const service = createChannelConnectionAuditService(
      primaryPool,
      keyState.key,
    );
    let captured: unknown;

    try {
      await service.update({
        ...updateInput({
          expectedRevision,
          secret: TEST_SECRET,
        }),
        scope,
        connectionId,
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toMatchObject({
      status: 409,
      code: "config_revision_conflict",
      message: "config_revision_conflict",
    });
    const serialized = `${String(captured)} ${inspect(captured)} ${JSON.stringify(captured)}`;
    expect(serialized).not.toContain(TEST_SECRET);
    expect(serialized).not.toContain(CONNECTION_B);
    expect(serialized).not.toContain(CONNECTION_A2);
    const changed = await primaryPool.query<{ count: string }>(
      `SELECT count(*) AS count
       FROM admin_audit_logs`,
    );
    expect(changed.rows[0].count).toBe("0");
  });

  it("rolls back config, secret and audit when the audit insert fails", async () => {
    if (keyState.status !== "ready") throw new Error("test_key_not_ready");
    await primaryPool.query(`
      CREATE OR REPLACE FUNCTION reject_task5_audit()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced_audit_failure';
      END
      $$;
      CREATE TRIGGER reject_task5_audit
      BEFORE INSERT ON admin_audit_logs
      FOR EACH ROW EXECUTE FUNCTION reject_task5_audit();
    `);
    const service = createChannelConnectionAuditService(
      primaryPool,
      keyState.key,
    );

    await expect(
      service.update(updateInput({ secret: TEST_SECRET })),
    ).rejects.toThrow("forced_audit_failure");

    const state = await primaryPool.query<{
      config: Record<string, unknown>;
      revision: number;
      secrets: string;
      audits: string;
    }>(
      `SELECT config, revision,
              (SELECT count(*) FROM channel_secrets
               WHERE connection_id = channel_connections.id) AS secrets,
              (SELECT count(*) FROM admin_audit_logs
               WHERE resource_id = channel_connections.id::text) AS audits
       FROM channel_connections
       WHERE id = $1`,
      [CONNECTION_A],
    );
    expect(state.rows[0]).toEqual({
      config: { endpoint: "old-a" },
      revision: 1,
      secrets: "0",
      audits: "0",
    });
    await primaryPool.query(`
      DROP TRIGGER reject_task5_audit ON admin_audit_logs;
      DROP FUNCTION reject_task5_audit();
    `);
  });

  it("keeps plaintext out of config, audit, results, errors and ordinary logs", async () => {
    if (keyState.status !== "ready") throw new Error("test_key_not_ready");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const service = createChannelConnectionAuditService(
        primaryPool,
        keyState.key,
      );
      const result = await service.update(updateInput({ secret: TEST_SECRET }));
      expect(JSON.stringify(result)).not.toContain(TEST_SECRET);
      await expect(
        service.update(updateInput({ secret: OTHER_SECRET })),
      ).rejects.toMatchObject({ code: "config_revision_conflict" });
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }

    const publicDatabaseText = await primaryPool.query<{ value: string }>(
      `SELECT concat_ws(
         E'\n',
         (SELECT COALESCE(string_agg(config::text, E'\n'), '')
          FROM channel_connections),
         (SELECT COALESCE(string_agg(
            concat_ws(' ', before_summary::text, after_summary::text,
              COALESCE(confirmation_source::text, ''), COALESCE(error_code, '')),
            E'\n'
          ), '') FROM admin_audit_logs)
       ) AS value`,
    );
    expect(publicDatabaseText.rows[0].value).not.toContain(TEST_SECRET);
    expect(publicDatabaseText.rows[0].value).not.toContain(OTHER_SECRET);

    const secretStorage = await primaryPool.query<{
      ciphertext: Buffer;
      nonce: Buffer;
      auth_tag: Buffer;
    }>(
      `SELECT ciphertext, nonce, auth_tag
       FROM channel_secrets
       WHERE connection_id = $1`,
      [CONNECTION_A],
    );
    const storageText = secretStorage.rows
      .flatMap((row) => [row.ciphertext, row.nonce, row.auth_tag])
      .map((value) => value.toString("base64"))
      .join("\n");
    expect(storageText).not.toContain(TEST_SECRET);
  });

  it("rejects secret fields in public config and unsafe confirmation metadata", async () => {
    if (keyState.status !== "ready") throw new Error("test_key_not_ready");
    const service = createChannelConnectionAuditService(
      primaryPool,
      keyState.key,
    );

    await expect(
      service.update({
        ...updateInput({ secret: TEST_SECRET }),
        config: { endpoint: "safe", bot_token: TEST_SECRET },
      }),
    ).rejects.toMatchObject({ code: "secret_in_public_config" });
    await expect(
      service.update({
        ...updateInput({ secret: TEST_SECRET }),
        confirmationSource: {
          type: "console",
          requestId: REQUEST_ID,
          raw: TEST_SECRET,
        } as never,
      }),
    ).rejects.toMatchObject({ code: "invalid_confirmation_source" });
    const unchanged = await primaryPool.query<{
      revision: number;
      audits: string;
      secrets: string;
    }>(
      `SELECT revision,
              (SELECT count(*) FROM admin_audit_logs) AS audits,
              (SELECT count(*) FROM channel_secrets) AS secrets
       FROM channel_connections
       WHERE id = $1`,
      [CONNECTION_A],
    );
    expect(unchanged.rows[0]).toEqual({
      revision: 1,
      audits: "0",
      secrets: "0",
    });
  });

  it.each([
    ["newline at top level", "line-one\nline-two", (secret: string) => ({
      endpoint: secret,
    })],
    ["quote in a nested object", 'secret-"quoted"-value', (secret: string) => ({
      endpoint: "safe",
      nested: { token: secret },
    })],
    ["backslash in a nested array", String.raw`secret\path\value`, (secret: string) => ({
      endpoint: "safe",
      nested: ["safe", secret],
    })],
  ])(
    "rejects an exact escaped secret value from public config: %s",
    async (_label, secret, buildConfig) => {
      if (keyState.status !== "ready") throw new Error("test_key_not_ready");
      const service = createChannelConnectionAuditService(
        primaryPool,
        keyState.key,
      );

      await expect(
        service.update({
          ...updateInput({ secret }),
          config: buildConfig(secret),
        }),
      ).rejects.toMatchObject({
        status: 400,
        code: "secret_in_public_config",
      });
      const unchanged = await primaryPool.query<{
        revision: number;
        audits: string;
        secrets: string;
      }>(
        `SELECT revision,
                (SELECT count(*) FROM admin_audit_logs) AS audits,
                (SELECT count(*) FROM channel_secrets) AS secrets
         FROM channel_connections
         WHERE id = $1`,
        [CONNECTION_A],
      );
      expect(unchanged.rows[0]).toEqual({
        revision: 1,
        audits: "0",
        secrets: "0",
      });
    },
  );

  it("accepts safe public config containing but not equaling a one-character secret", async () => {
    if (keyState.status !== "ready") throw new Error("test_key_not_ready");
    const service = createChannelConnectionAuditService(
      primaryPool,
      keyState.key,
    );

    await expect(
      service.update({
        ...updateInput({ secret: "e" }),
        config: { endpoint: "safe" },
      }),
    ).resolves.toEqual({ revision: 2 });
    const stored = await primaryPool.query<{
      config: Record<string, unknown>;
      audit_text: string;
    }>(
      `SELECT config,
              (SELECT concat(before_summary::text, after_summary::text)
               FROM admin_audit_logs
               WHERE resource_id = channel_connections.id::text) AS audit_text
       FROM channel_connections
       WHERE id = $1`,
      [CONNECTION_A],
    );
    expect(stored.rows[0].config).toEqual({ endpoint: "safe" });
    expect(stored.rows[0].audit_text).not.toContain('"bot_token":"e"');
  });

  it.each([
    ["unmodified", []],
    [
      "deleted",
      [{ fieldName: "bot_token", operation: "delete" as const }],
    ],
  ])(
    "rejects an existing %s declared secret copied into public config without writes",
    async (_label, secretChanges) => {
      if (keyState.status !== "ready") throw new Error("test_key_not_ready");
      const service = createChannelConnectionAuditService(
        primaryPool,
        keyState.key,
      );
      await service.update(updateInput({ secret: TEST_SECRET }));
      let captured: unknown;

      try {
        await service.update({
          ...updateInput({
            expectedRevision: 2,
            secret: OTHER_SECRET,
            config: {
              endpoint:
                `https://example.test/hook?token=${TEST_SECRET}`,
            },
          }),
          secretChanges,
        });
      } catch (error) {
        captured = error;
      }

      expect(captured).toMatchObject({
        status: 400,
        code: "secret_in_public_config",
        message: "secret_in_public_config",
      });
      expect(
        `${String(captured)} ${inspect(captured)} ${JSON.stringify(captured)}`,
      ).not.toContain(TEST_SECRET);
      const unchanged = await primaryPool.query<{
        config: Record<string, unknown>;
        revision: number;
        audits: string;
        secrets: string;
      }>(
        `SELECT config, revision,
                (SELECT count(*) FROM admin_audit_logs) AS audits,
                (SELECT count(*) FROM channel_secrets) AS secrets
         FROM channel_connections
         WHERE id = $1`,
        [CONNECTION_A],
      );
      expect(unchanged.rows[0]).toEqual({
        config: { endpoint: "new-a" },
        revision: 2,
        audits: "1",
        secrets: "1",
      });
    },
  );

  it("enforces scoped foreign keys and preserves audit history after agent deletion", async () => {
    await expect(
      primaryPool.query(
        `INSERT INTO channel_connections (
           user_id, agent_id, channel_type, display_name
         )
         VALUES ($1, $2, 'telegram', 'Wrong scope')`,
        [USER_B, AGENT_A],
      ),
    ).rejects.toThrow();
    await expect(
      primaryPool.query(
        `INSERT INTO channel_secrets (
           connection_id, field_name, ciphertext, nonce, auth_tag, key_version
         )
         VALUES ($1, 'bot_token', decode('00', 'hex'),
           decode('00', 'hex'), decode('00', 'hex'), 1)`,
        [CONNECTION_A],
      ),
    ).rejects.toThrow();

    if (keyState.status !== "ready") throw new Error("test_key_not_ready");
    await createChannelConnectionAuditService(
      primaryPool,
      keyState.key,
    ).update(updateInput({ secret: TEST_SECRET }));
    await primaryPool.query(
      `DELETE FROM digital_agents
       WHERE user_id = $1 AND id = $2`,
      [USER_A, AGENT_A],
    );
    const preserved = await primaryPool.query<{
      user_id: string;
      agent_id: string | null;
      connection_count: string;
      secret_count: string;
    }>(
      `SELECT user_id, agent_id,
              (SELECT count(*) FROM channel_connections
               WHERE id = $1::uuid) AS connection_count,
              (SELECT count(*) FROM channel_secrets
               WHERE connection_id = $1::uuid) AS secret_count
       FROM admin_audit_logs
       WHERE resource_id = $1::text`,
      [CONNECTION_A],
    );
    expect(preserved.rows[0]).toEqual({
      user_id: USER_A,
      agent_id: null,
      connection_count: "0",
      secret_count: "0",
    });
  });
});

function updateInput(options: {
  expectedRevision?: number;
  config?: Record<string, unknown>;
  secret: string;
  requestId?: string;
}) {
  const requestId = options.requestId
    ?? `10000000-0000-4000-8000-${String(
      31 + requestSequence++,
    ).padStart(12, "0")}`;
  return {
    scope: { userId: USER_A, agentId: AGENT_A },
    connectionId: CONNECTION_A,
    expectedRevision: options.expectedRevision ?? 1,
    config: options.config ?? { endpoint: "new-a" },
    secretFieldNames: ["bot_token"],
    secretChanges: [
      {
        fieldName: "bot_token",
        operation: "set" as const,
        value: options.secret,
      },
    ],
    auditConfigFields: ["endpoint"],
    confirmationSource: {
      type: "console" as const,
      requestId,
    },
  };
}

function createAuditCommitHarness(
  pool: Pool,
  outcome: "committed" | "not_committed" | "mismatch" | "unknown",
) {
  let connectionIndex = 0;
  const releases: unknown[][] = [];
  return {
    releases,
    pool: {
      connect: async () => {
        const index = connectionIndex;
        connectionIndex += 1;
        if (index > 0 && outcome === "unknown") {
          throw new Error("recovery_connection_unavailable");
        }
        const client = await pool.connect();
        return new Proxy(client, {
          get(target, property) {
            if (property === "query" && index === 0) {
              return async (
                queryText: string,
                values?: readonly unknown[],
              ) => {
                if (queryText === "COMMIT") {
                  if (
                    outcome === "committed"
                    || outcome === "mismatch"
                  ) {
                    await target.query("COMMIT");
                    if (outcome === "mismatch") {
                      await target.query(
                        `UPDATE admin_audit_logs
                         SET confirmation_source = jsonb_set(
                           confirmation_source,
                           '{inputFingerprint}',
                           '"mismatch"'::jsonb,
                           true
                         )
                         WHERE confirmation_source->>'requestId' = $1`,
                        [REQUEST_ID],
                      );
                    }
                  } else {
                    await target.query("ROLLBACK");
                  }
                  throw new Error("commit_response_lost");
                }
                return values === undefined
                  ? target.query(queryText)
                  : target.query(queryText, [...values]);
              };
            }
            if (property === "release") {
              return (...args: unknown[]) => {
                releases[index] = args;
                return target.release(...args as [boolean?]);
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function"
              ? value.bind(target)
              : value;
          },
        }) as PoolClient;
      },
    } as Pool,
  };
}

function adaptSchemaForEmbeddedPostgres(source: string): string {
  return source
    .replace("CREATE EXTENSION IF NOT EXISTS vector;", "")
    .replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", "")
    .replaceAll("vector(1536)", "vector")
    .replace(/^CREATE INDEX IF NOT EXISTS idx_memory_entries_embedding.*$/m, "");
}

async function installVectorCompatibility(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE DOMAIN vector AS text;
    CREATE FUNCTION vector_cosine_distance(vector, vector)
      RETURNS double precision LANGUAGE sql IMMUTABLE AS $$ SELECT 1.0 $$;
    CREATE OPERATOR <=> (
      LEFTARG = vector,
      RIGHTARG = vector,
      PROCEDURE = vector_cosine_distance
    );
  `);
}

async function reservePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed_to_reserve_port");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}
