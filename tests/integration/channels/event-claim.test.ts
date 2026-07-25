import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import EmbeddedPostgres from "embedded-postgres";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { AgentScope } from "@/server/agents/types";
import {
  createXiaoYiAdapter,
} from "@/server/channels/adapters/xiaoyi";
import {
  createXiaoYiAttachmentFetcher,
  prepareXiaoYiAttachmentBatch,
} from "@/server/channels/adapters/xiaoyi/transport";
import {
  createChannelAccessControl,
} from "@/server/channels/runtime/access";
import type {
  ChannelAdapter,
} from "@/server/channels/runtime/adapter";
import {
  createChannelAttachmentLocatorRepository,
} from "@/server/channels/runtime/attachment-ingress";
import {
  channelClientTurnId,
  createChannelEventRepository,
} from "@/server/channels/runtime/event-repository";
import {
  acceptInbound,
} from "@/server/channels/runtime/ingress";
import {
  createChannelReplyHandleRepository,
} from "@/server/channels/runtime/reply-handle";
import { createChannelDeliveryRepository } from "@/server/channels/runtime/delivery-repository";
import type { NormalizedChannelEvent } from "@/server/channels/runtime/types";
import { createChannelSecretsKey } from "@/server/security/encrypted-secret";
import {
  trackEmbeddedPostgresPool,
  type EmbeddedPostgresLifecycle,
} from "../embedded-postgres-lifecycle";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_ID = "10000000-0000-4000-8000-000000000011";
const CONNECTION_A = "20000000-0000-4000-8000-000000000001";
const CONNECTION_B = "20000000-0000-4000-8000-000000000002";
const CONVERSATION_ID = "30000000-0000-4000-8000-000000000001";
const ASSISTANT_MESSAGE_ID = "40000000-0000-4000-8000-000000000001";
const PRIVATE_ATTACHMENT_ID =
  "50000000-0000-4000-8000-000000000001";
const scope = { userId: USER_ID, agentId: AGENT_ID } satisfies AgentScope;

describe("channel event transaction ledger", () => {
  let database: EmbeddedPostgres;
  let directory: string;
  let pool: Pool;
  let lifecycle: EmbeddedPostgresLifecycle;

  beforeAll(async () => {
    const port = await reservePort();
    directory = await mkdtemp(
      path.join(os.tmpdir(), "digitalmate-channel-events-"),
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
    pool = new Pool({
      connectionString:
        `postgresql://postgres:digitalmate-test@127.0.0.1:${port}/postgres`,
      max: 12,
      options: "-c statement_timeout=15000 -c lock_timeout=5000",
    });
    lifecycle = trackEmbeddedPostgresPool(pool);
    await installVectorCompatibility(pool);
    const schema = adaptSchemaForEmbeddedPostgres(
      await readFile(
        path.join(process.cwd(), "src/server/db/schema.sql"),
        "utf8",
      ),
    );
    await pool.query(schema);
  }, 60_000);

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE channel_delivery_attempts, channel_deliveries,
        channel_execution_steps, channel_event_attachments,
        channel_reply_handles, channel_access_requests,
        channel_access_rules, channel_node_outbox,
        channel_node_bindings, channel_inbound_events,
        channel_runtime_nodes, channel_connections,
        messages, conversations, digital_agents, users CASCADE
    `);
    await pool.query(
      `INSERT INTO users (id, display_name)
       VALUES ($1, 'Channel User')`,
      [USER_ID],
    );
    await pool.query(
      `INSERT INTO digital_agents (
         id, user_id, slug, display_name, is_default
       )
       VALUES ($1, $2, 'digitalmate', 'DigitalMate', true)`,
      [AGENT_ID, USER_ID],
    );
    await pool.query(
      `INSERT INTO channel_connections (
         id, user_id, agent_id, channel_type, display_name
       )
       VALUES
         ($1, $3, $4, 'telegram', 'Telegram A'),
         ($2, $3, $4, 'telegram', 'Telegram B')`,
      [CONNECTION_A, CONNECTION_B, USER_ID, AGENT_ID],
    );
  });

  afterAll(async () => {
    await lifecycle?.stop(database);
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts the same external event concurrently only once", async () => {
    const events = createChannelEventRepository(pool);
    const input = normalizedEvent(CONNECTION_A, "event-1");
    const results = await Promise.all(
      Array.from({ length: 8 }, () => events.accept(scope, input)),
    );

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.event.id))).toHaveLength(1);
    expect(results[0]?.event.clientTurnId).toBe(
      channelClientTurnId(CONNECTION_A, "event-1"),
    );
  });

  it("deduplicates a retry even when its local receipt time changed", async () => {
    const events = createChannelEventRepository(pool);
    const original = normalizedEvent(
      CONNECTION_A,
      "event-received-at-retry",
    );
    const first = await events.accept(scope, original);
    const retry = await events.accept(scope, {
      ...original,
      receivedAt: new Date(
        original.receivedAt.getTime() + 5_000,
      ),
    });

    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.event.id).toBe(first.event.id);
  });

  it("deduplicates XiaoYi dual-link ingress and keeps the first reply route", async () => {
    const keyState = createChannelSecretsKey(
      Buffer.alloc(32, 47).toString("base64"),
    );
    if (keyState.status !== "ready") {
      throw new Error("test_channel_key_invalid");
    }
    const events = createChannelEventRepository(pool);
    const handles = createChannelReplyHandleRepository(
      pool,
      keyState.key,
    );
    const adapter = createXiaoYiAdapter({
      autoListen: false,
    });
    adapter.validateConfig({
      enabled: true,
      ak: "xiaoyi-ak",
      sk: "xiaoyi-sk",
      agent_id: "xiaoyi-agent",
      task_timeout_ms: 3_600_000,
    });
    const frame = {
      agentId: "xiaoyi-agent",
      id: "message-dual-1",
      method: "message/stream",
      params: {
        sessionId: "session-dual",
        id: "task-dual-1",
        message: {
          role: "user",
          parts: [{ kind: "text", text: "双路去重" }],
        },
      },
    };
    const access = {
      evaluate: async () => ({
        kind: "allowed" as const,
        allowed: true as const,
      }),
      recordPendingRequest: async () => undefined,
    };
    const ingest = (
      serverName: "primary" | "backup",
      receivedAt: Date,
    ) => acceptInbound({
      adapter: adapter as ChannelAdapter<
        Record<string, unknown>
      >,
      payload: { serverName, payload: frame },
      context: {
        connectionId: CONNECTION_A,
        agentId: AGENT_ID,
        receivedAt,
      },
      scope,
      access,
      events,
      afterPersist: async (event, normalized) => {
        await handles.persist(
          scope,
          event.id,
          CONNECTION_A,
          normalized.replyHandle!,
          receivedAt,
          {
            firstWriteWinsPublicFields: ["serverName"],
            firstWriteWinsExpiresAt: true,
          },
        );
      },
    });
    const firstReceivedAt =
      new Date("2026-07-26T00:00:00.000Z");

    const first = await ingest("primary", firstReceivedAt);
    const duplicate = await ingest(
      "backup",
      new Date(firstReceivedAt.getTime() + 1),
    );

    expect(first).toMatchObject({ kind: "accepted" });
    if (first.kind !== "accepted") {
      throw new Error("xiaoyi_first_ingress_not_accepted");
    }
    expect(duplicate).toMatchObject({
      kind: "duplicate",
      eventId: first.eventId,
    });
    const handleId = await handles.findIdForEvent(
      scope,
      first.eventId,
    );
    expect(handleId).not.toBeNull();
    await expect(
      handles.load(scope, handleId!, firstReceivedAt),
    ).resolves.toMatchObject({
      publicFields: {
        sessionId: "session-dual",
        serverName: "primary",
      },
      secretFields: {
        taskId: "task-dual-1",
        messageId: "message-dual-1",
      },
      expiresAt: new Date(
        firstReceivedAt.getTime() + 3_600_000,
      ),
    });
  });

  it("does not fetch a bound XiaoYi attachment again on the backup link", async () => {
    const keyState = createChannelSecretsKey(
      Buffer.alloc(32, 53).toString("base64"),
    );
    if (keyState.status !== "ready") {
      throw new Error("test_channel_key_invalid");
    }
    const events = createChannelEventRepository(pool);
    const handles = createChannelReplyHandleRepository(
      pool,
      keyState.key,
    );
    const locators = createChannelAttachmentLocatorRepository(
      pool,
      keyState.key,
    );
    const adapter = createXiaoYiAdapter({
      autoListen: false,
    });
    adapter.validateConfig({
      enabled: true,
      ak: "xiaoyi-ak",
      sk: "xiaoyi-sk",
      agent_id: "xiaoyi-agent",
      task_timeout_ms: 3_600_000,
    });
    const fetchImpl = vi.fn(async () => new Response(
      "hello",
      {
        status: 200,
        headers: {
          "content-length": "5",
          "content-type": "text/plain",
        },
      },
    ));
    const fetcher = createXiaoYiAttachmentFetcher(
      fetchImpl as typeof fetch,
    );
    const frame = {
      agentId: "xiaoyi-agent",
      id: "message-dual-attachment",
      method: "message/stream",
      params: {
        sessionId: "session-dual-attachment",
        id: "task-dual-attachment",
        message: {
          role: "user",
          parts: [{
            kind: "file",
            file: {
              name: "note.txt",
              mimeType: "text/plain",
              sizeBytes: 5,
              uri:
                "https://digitalmate-fixture.obs.cn-north-4.myhuaweicloud.com/note.txt",
            },
          }],
        },
      },
    };
    const access = {
      evaluate: async () => ({
        kind: "allowed" as const,
        allowed: true as const,
      }),
      recordPendingRequest: async () => undefined,
    };
    const ingest = (
      serverName: "primary" | "backup",
      receivedAt: Date,
    ) => acceptInbound({
      adapter: adapter as ChannelAdapter<
        Record<string, unknown>
      >,
      payload: { serverName, payload: frame },
      context: {
        connectionId: CONNECTION_A,
        agentId: AGENT_ID,
        receivedAt,
      },
      scope,
      access,
      events,
      afterPersist: async (event, normalized) => {
        await handles.persist(
          scope,
          event.id,
          CONNECTION_A,
          normalized.replyHandle!,
          receivedAt,
          {
            firstWriteWinsPublicFields: ["serverName"],
            firstWriteWinsExpiresAt: true,
          },
        );
        const pending = await prepareXiaoYiAttachmentBatch({
          scope,
          eventId: event.id,
          connectionId: CONNECTION_A,
          descriptors: normalized.attachments,
          expiresAt: new Date(
            receivedAt.getTime() + 15 * 60 * 1_000,
          ),
          receivedAt,
          locators,
          fetcher,
        });
        for (const descriptor of pending) {
          await pool.query(
            `INSERT INTO message_attachments (
               id, user_id, agent_id, kind, file_name,
               mime_type, size_bytes, storage_key, status
             )
             VALUES (
               $1, $2, $3, 'document', 'note.txt',
               'text/plain', 5,
               '70000000-0000-4000-8000-000000000001',
               'ready'
             )`,
            [
              "70000000-0000-4000-8000-000000000001",
              USER_ID,
              AGENT_ID,
            ],
          );
          await expect(locators.bindPrivateAttachment(
            scope,
            event.id,
            descriptor.externalAttachmentId,
            "70000000-0000-4000-8000-000000000001",
            receivedAt,
          )).resolves.toBe(true);
          fetcher.release(descriptor);
        }
      },
    });
    const firstReceivedAt =
      new Date("2026-07-26T00:00:00.000Z");

    await expect(
      ingest("primary", firstReceivedAt),
    ).resolves.toMatchObject({ kind: "accepted" });
    await expect(ingest(
      "backup",
      new Date(firstReceivedAt.getTime() + 1),
    )).resolves.toMatchObject({ kind: "duplicate" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("permits the same external event id on different connections", async () => {
    const events = createChannelEventRepository(pool);
    const first = await events.accept(
      scope,
      normalizedEvent(CONNECTION_A, "shared-event"),
    );
    const second = await events.accept(
      scope,
      normalizedEvent(CONNECTION_B, "shared-event"),
    );

    expect(first.event.id).not.toBe(second.event.id);
    expect(first.event.clientTurnId).not.toBe(second.event.clientTurnId);
  });

  it("rejects a replay whose stable id carries a different payload", async () => {
    const events = createChannelEventRepository(pool);
    await events.accept(
      scope,
      normalizedEvent(CONNECTION_A, "event-conflict"),
    );

    await expect(
      events.accept(scope, {
        ...normalizedEvent(CONNECTION_A, "event-conflict"),
        text: "tampered payload",
      }),
    ).rejects.toThrow("channel_event_payload_conflict");
  });

  it("never persists attachment locators or unsealed reply secrets", async () => {
    const events = createChannelEventRepository(pool);
    const secretLocator = "temporary-download-token";
    const secretReply = "temporary-reply-token";
    await events.accept(scope, {
      ...normalizedEvent(CONNECTION_A, "event-secret"),
      attachments: [{
        externalAttachmentId: "attachment-1",
        fileName: "note.txt",
        mimeType: "text/plain",
        sizeBytes: 12,
        source: { token: secretLocator },
      }],
      replyHandle: {
        publicFields: { conversationId: "conversation-1" },
        secretFields: { token: secretReply },
        expiresAt: new Date("2026-07-26T01:00:00.000Z"),
      },
      permission: {
        webSearch: false,
        backgroundNetwork: false,
        tools: false,
        skills: "none",
        attachmentsPresent: true,
      },
    });

    const stored = await pool.query<{
      normalized_payload: unknown;
      payload_hash: string;
    }>(
      `SELECT normalized_payload, payload_hash
       FROM channel_inbound_events
       WHERE connection_id = $1
         AND external_event_id = 'event-secret'`,
      [CONNECTION_A],
    );
    const serialized = JSON.stringify(stored.rows[0]);

    expect(serialized).not.toContain(secretLocator);
    expect(serialized).not.toContain(secretReply);
    expect(serialized).not.toContain("replyHandle");
    expect(serialized).not.toContain("\"source\"");
  });

  it("encrypts a short-lived locator and erases it after binding", async () => {
    const keyState = createChannelSecretsKey(
      Buffer.alloc(32, 37).toString("base64"),
    );
    if (keyState.status !== "ready") {
      throw new Error("test_channel_key_invalid");
    }
    const events = createChannelEventRepository(pool);
    const secret = "temporary-platform-token";
    const now = new Date("2026-07-26T00:00:00.000Z");
    const descriptor = {
      externalAttachmentId: "attachment-locator-1",
      fileName: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      source: { token: secret, opaqueId: "file-1" },
    } as const;
    const accepted = await events.accept(
      scope,
      {
        ...normalizedEvent(CONNECTION_A, "event-locator"),
        attachments: [descriptor],
        permission: {
          webSearch: false,
          backgroundNetwork: false,
          tools: false,
          skills: "none",
          attachmentsPresent: true,
        },
      },
      {
        initialStatus: "pending_attachments",
        failureCode: null,
      },
    );
    const locators = createChannelAttachmentLocatorRepository(
      pool,
      keyState.key,
    );

    await expect(locators.persist(
      scope,
      accepted.event.id,
      CONNECTION_A,
      descriptor,
      new Date(now.getTime() + 60_000),
      now,
    )).resolves.toBe(true);
    const stored = await pool.query<{
      encrypted: string;
    }>(
      `SELECT concat(
         encode(source_locator_ciphertext, 'hex'),
         encode(source_locator_nonce, 'hex'),
         encode(source_locator_auth_tag, 'hex')
       ) AS encrypted
       FROM channel_event_attachments
       WHERE event_id = $1`,
      [accepted.event.id],
    );
    expect(stored.rows[0]?.encrypted).not.toContain(secret);
    await expect(locators.loadSource(
      scope,
      accepted.event.id,
      descriptor.externalAttachmentId,
      now,
    )).resolves.toEqual(descriptor.source);

    await pool.query(
      `INSERT INTO message_attachments (
         id, user_id, agent_id, kind, file_name, mime_type,
         size_bytes, storage_key, status
       )
       VALUES (
         $1, $2, $3, 'document', 'notes.txt', 'text/plain',
         5, '60000000-0000-4000-8000-000000000001', 'ready'
       )`,
      [PRIVATE_ATTACHMENT_ID, USER_ID, AGENT_ID],
    );
    await expect(locators.bindPrivateAttachment(
      scope,
      accepted.event.id,
      descriptor.externalAttachmentId,
      PRIVATE_ATTACHMENT_ID,
      new Date(now.getTime() + 1_000),
    )).resolves.toBe(true);
    await expect(locators.loadSource(
      scope,
      accepted.event.id,
      descriptor.externalAttachmentId,
      new Date(now.getTime() + 2_000),
    )).resolves.toBeNull();
    const cleared = await pool.query<{
      private_attachment_id: string;
      source_locator_ciphertext: Buffer | null;
      source_locator_nonce: Buffer | null;
      source_locator_auth_tag: Buffer | null;
      source_locator_key_version: number | null;
    }>(
      `SELECT private_attachment_id, source_locator_ciphertext,
              source_locator_nonce, source_locator_auth_tag,
              source_locator_key_version
       FROM channel_event_attachments
       WHERE event_id = $1`,
      [accepted.event.id],
    );
    expect(cleared.rows[0]).toEqual({
      private_attachment_id: PRIVATE_ATTACHMENT_ID,
      source_locator_ciphertext: null,
      source_locator_nonce: null,
      source_locator_auth_tag: null,
      source_locator_key_version: null,
    });
    await expect(
      events.claimNext("attachment-worker-early", now),
    ).resolves.toBeNull();
    await expect(
      events.markAttachmentsReady(
        scope,
        accepted.event.id,
        new Date(now.getTime() + 3_000),
      ),
    ).resolves.toBe(true);
    await expect(
      events.claimNext(
        "attachment-worker-ready",
        new Date(now.getTime() + 4_000),
      ),
    ).resolves.toMatchObject({
      id: accepted.event.id,
      status: "running",
    });
  });

  it("allows only one of eight workers to claim an event", async () => {
    const events = createChannelEventRepository(pool, { leaseMs: 1_000 });
    await events.accept(scope, normalizedEvent(CONNECTION_A, "event-claim"));

    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        events.claimNext(`worker-${index}`),
      ),
    );

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)).toMatchObject({
      attempts: 1,
      status: "running",
    });
  });

  it("keeps pending approval terminal and creates one inbox request", async () => {
    await pool.query(
      `UPDATE channel_connections
       SET enabled = true,
           config = '{"access_control_dm":true}'::jsonb
       WHERE id = $1`,
      [CONNECTION_A],
    );
    const access = createChannelAccessControl(pool);
    const events = createChannelEventRepository(pool);
    const input = normalizedEvent(CONNECTION_A, "event-pending");
    const decision = await access.evaluate(scope, input);
    expect(decision).toEqual({
      kind: "pending",
      allowed: false,
      reason: "approval_required",
    });

    const accepted = await events.accept(scope, input, {
      initialStatus: "failed",
      failureCode: "approval_required",
    });
    await Promise.all([
      access.recordPendingRequest(scope, accepted.event),
      access.recordPendingRequest(scope, accepted.event),
    ]);

    await expect(events.claimNext("worker-pending")).resolves.toBeNull();
    const requests = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM channel_access_requests
       WHERE event_id = $1`,
      [accepted.event.id],
    );
    expect(requests.rows[0]?.count).toBe("1");
  });

  it("prevents an expired owner from completing a reclaimed event", async () => {
    const start = new Date("2026-07-26T00:00:00.000Z");
    const events = createChannelEventRepository(pool, { leaseMs: 100 });
    await events.accept(scope, normalizedEvent(CONNECTION_A, "event-lease"));
    const first = await events.claimNext("worker-old", start);
    const second = await events.claimNext(
      "worker-new",
      new Date(start.getTime() + 101),
    );

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    await expect(
      events.complete(first!, null, new Date(start.getTime() + 102)),
    ).resolves.toBe(false);
    await expect(
      events.complete(second!, null, new Date(start.getTime() + 102)),
    ).resolves.toBe(true);
  });

  it("creates one delivery for one persisted assistant message", async () => {
    const events = createChannelEventRepository(pool);
    const deliveries = createChannelDeliveryRepository(pool);
    const accepted = await events.accept(
      scope,
      normalizedEvent(CONNECTION_A, "event-delivery"),
    );
    await seedAssistantMessage();

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        deliveries.enqueue({
          scope,
          eventId: accepted.event.id,
          connectionId: CONNECTION_A,
          assistantMessageId: ASSISTANT_MESSAGE_ID,
          body: "persisted reply",
          recipient: {
            externalConversationId: "conversation-1",
          },
        }),
      ),
    );

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.delivery.id))).toHaveLength(1);
  });

  it("can reapply the additive schema without duplicating constraints", async () => {
    const schema = adaptSchemaForEmbeddedPostgres(
      await readFile(
        path.join(process.cwd(), "src/server/db/schema.sql"),
        "utf8",
      ),
    );

    await expect(pool.query(schema)).resolves.toBeDefined();
  });

  async function seedAssistantMessage(): Promise<void> {
    await pool.query(
      `INSERT INTO conversations (
         id, user_id, agent_id, channel, title
       )
       VALUES ($1, $2, $3, 'telegram', 'Channel conversation')`,
      [CONVERSATION_ID, USER_ID, AGENT_ID],
    );
    await pool.query(
      `INSERT INTO messages (
         id, user_id, agent_id, conversation_id, role, content
       )
       VALUES ($1, $2, $3, $4, 'assistant', 'persisted reply')`,
      [
        ASSISTANT_MESSAGE_ID,
        USER_ID,
        AGENT_ID,
        CONVERSATION_ID,
      ],
    );
  }
});

function normalizedEvent(
  connectionId: string,
  externalEventId: string,
): NormalizedChannelEvent {
  return {
    connectionId,
    agentId: AGENT_ID,
    channelType: "telegram",
    externalEventId,
    externalConversationId: "conversation-1",
    externalSenderId: "sender-1",
    chatType: "direct",
    mentioned: false,
    text: "hello",
    thread: {},
    attachments: [],
    occurredAt: new Date("2026-07-26T00:00:00.000Z"),
    receivedAt: new Date("2026-07-26T00:00:01.000Z"),
    permission: {
      webSearch: false,
      backgroundNetwork: false,
      tools: false,
      skills: "none",
      attachmentsPresent: false,
    },
    rawSummary: {
      eventType: "message",
      messageId: externalEventId,
    },
  };
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

async function installVectorCompatibility(databasePool: Pool): Promise<void> {
  await databasePool.query(`
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
