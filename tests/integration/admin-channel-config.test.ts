import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import EmbeddedPostgres from "embedded-postgres";
import { Pool, type PoolClient } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  AdminChannelConfigError,
  createAdminChannelConfigService,
} from "@/server/admin/channel-config";
import type {
  AdminChannelConfigWrite,
} from "@/server/admin/compat/handlers/channels";
import {
  createChannelSecretsKey,
  encryptedSecretFromStorage,
} from "@/server/security/encrypted-secret";
import { getChannelManifest } from "@/server/channels/manifests/catalog";
import { CHANNEL_TYPES } from "@/server/channels/manifests/catalog";
import {
  trackEmbeddedPostgresPool,
  type EmbeddedPostgresLifecycle,
} from "./embedded-postgres-lifecycle";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_ID = "10000000-0000-4000-8000-000000000011";
const OPERATION_ID = "30000000-0000-4000-8000-000000000031";
const OTHER_OPERATION_ID = "30000000-0000-4000-8000-000000000032";
const TOKEN = "integration-secret-token";
const KEY = Buffer.alloc(32, 23).toString("base64");

describe("admin channel configuration service", () => {
  let database: EmbeddedPostgres;
  let directory: string;
  let primary: Pool;
  let secondary: Pool;
  let lifecycle: EmbeddedPostgresLifecycle;
  const key = createChannelSecretsKey(KEY);

  beforeAll(async () => {
    if (key.status !== "ready") throw new Error("test_key_not_ready");
    const port = await reservePort();
    directory = await mkdtemp(
      path.join(os.tmpdir(), "digitalmate-admin-channels-"),
    );
    database = new EmbeddedPostgres({
      databaseDir: directory,
      port,
      user: "postgres",
      password: "digitalmate-test",
      persistent: false,
      onLog: () => undefined,
      onError: () => undefined,
    });
    await database.initialise();
    await database.start();
    const url =
      `postgresql://postgres:digitalmate-test@127.0.0.1:${port}/postgres`;
    primary = new Pool({ connectionString: url });
    secondary = new Pool({ connectionString: url });
    lifecycle = trackEmbeddedPostgresPool(primary);
    await installVectorCompatibility(primary);
    const schema = adaptSchemaForEmbeddedPostgres(
      await readFile(
        path.join(process.cwd(), "src/server/db/schema.sql"),
        "utf8",
      ),
    );
    await primary.query(schema);
  }, 60_000);

  beforeEach(async () => {
    await primary.query(`
      TRUNCATE admin_audit_logs, channel_secrets, channel_connections,
        digital_agents, users CASCADE
    `);
    await primary.query(
      `INSERT INTO users (id, display_name)
       VALUES ($1, 'User')`,
      [USER_ID],
    );
    await primary.query(
      `INSERT INTO digital_agents (
         id, user_id, slug, display_name, is_default
       )
       VALUES ($1, $2, 'default', 'DigitalMate', true)`,
      [AGENT_ID, USER_ID],
    );
  });

  afterAll(async () => {
    await secondary?.end();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await lifecycle?.stop(database);
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns 17 virtual revision-zero defaults without writing rows", async () => {
    if (key.status !== "ready") throw new Error("test_key_not_ready");
    const service = createAdminChannelConfigService(primary, key.key);
    const channels = await service.read({
      userId: USER_ID,
      agentId: AGENT_ID,
    });

    expect(Object.keys(channels)).toHaveLength(17);
    expect(channels.telegram).toMatchObject({
      type: "telegram",
      revision: 0,
      enabled: false,
      health: { status: "disabled" },
      secrets: {
        bot_token: {
          configured: false,
          lastRotatedAt: null,
        },
      },
    });
    const count = await primary.query<{ count: string }>(
      "SELECT count(*) FROM channel_connections",
    );
    expect(count.rows[0].count).toBe("0");
  });

  it("creates revision one atomically and recovers the same operation exactly once", async () => {
    if (key.status !== "ready") throw new Error("test_key_not_ready");
    const first = createAdminChannelConfigService(primary, key.key);
    const second = createAdminChannelConfigService(secondary, key.key);
    const input = createInput(OPERATION_ID);
    const results = await Promise.all([
      first.update(input),
      second.update(input),
    ]);

    expect(results.map((result) => result.revision)).toEqual([1, 1]);
    const stored = await primary.query<{
      revision: number;
      enabled: boolean;
      config: Record<string, unknown>;
      health_status: string;
      health_detail: Record<string, unknown>;
    }>(
      `SELECT revision, enabled, config, health_status, health_detail
       FROM channel_connections`,
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({
      revision: 1,
      enabled: true,
      config: {
        filter_tool_messages: true,
        filter_thinking: true,
      },
      health_status: "blocked",
      health_detail: { code: "runtime_not_implemented" },
    });
    const audit = await primary.query<{
      action: string;
      resource_type: string;
      confirmation_source: Record<string, unknown>;
      before_summary: Record<string, unknown>;
      after_summary: Record<string, unknown>;
    }>("SELECT * FROM admin_audit_logs");
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      action: "channel_connection.create",
      resource_type: "channel_connection",
      confirmation_source: {
        type: "console",
        requestId: OPERATION_ID,
      },
      before_summary: { revision: 0 },
      after_summary: {
        revision: 1,
        channel_type: "telegram",
        enabled: true,
      },
    });
    expect(JSON.stringify(audit.rows[0])).not.toContain(TOKEN);
  });

  it.each([
    [
      "机器人前缀",
      "telegram" as const,
      {
        bot_prefix: `Bearer ${TOKEN}`,
        filter_tool_messages: true,
        filter_thinking: true,
      },
      "bot_token",
    ],
    [
      "URL 查询参数",
      "telegram" as const,
      {
        base_url: `https://api.telegram.test/?token=${TOKEN}`,
        filter_tool_messages: true,
        filter_thinking: true,
      },
      "bot_token",
    ],
    [
      "嵌套对象键",
      "matrix" as const,
      {
        groups: {
          [TOKEN]: { autoReply: true },
        },
        filter_tool_messages: true,
        filter_thinking: true,
      },
      "access_token",
    ],
  ])(
    "rejects a newly supplied secret repeated in public %s before any durable write",
    async (_label, type, config, secretFieldName) => {
      if (key.status !== "ready") throw new Error("test_key_not_ready");
      const service = createAdminChannelConfigService(primary, key.key);

      const error = await service.update({
        scope: { userId: USER_ID, agentId: AGENT_ID },
        type,
        operationId: OPERATION_ID,
        expectedRevision: 0,
        enabled: false,
        config,
        secretChanges: [
          {
            fieldName: secretFieldName,
            operation: "set",
            value: TOKEN,
          },
        ],
      }).catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        status: 400,
        code: "secret_in_public_config",
        message: "secret_in_public_config",
      });
      expect(JSON.stringify(error)).not.toContain(TOKEN);
      await expect(readDurableChannelText(primary)).resolves.not.toContain(
        TOKEN,
      );
      await expect(readChannelWriteCounts(primary)).resolves.toEqual({
        connections: "0",
        secrets: "0",
        audits: "0",
      });
    },
  );

  it("rejects a retained encrypted secret repeated in the next public config", async () => {
    if (key.status !== "ready") throw new Error("test_key_not_ready");
    const service = createAdminChannelConfigService(primary, key.key);
    await service.update(createInput(OPERATION_ID));

    const error = await service.update({
      ...createInput(OTHER_OPERATION_ID),
      expectedRevision: 1,
      config: {
        bot_prefix: `token=${TOKEN}`,
        filter_tool_messages: true,
        filter_thinking: true,
      },
      secretChanges: [],
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      status: 400,
      code: "secret_in_public_config",
    });
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    const stored = await primary.query<{
      revision: number;
      config: Record<string, unknown>;
    }>("SELECT revision, config FROM channel_connections");
    expect(stored.rows).toMatchObject([
      {
        revision: 1,
        config: {
          bot_prefix: "",
          filter_tool_messages: true,
          filter_thinking: true,
        },
      },
    ]);
    await expect(readDurableChannelText(primary)).resolves.not.toContain(
      TOKEN,
    );
    await expect(readChannelWriteCounts(primary)).resolves.toEqual({
      connections: "1",
      secrets: "1",
      audits: "1",
    });
  });

  it("rejects a rotated secret repeated in public config before updating the row or audit", async () => {
    if (key.status !== "ready") throw new Error("test_key_not_ready");
    const service = createAdminChannelConfigService(primary, key.key);
    await service.update(createInput(OPERATION_ID));
    const rotated = "rotated-integration-token";

    const error = await service.update({
      ...createInput(OTHER_OPERATION_ID),
      expectedRevision: 1,
      config: {
        bot_prefix: `Bearer ${rotated}`,
        filter_tool_messages: true,
        filter_thinking: true,
      },
      secretChanges: [
        {
          fieldName: "bot_token",
          operation: "set",
          value: rotated,
        },
      ],
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      status: 400,
      code: "secret_in_public_config",
    });
    expect(JSON.stringify(error)).not.toContain(rotated);
    await expect(readDurableChannelText(primary)).resolves.not.toContain(
      rotated,
    );
    await expect(readChannelWriteCounts(primary)).resolves.toEqual({
      connections: "1",
      secrets: "1",
      audits: "1",
    });
  });

  it("rejects moving an existing credential into public config while deleting it", async () => {
    if (key.status !== "ready") throw new Error("test_key_not_ready");
    const service = createAdminChannelConfigService(primary, key.key);
    await service.update(createInput(OPERATION_ID));

    const error = await service.update({
      ...createInput(OTHER_OPERATION_ID),
      expectedRevision: 1,
      config: {
        bot_prefix: TOKEN,
        filter_tool_messages: true,
        filter_thinking: true,
      },
      secretChanges: [
        { fieldName: "bot_token", operation: "delete" },
      ],
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      status: 400,
      code: "secret_in_public_config",
    });
    await expect(readChannelWriteCounts(primary)).resolves.toEqual({
      connections: "1",
      secrets: "1",
      audits: "1",
    });
  });

  it("rejects a rotated or deleted historical credential in later public config", async () => {
    if (key.status !== "ready") throw new Error("test_key_not_ready");
    const service = createAdminChannelConfigService(primary, key.key);
    const rotated = "integration-rotated-token";
    await service.update(createInput(OPERATION_ID));
    await service.update({
      ...createInput(OTHER_OPERATION_ID),
      expectedRevision: 1,
      secretChanges: [{
        fieldName: "bot_token",
        operation: "set",
        value: rotated,
      }],
    });

    await expect(service.update({
      ...createInput("30000000-0000-4000-8000-000000000033"),
      expectedRevision: 2,
      config: {
        bot_prefix: `Bearer ${TOKEN}`,
        filter_tool_messages: true,
        filter_thinking: true,
      },
      secretChanges: [],
    })).rejects.toMatchObject({
      status: 400,
      code: "secret_in_public_config",
    });

    await service.update({
      ...createInput("30000000-0000-4000-8000-000000000034"),
      expectedRevision: 2,
      secretChanges: [{
        fieldName: "bot_token",
        operation: "delete",
      }],
    });
    await expect(service.update({
      ...createInput("30000000-0000-4000-8000-000000000035"),
      expectedRevision: 3,
      config: {
        bot_prefix: `Bearer ${rotated}`,
        filter_tool_messages: true,
        filter_thinking: true,
      },
      secretChanges: [],
    })).rejects.toMatchObject({
      status: 400,
      code: "secret_in_public_config",
    });

    const fingerprints = await primary.query<{
      digest: Buffer;
      utf8_bytes: number;
      character_length: number;
    }>(
      `SELECT digest, utf8_bytes, character_length
       FROM channel_secret_exposure_fingerprints
       ORDER BY created_at`,
    );
    expect(fingerprints.rows).toHaveLength(2);
    expect(fingerprints.rows.every((row) =>
      row.digest.length === 32
      && row.utf8_bytes > 0
      && row.character_length > 0
    )).toBe(true);
    expect(JSON.stringify(fingerprints.rows)).not.toContain(TOKEN);
    expect(JSON.stringify(fingerprints.rows)).not.toContain(rotated);
  });

  it("isolates historical credential fingerprints by connection owner", async () => {
    if (key.status !== "ready") throw new Error("test_key_not_ready");
    const otherUserId =
      "10000000-0000-4000-8000-000000000002";
    const otherAgentId =
      "10000000-0000-4000-8000-000000000012";
    await primary.query(
      `INSERT INTO users (id, display_name)
       VALUES ($1, 'Other user')`,
      [otherUserId],
    );
    await primary.query(
      `INSERT INTO digital_agents (
         id, user_id, slug, display_name, is_default
       )
       VALUES ($1, $2, 'default', 'Other mate', true)`,
      [otherAgentId, otherUserId],
    );
    const service = createAdminChannelConfigService(primary, key.key);
    await service.update(createInput(OPERATION_ID));
    await service.update({
      ...createInput("30000000-0000-4000-8000-000000000036"),
      scope: {
        userId: otherUserId,
        agentId: otherAgentId,
      },
      secretChanges: [{
        fieldName: "bot_token",
        operation: "set",
        value: "other-owner-secret",
      }],
    });

    await expect(service.update({
      ...createInput("30000000-0000-4000-8000-000000000037"),
      scope: {
        userId: otherUserId,
        agentId: otherAgentId,
      },
      expectedRevision: 1,
      config: {
        bot_prefix: `Bearer ${TOKEN}`,
        filter_tool_messages: true,
        filter_thinking: true,
      },
      secretChanges: [],
    })).resolves.toMatchObject({ revision: 2 });
  });

  it("rejects a Telegram credential copied into a Discord public config", async () => {
    if (key.status !== "ready") throw new Error("test_key_not_ready");
    const service = createAdminChannelConfigService(primary, key.key);
    await service.update(createInput(OPERATION_ID));

    await expect(service.update({
      scope: { userId: USER_ID, agentId: AGENT_ID },
      type: "discord",
      operationId: "30000000-0000-4000-8000-000000000038",
      expectedRevision: 0,
      enabled: false,
      config: {
        bot_prefix: `Bearer ${TOKEN}`,
        filter_tool_messages: true,
        filter_thinking: true,
      },
      secretChanges: [],
    })).rejects.toMatchObject({
      status: 400,
      code: "secret_in_public_config",
    });
    const discord = await primary.query<{ count: string }>(
      `SELECT count(*) AS count
       FROM channel_connections
       WHERE user_id = $1 AND channel_type = 'discord'`,
      [USER_ID],
    );
    expect(discord.rows[0].count).toBe("0");
  });

  it("rejects a bulk secret copied from one channel into another before any write", async () => {
    if (key.status !== "ready") throw new Error("test_key_not_ready");
    const service = createAdminChannelConfigService(primary, key.key);
    const inputs = CHANNEL_TYPES.map((type, index) => ({
      scope: { userId: USER_ID, agentId: AGENT_ID },
      type,
      operationId:
        `30000000-0000-4000-8001-${String(index + 1).padStart(12, "0")}`,
      expectedRevision: 0,
      enabled: false,
      config: type === "discord"
        ? {
            bot_prefix: `Bearer ${TOKEN}`,
            filter_tool_messages: true,
            filter_thinking: true,
          }
        : {},
      secretChanges: type === "telegram"
        ? [{
            fieldName: "bot_token",
            operation: "set" as const,
            value: TOKEN,
          }]
        : [],
    }));

    await expect(service.updateMany(inputs)).rejects.toMatchObject({
      status: 400,
      code: "secret_in_public_config",
    });
    await expect(readChannelWriteCounts(primary)).resolves.toEqual({
      connections: "0",
      secrets: "0",
      audits: "0",
    });
  });

  it("retains historical credentials after a source connection is hard-deleted", async () => {
    if (key.status !== "ready") throw new Error("test_key_not_ready");
    const service = createAdminChannelConfigService(primary, key.key);
    await service.update(createInput(OPERATION_ID));
    await primary.query(
      `DELETE FROM channel_connections
       WHERE user_id = $1 AND channel_type = 'telegram'`,
      [USER_ID],
    );

    await expect(service.update({
      scope: { userId: USER_ID, agentId: AGENT_ID },
      type: "discord",
      operationId: "30000000-0000-4000-8000-000000000039",
      expectedRevision: 0,
      enabled: false,
      config: {
        bot_prefix: TOKEN,
        filter_tool_messages: true,
        filter_thinking: true,
      },
      secretChanges: [],
    })).rejects.toMatchObject({
      status: 400,
      code: "secret_in_public_config",
    });
    const fingerprints = await primary.query<{ count: string }>(
      `SELECT count(*) AS count
       FROM channel_secret_exposure_fingerprints
       WHERE user_id = $1`,
      [USER_ID],
    );
    expect(fingerprints.rows[0].count).toBe("1");
  });

  it("rejects a secret exposure in the second bulk item before the first item writes", async () => {
    if (key.status !== "ready") throw new Error("test_key_not_ready");
    const service = createAdminChannelConfigService(primary, key.key);
    const inputs = CHANNEL_TYPES.map((type, index) => ({
      scope: { userId: USER_ID, agentId: AGENT_ID },
      type,
      operationId:
        `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      expectedRevision: 0,
      enabled: false,
      config:
        type === "discord"
          ? {
              bot_prefix: `Bearer ${TOKEN}`,
              filter_tool_messages: true,
              filter_thinking: true,
            }
          : {},
      secretChanges:
        type === "discord"
          ? [
              {
                fieldName: "bot_token",
                operation: "set" as const,
                value: TOKEN,
              },
            ]
          : [],
    }));

    const error = await service.updateMany(inputs).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({
      status: 400,
      code: "secret_in_public_config",
    });
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    await expect(readDurableChannelText(primary)).resolves.not.toContain(
      TOKEN,
    );
    await expect(readChannelWriteCounts(primary)).resolves.toEqual({
      connections: "0",
      secrets: "0",
      audits: "0",
    });
  });

  it("allows only one different operation to create the canonical connection", async () => {
    if (key.status !== "ready") throw new Error("test_key_not_ready");
    const first = createAdminChannelConfigService(primary, key.key);
    const second = createAdminChannelConfigService(secondary, key.key);
    const outcomes = await Promise.allSettled([
      first.update(createInput(OPERATION_ID)),
      second.update(createInput(OTHER_OPERATION_ID)),
    ]);

    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.find(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === "rejected",
      )?.reason,
    ).toMatchObject({
      status: 409,
      code: "config_revision_conflict",
    });
  });

  it("retains an omitted secret, explicitly clears it and fails closed on ambiguity", async () => {
    if (key.status !== "ready") throw new Error("test_key_not_ready");
    const service = createAdminChannelConfigService(primary, key.key);
    const created = await service.update(createInput(OPERATION_ID));
    expect(created.secrets.bot_token.configured).toBe(true);
    const retained = await service.update({
      ...createInput(OTHER_OPERATION_ID),
      expectedRevision: 1,
      enabled: false,
      secretChanges: [],
    });
    expect(retained.secrets.bot_token.configured).toBe(true);
    const cleared = await service.update({
      ...createInput("30000000-0000-4000-8000-000000000033"),
      expectedRevision: 2,
      enabled: false,
      secretChanges: [
        { fieldName: "bot_token", operation: "delete" },
      ],
    });
    expect(cleared.secrets.bot_token.configured).toBe(false);

    await primary.query(
      `INSERT INTO channel_connections (
         user_id, agent_id, channel_type, display_name
       )
       VALUES ($1, $2, 'telegram', 'Second Telegram')`,
      [USER_ID, AGENT_ID],
    );
    await expect(
      service.read({ userId: USER_ID, agentId: AGENT_ID }),
    ).rejects.toBeInstanceOf(AdminChannelConfigError);
  });

  it("rotates encrypted secrets and binds ciphertext to user, agent, connection and field AAD", async () => {
    if (key.status !== "ready") throw new Error("test_key_not_ready");
    const service = createAdminChannelConfigService(primary, key.key);
    await service.update(createInput(OPERATION_ID));
    const before = await readStoredSecret(primary);
    await service.update({
      ...createInput(OTHER_OPERATION_ID),
      expectedRevision: 1,
      secretChanges: [
        {
          fieldName: "bot_token",
          operation: "set",
          value: "rotated-integration-token",
        },
      ],
    });
    const after = await readStoredSecret(primary);
    const encrypted = encryptedSecretFromStorage({
      ciphertext: after.ciphertext,
      nonce: after.nonce,
      authTag: after.auth_tag,
      keyVersion: after.key_version,
    });

    expect(after.ciphertext.equals(before.ciphertext)).toBe(false);
    expect(after.rotated_at.getTime()).toBeGreaterThanOrEqual(
      before.rotated_at.getTime(),
    );
    expect(
      key.key.decrypt(encrypted, {
        userId: USER_ID,
        agentId: AGENT_ID,
        connectionId: after.connection_id,
        fieldName: "bot_token",
      }),
    ).toBe("rotated-integration-token");
    for (const wrongContext of [
      {
        userId: "20000000-0000-4000-8000-000000000002",
        agentId: AGENT_ID,
        connectionId: after.connection_id,
        fieldName: "bot_token",
      },
      {
        userId: USER_ID,
        agentId: "20000000-0000-4000-8000-000000000012",
        connectionId: after.connection_id,
        fieldName: "bot_token",
      },
      {
        userId: USER_ID,
        agentId: AGENT_ID,
        connectionId: "20000000-0000-4000-8000-000000000022",
        fieldName: "bot_token",
      },
      {
        userId: USER_ID,
        agentId: AGENT_ID,
        connectionId: after.connection_id,
        fieldName: "http_proxy_auth",
      },
    ]) {
      expect(() => key.key.decrypt(encrypted, wrongContext)).toThrow();
    }
  });

  it("atomically switches Matrix credentials and audits only configured state", async () => {
    if (key.status !== "ready") throw new Error("test_key_not_ready");
    const service = createAdminChannelConfigService(primary, key.key);
    const scope = { userId: USER_ID, agentId: AGENT_ID };
    const baseConfig = {
      bot_prefix: "",
      filter_tool_messages: true,
      filter_thinking: true,
    };
    const password = await service.update({
      scope,
      type: "matrix",
      operationId: OPERATION_ID,
      expectedRevision: 0,
      enabled: false,
      config: baseConfig,
      secretChanges: [
        {
          fieldName: "password",
          operation: "set",
          value: "matrix-password",
        },
      ],
    });
    expect(password.secrets).toMatchObject({
      access_token: { configured: false },
      password: { configured: true },
    });

    const token = await service.update({
      scope,
      type: "matrix",
      operationId: OTHER_OPERATION_ID,
      expectedRevision: 1,
      enabled: false,
      config: baseConfig,
      secretChanges: [
        {
          fieldName: "access_token",
          operation: "set",
          value: "matrix-token",
        },
        { fieldName: "password", operation: "delete" },
      ],
    });
    expect(token.secrets).toMatchObject({
      access_token: { configured: true },
      password: { configured: false },
    });

    const passwordAgain = await service.update({
      scope,
      type: "matrix",
      operationId: "30000000-0000-4000-8000-000000000033",
      expectedRevision: 2,
      enabled: false,
      config: baseConfig,
      secretChanges: [
        {
          fieldName: "password",
          operation: "set",
          value: "matrix-password-again",
        },
        { fieldName: "access_token", operation: "delete" },
      ],
    });
    expect(passwordAgain.secrets).toMatchObject({
      access_token: { configured: false },
      password: { configured: true },
    });

    const stored = await primary.query<{ field_name: string }>(
      `SELECT field_name
       FROM channel_secrets
       ORDER BY field_name`,
    );
    expect(stored.rows).toEqual([{ field_name: "password" }]);
    const audits = await primary.query<{
      before_summary: Record<string, unknown>;
      after_summary: Record<string, unknown>;
    }>(
      `SELECT before_summary, after_summary
       FROM admin_audit_logs
       ORDER BY created_at`,
    );
    expect(audits.rows).toHaveLength(3);
    expect(audits.rows[1].after_summary).toMatchObject({
      secrets: {
        access_token: { configured: true },
        password: { configured: false },
      },
    });
    expect(audits.rows[2].after_summary).toMatchObject({
      secrets: {
        access_token: { configured: false },
        password: { configured: true },
      },
    });
    expect(JSON.stringify(audits.rows)).not.toContain("matrix-token");
    expect(JSON.stringify(audits.rows)).not.toContain("matrix-password");
    expect((await service.read(scope)).matrix.secrets).toMatchObject({
      access_token: { configured: false },
      password: { configured: true },
    });
  });

  it("aborts an advisory-lock wait promptly and remains reusable", async () => {
    if (key.status !== "ready") throw new Error("test_key_not_ready");
    const blocker = await secondary.connect();
    const controller = new AbortController();
    const service = createAdminChannelConfigService(primary, key.key, {
      lifecycleTimeoutMs: 2_000,
    });
    let rejected: unknown;
    const startedAt = Date.now();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`${USER_ID}:${AGENT_ID}:telegram`],
      );
      const pending = service.update(
        createInput(OPERATION_ID),
        controller.signal,
      );
      setTimeout(() => controller.abort(), 25);
      rejected = await pending.catch((error: unknown) => error);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }

    expect(rejected).toMatchObject({
      status: 500,
      code: "channel_config_update_failed",
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await expect(
      service.update(createInput(OPERATION_ID)),
    ).resolves.toMatchObject({ revision: 1 });
  });

  it("rolls back connection and secret writes when the success audit fails", async () => {
    if (key.status !== "ready") throw new Error("test_key_not_ready");
    await primary.query(`
      CREATE OR REPLACE FUNCTION fail_channel_audit()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.resource_type = 'channel_connection' THEN
          RAISE EXCEPTION 'forced audit failure';
        END IF;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER fail_channel_audit_trigger
      BEFORE INSERT ON admin_audit_logs
      FOR EACH ROW EXECUTE FUNCTION fail_channel_audit();
    `);
    const service = createAdminChannelConfigService(primary, key.key);
    try {
      await expect(
        service.update(createInput(OPERATION_ID)),
      ).rejects.toThrow();
    } finally {
      await primary.query(
        "DROP TRIGGER fail_channel_audit_trigger ON admin_audit_logs",
      );
      await primary.query("DROP FUNCTION fail_channel_audit()");
    }
    const counts = await primary.query<{
      connections: string;
      secrets: string;
      audits: string;
    }>(
      `SELECT
         (SELECT count(*) FROM channel_connections) AS connections,
         (SELECT count(*) FROM channel_secrets) AS secrets,
         (SELECT count(*) FROM admin_audit_logs) AS audits`,
    );
    expect(counts.rows[0]).toEqual({
      connections: "0",
      secrets: "0",
      audits: "0",
    });
  });

  it("recovers create and update after an ambiguous COMMIT from canonical audit evidence", async () => {
    if (key.status !== "ready") throw new Error("test_key_not_ready");
    const createService = createAdminChannelConfigService(
      commitOutcomeUnknownPool(primary),
      key.key,
    );
    await expect(
      createService.update(createInput(OPERATION_ID)),
    ).resolves.toMatchObject({ revision: 1 });

    const updateService = createAdminChannelConfigService(
      commitOutcomeUnknownPool(primary),
      key.key,
    );
    await expect(
      updateService.update({
        ...createInput(OTHER_OPERATION_ID),
        expectedRevision: 1,
        enabled: false,
        secretChanges: [],
      }),
    ).resolves.toMatchObject({ revision: 2, enabled: false });
    const counts = await primary.query<{
      connections: string;
      audits: string;
    }>(
      `SELECT
         (SELECT count(*) FROM channel_connections) AS connections,
         (SELECT count(*) FROM admin_audit_logs) AS audits`,
    );
    expect(counts.rows[0]).toEqual({
      connections: "1",
      audits: "2",
    });
  });

  it("does not accept a forged operation audit without its canonical active row", async () => {
    if (key.status !== "ready") throw new Error("test_key_not_ready");
    const input = createInput(OPERATION_ID);
    const fingerprint = operationFingerprint(key.key, input);
    const fakeConnectionId =
      "40000000-0000-4000-8000-000000000041";
    await primary.query(
      `INSERT INTO admin_audit_logs (
         user_id, agent_id, action, resource_type, resource_id,
         before_summary, after_summary, confirmation_source,
         status
       )
       VALUES (
         $1, $2, 'channel_connection.create', 'channel_connection',
         $3, '{"revision":0}',
         '{"revision":1,"channel_type":"telegram"}',
         $4, 'success'
       )`,
      [
        USER_ID,
        AGENT_ID,
        fakeConnectionId,
        {
          type: "console",
          requestId: OPERATION_ID,
          inputFingerprint: fingerprint,
        },
      ],
    );
    const service = createAdminChannelConfigService(primary, key.key);

    await expect(service.update(input)).rejects.toMatchObject({
      status: 500,
      code: "channel_config_update_failed",
    });
    const count = await primary.query<{ count: string }>(
      "SELECT count(*) FROM channel_connections",
    );
    expect(count.rows[0].count).toBe("0");
  });

  it("bounds the batch read in SQL and joins only manifest-declared secret metadata", async () => {
    if (key.status !== "ready") throw new Error("test_key_not_ready");
    await primary.query(
      `INSERT INTO channel_connections (
         user_id, agent_id, channel_type, display_name
       )
       VALUES
         ($1, $2, 'telegram', 'Telegram 1'),
         ($1, $2, 'telegram', 'Telegram 2'),
         ($1, $2, 'telegram', 'Telegram 3')`,
      [USER_ID, AGENT_ID],
    );
    const statements: string[] = [];
    const service = createAdminChannelConfigService(
      recordingPool(primary, statements),
      key.key,
    );

    await expect(
      service.read({ userId: USER_ID, agentId: AGENT_ID }),
    ).rejects.toMatchObject({
      status: 409,
      code: "channel_connection_ambiguous",
    });
    const batchSql = statements.find((statement) =>
      statement.includes("FROM channel_connections")
    );
    expect(batchSql).toMatch(/row_number\s*\(\)/i);
    expect(batchSql).toMatch(
      /secret\.field_name\s*=\s*ANY\(/i,
    );
  });

  it("does not recover an old operation after the canonical revision advances", async () => {
    if (key.status !== "ready") throw new Error("test_key_not_ready");
    const service = createAdminChannelConfigService(primary, key.key);
    const original = createInput(OPERATION_ID);
    await service.update(original);
    await service.update({
      ...createInput(OTHER_OPERATION_ID),
      expectedRevision: 1,
      enabled: false,
      secretChanges: [],
    });

    await expect(service.update(original)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("audits the real previous public config and configured-secret state on update", async () => {
    if (key.status !== "ready") throw new Error("test_key_not_ready");
    const service = createAdminChannelConfigService(primary, key.key);
    await service.update(createInput(OPERATION_ID));
    await service.update({
      ...createInput(OTHER_OPERATION_ID),
      expectedRevision: 1,
      enabled: false,
      config: {
        bot_prefix: "next",
        filter_tool_messages: true,
        filter_thinking: true,
      },
      secretChanges: [],
    });
    const audit = await primary.query<{
      before_summary: Record<string, unknown>;
    }>(
      `SELECT before_summary
       FROM admin_audit_logs
       WHERE action = 'channel_connection.update'`,
    );

    expect(audit.rows[0].before_summary).toMatchObject({
      revision: 1,
      channel_type: "telegram",
      enabled: true,
      config: {
        bot_prefix: "",
        filter_tool_messages: true,
        filter_thinking: true,
      },
      secrets: {
        bot_token: { configured: true },
        http_proxy_auth: { configured: false },
      },
    });
  });

  it("rolls back the whole 17-channel batch when a later revision conflicts", async () => {
    if (key.status !== "ready") throw new Error("test_key_not_ready");
    await primary.query(
      `INSERT INTO channel_connections (
         user_id, agent_id, channel_type, display_name, revision
       )
       VALUES ($1, $2, 'discord', 'Existing Discord', 1)`,
      [USER_ID, AGENT_ID],
    );
    const service = createAdminChannelConfigService(primary, key.key);
    const inputs = CHANNEL_TYPES.map((type, index) => ({
      scope: { userId: USER_ID, agentId: AGENT_ID },
      type,
      operationId:
        `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      expectedRevision: 0,
      enabled: false,
      config: {},
      secretChanges: [],
    }));

    await expect(service.updateMany(inputs)).rejects.toMatchObject({
      status: 409,
      code: "config_revision_conflict",
    });
    const state = await primary.query<{
      channel_type: string;
      revision: number;
    }>(
      `SELECT channel_type, revision
       FROM channel_connections
       ORDER BY channel_type`,
    );
    expect(state.rows).toEqual([
      { channel_type: "discord", revision: 1 },
    ]);
    const audits = await primary.query<{ count: string }>(
      "SELECT count(*) FROM admin_audit_logs",
    );
    expect(audits.rows[0].count).toBe("0");
  });

  it("recovers an atomically committed 17-channel batch only when every audit and revision matches", async () => {
    if (key.status !== "ready") throw new Error("test_key_not_ready");
    const inputs = CHANNEL_TYPES.map((type, index) => ({
      scope: { userId: USER_ID, agentId: AGENT_ID },
      type,
      operationId:
        `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      expectedRevision: 0,
      enabled: false,
      config: {},
      secretChanges: [],
    }));
    const uncertain = createAdminChannelConfigService(
      commitOutcomeUnknownPool(primary),
      key.key,
    );
    const committed = await uncertain.updateMany(inputs);

    expect(
      CHANNEL_TYPES.map((type) => committed[type].revision),
    ).toEqual(Array.from({ length: 17 }, () => 1));
    const retry = await createAdminChannelConfigService(
      primary,
      key.key,
    ).updateMany(inputs);
    expect(
      CHANNEL_TYPES.map((type) => retry[type].revision),
    ).toEqual(Array.from({ length: 17 }, () => 1));
    const counts = await primary.query<{
      connections: string;
      audits: string;
    }>(
      `SELECT
         (SELECT count(*) FROM channel_connections) AS connections,
         (SELECT count(*) FROM admin_audit_logs) AS audits`,
    );
    expect(counts.rows[0]).toEqual({
      connections: "17",
      audits: "17",
    });
  });

  function createInput(operationId: string) {
    return {
      scope: { userId: USER_ID, agentId: AGENT_ID },
      type: "telegram" as const,
      operationId,
      expectedRevision: 0,
      enabled: true,
      config: {
        bot_prefix: "",
        filter_tool_messages: true,
        filter_thinking: true,
      },
      secretChanges: [
        {
          fieldName: "bot_token",
          operation: "set" as const,
          value: TOKEN,
        },
      ],
    };
  }
});

async function readStoredSecret(pool: Pool) {
  const result = await pool.query<{
    connection_id: string;
    ciphertext: Buffer;
    nonce: Buffer;
    auth_tag: Buffer;
    key_version: number;
    rotated_at: Date;
  }>(
    `SELECT connection_id, ciphertext, nonce, auth_tag, key_version,
            rotated_at
     FROM channel_secrets
     WHERE field_name = 'bot_token'`,
  );
  const row = result.rows[0];
  if (!row) throw new Error("stored_secret_not_found");
  return row;
}

async function readChannelWriteCounts(pool: Pool) {
  const result = await pool.query<{
    connections: string;
    secrets: string;
    audits: string;
  }>(
    `SELECT
       (SELECT count(*) FROM channel_connections) AS connections,
       (SELECT count(*) FROM channel_secrets) AS secrets,
       (SELECT count(*) FROM admin_audit_logs) AS audits`,
  );
  return result.rows[0];
}

async function readDurableChannelText(pool: Pool): Promise<string> {
  const result = await pool.query<{ text: string }>(
    `SELECT concat_ws(
       ' ',
       COALESCE(
         (SELECT json_agg(connection.*)::text FROM channel_connections connection),
         ''
       ),
       COALESCE(
         (SELECT json_agg(audit.*)::text FROM admin_audit_logs audit),
         ''
       )
     ) AS text`,
  );
  return result.rows[0]?.text ?? "";
}

function commitOutcomeUnknownPool(pool: Pool): Pool {
  let throwAfterCommit = true;
  return {
    connect: async () => {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, property) {
          if (property === "query") {
            return async (
              queryText: string,
              values?: readonly unknown[],
            ) => {
              const result =
                values === undefined
                  ? await target.query(queryText)
                  : await target.query(queryText, [...values]);
              if (
                throwAfterCommit &&
                queryText.trim().toUpperCase() === "COMMIT"
              ) {
                throwAfterCommit = false;
                throw new Error("commit_outcome_unknown");
              }
              return result;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function"
            ? value.bind(target)
            : value;
        },
      }) as PoolClient;
    },
  } as Pool;
}

function recordingPool(pool: Pool, statements: string[]): Pool {
  return {
    connect: async () => {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, property) {
          if (property === "query") {
            return async (
              queryText: string,
              values?: readonly unknown[],
            ) => {
              statements.push(queryText);
              return values === undefined
                ? target.query(queryText)
                : target.query(queryText, [...values]);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function"
            ? value.bind(target)
            : value;
        },
      }) as PoolClient;
    },
  } as Pool;
}

function operationFingerprint(
  key: Extract<
    ReturnType<typeof createChannelSecretsKey>,
    { status: "ready" }
  >["key"],
  input: AdminChannelConfigWrite,
): string {
  const manifest = getChannelManifest(input.type);
  const parsed = manifest.configSchema.parse({
    ...input.config,
    enabled: input.enabled,
  });
  const config = { ...parsed };
  delete config.enabled;
  for (const fieldName of manifest.secretFields) {
    delete config[fieldName];
  }
  return key.fingerprint(
    stableJson({
      type: input.type,
      expectedRevision: input.expectedRevision,
      enabled: input.enabled,
      config,
      secretChanges: input.secretChanges,
    }),
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((name) => `${JSON.stringify(name)}:${stableJson(record[name])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function adaptSchemaForEmbeddedPostgres(source: string): string {
  return source
    .replace("CREATE EXTENSION IF NOT EXISTS vector;", "")
    .replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", "")
    .replaceAll("vector(1536)", "vector")
    .replace(
      /^CREATE INDEX IF NOT EXISTS idx_memory_entries_embedding.*$/m,
      "",
    );
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
