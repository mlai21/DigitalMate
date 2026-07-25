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
  createChannelDeliveryRepository,
} from "@/server/channels/runtime/delivery-repository";
import {
  ChannelSendError,
  createChannelDeliveryWorker,
} from "@/server/channels/runtime/delivery-worker";
import {
  createChannelEventRepository,
} from "@/server/channels/runtime/event-repository";
import {
  ChannelProcessCrashError,
  createChannelEventWorker,
} from "@/server/channels/runtime/event-worker";
import {
  createExecutionJournal,
} from "@/server/channels/runtime/execution-journal";
import {
  createAtomicChannelReplyPersister,
  createChannelTurnExecutor,
  type ChannelAgentTurnContext,
  type ChannelTurnFaultPoint,
} from "@/server/channels/runtime/turn-executor";
import type {
  NormalizedChannelEvent,
} from "@/server/channels/runtime/types";
import { createRepositories } from "@/server/db/repositories";
import {
  trackEmbeddedPostgresPool,
  type EmbeddedPostgresLifecycle,
} from "../embedded-postgres-lifecycle";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_ID = "10000000-0000-4000-8000-000000000011";
const CONNECTION_ID = "20000000-0000-4000-8000-000000000001";
const CONVERSATION_ID = "30000000-0000-4000-8000-000000000001";
const scope = { userId: USER_ID, agentId: AGENT_ID } satisfies AgentScope;

describe("channel runtime end-to-end recovery", () => {
  let database: EmbeddedPostgres;
  let directory: string;
  let pool: Pool;
  let lifecycle: EmbeddedPostgresLifecycle;

  beforeAll(async () => {
    const port = await reservePort();
    directory = await mkdtemp(
      path.join(os.tmpdir(), "digitalmate-channel-e2e-"),
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
      max: 16,
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
       VALUES ($1, $2, $3, 'telegram', 'Telegram')`,
      [CONNECTION_ID, USER_ID, AGENT_ID],
    );
    await pool.query(
      `INSERT INTO conversations (
         id, user_id, agent_id, channel, title
       )
       VALUES ($1, $2, $3, 'telegram', 'Telegram conversation')`,
      [CONVERSATION_ID, USER_ID, AGENT_ID],
    );
  });

  afterAll(async () => {
    await lifecycle?.stop(database);
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("lets only one of eight workers run the Agent", async () => {
    const llm = vi.fn(async () => "唯一回复");
    const events = createChannelEventRepository(pool);
    await events.accept(scope, normalizedEvent("event-concurrent"));

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        worker({
          owner: `worker-${index}`,
          events,
          runAgentTurn: llm,
        }).runOne()
      ),
    );

    expect(llm).toHaveBeenCalledTimes(1);
    await expect(countRows(
      "messages",
      "client_turn_id IS NOT NULL AND role = 'user'",
    )).resolves.toBe(1);
    await expect(countRows(
      "messages",
      "client_turn_id IS NOT NULL AND role = 'assistant'",
    )).resolves.toBe(1);
    await expect(countRows("channel_deliveries", "true")).resolves.toBe(1);
  });

  it("does not call the LLM again after a crash at llm_started", async () => {
    const events = createChannelEventRepository(pool, { leaseMs: 1_000 });
    const accepted = await events.accept(
      scope,
      normalizedEvent("event-llm-crash"),
    );
    const llm = vi.fn(async ({ journal }) => {
      const action = await journal.begin({
        key: "llm:0",
        kind: "llm",
        requestHash: "b".repeat(64),
      });
      expect(action).toBe("run");
      throw new ChannelProcessCrashError("llm_started");
    });

    await expect(worker({
      owner: "worker-crash",
      events,
      runAgentTurn: llm,
    }).runOne()).rejects.toThrow("fault_injected:llm_started");
    await expireLease(accepted.event.id);

    await worker({
      owner: "worker-recovery",
      events,
      runAgentTurn: llm,
    }).runOne();

    expect(llm).toHaveBeenCalledTimes(1);
    const assistants = await pool.query<{ content: string }>(
      `SELECT content
       FROM messages
       WHERE client_turn_id = $1
         AND role = 'assistant'`,
      [accepted.event.clientTurnId],
    );
    expect(assistants.rows).toHaveLength(1);
    expect(assistants.rows[0]?.content).toContain("没能完整回复");
    await expect(countRows("channel_deliveries", "true")).resolves.toBe(1);
  });

  it("reuses completed journal output and marks an unfinished step ambiguous", async () => {
    const events = createChannelEventRepository(pool);
    const completedEvent = await events.accept(
      scope,
      normalizedEvent("event-journal-completed"),
    );
    const completedJournal = createExecutionJournal(
      pool,
      scope,
      completedEvent.event.id,
    );
    const completedStep = {
      key: "llm:0",
      kind: "llm" as const,
      requestHash: "c".repeat(64),
    };

    await expect(completedJournal.begin(completedStep)).resolves.toBe("run");
    await completedJournal.complete(completedStep.key, {
      text: "持久结果",
      toolCalls: [],
    });
    await expect(completedJournal.begin(completedStep)).resolves.toBe("reuse");
    await expect(completedJournal.read(completedStep.key)).resolves.toEqual({
      text: "持久结果",
      toolCalls: [],
    });

    const ambiguousEvent = await events.accept(
      scope,
      normalizedEvent("event-journal-ambiguous"),
    );
    const ambiguousJournal = createExecutionJournal(
      pool,
      scope,
      ambiguousEvent.event.id,
    );
    const ambiguousStep = {
      key: "search:0:stable",
      kind: "search" as const,
      requestHash: "d".repeat(64),
    };
    await expect(ambiguousJournal.begin(ambiguousStep)).resolves.toBe("run");
    await expect(ambiguousJournal.begin(ambiguousStep)).resolves.toBe(
      "ambiguous",
    );
    await expect(ambiguousJournal.read(ambiguousStep.key)).resolves.toBeNull();
    await expect(ambiguousJournal.begin({
      ...ambiguousStep,
      requestHash: "e".repeat(64),
    })).rejects.toThrow("channel_execution_step_conflict");
  });

  it.each([
    "after_accept",
    "after_claim",
    "after_assistant_insert",
    "after_delivery_insert",
  ] satisfies ChannelTurnFaultPoint[])(
    "recovers %s with one user, one assistant, and one delivery",
    async (faultPoint) => {
      const events = createChannelEventRepository(pool, { leaseMs: 1_000 });
      const accepted = await events.accept(
        scope,
        normalizedEvent(`event-${faultPoint}`),
      );
      const llm = vi.fn(async () => "原始回复");

      if (faultPoint === "after_accept") {
        // A process can disappear after persistence and before any worker
        // claim. The next worker simply starts the persisted event.
      } else {
        await expect(worker({
          owner: "worker-crash",
          events,
          runAgentTurn: llm,
          crashAt: faultPoint,
        }).runOne()).rejects.toThrow(`fault_injected:${faultPoint}`);
        if (
          faultPoint === "after_assistant_insert"
          || faultPoint === "after_delivery_insert"
        ) {
          await expect(countRows(
            "messages",
            `client_turn_id = '${accepted.event.clientTurnId}'
             AND role = 'assistant'`,
          )).resolves.toBe(0);
          await expect(countRows(
            "channel_deliveries",
            `event_id = '${accepted.event.id}'`,
          )).resolves.toBe(0);
        }
        await expireLease(accepted.event.id);
      }

      await worker({
        owner: "worker-recovery",
        events,
        runAgentTurn: llm,
      }).runOne();

      await expect(countRows(
        "messages",
        `client_turn_id = '${accepted.event.clientTurnId}'
         AND role = 'user'`,
      )).resolves.toBe(1);
      await expect(countRows(
        "messages",
        `client_turn_id = '${accepted.event.clientTurnId}'
         AND role = 'assistant'`,
      )).resolves.toBe(1);
      await expect(countRows(
        "channel_deliveries",
        `event_id = '${accepted.event.id}'`,
      )).resolves.toBe(1);
      expect(llm.mock.calls.length).toBeLessThanOrEqual(1);
    },
  );

  it("retries only the persisted delivery and never reruns the Agent", async () => {
    const events = createChannelEventRepository(pool);
    await events.accept(
      scope,
      normalizedEvent("event-send-retry"),
    );
    const runAgentTurn = vi.fn(async () => "已经生成的回复");
    await worker({
      owner: "event-worker-send-retry",
      events,
      runAgentTurn,
    }).runOne();

    const deliveries = createChannelDeliveryRepository(pool);
    let clock = new Date(Date.now() + 1_000);
    const send = vi.fn()
      .mockRejectedValueOnce(new ChannelSendError({
        code: "rate_limited",
        retryable: true,
        retryAfterMs: 2_000,
      }))
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({
        externalMessageId: "platform-message-1",
        sentAt: clock,
        rawSummary: {
          status: "ok",
          access_token: "must-not-persist",
        },
      });
    const deliveryWorker = createChannelDeliveryWorker({
      owner: "delivery-worker-send-retry",
      deliveries,
      transport: {
        mode: async () => "segmented",
        send,
      },
      loadCadence: async () => ({
        responseDelayMs: 0,
        segmentDelayMs: 0,
        maxSegments: 5,
      }),
      now: () => clock,
      random: () => 0.5,
    });

    await deliveryWorker.runOne();
    clock = await nextDeliveryAttemptAt();
    await deliveryWorker.runOne();
    clock = await nextDeliveryAttemptAt();
    await deliveryWorker.runOne();

    expect(send).toHaveBeenCalledTimes(3);
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    const delivery = await pool.query<{
      status: string;
      attempts: number;
    }>(
      `SELECT status, attempts
       FROM channel_deliveries`,
    );
    expect(delivery.rows).toEqual([{
      status: "sent",
      attempts: 3,
    }]);
    await expect(countRows(
      "messages",
      "role = 'assistant'",
    )).resolves.toBe(1);
    await expect(countRows(
      "channel_delivery_attempts",
      "true",
    )).resolves.toBe(3);
    const platformResult = await pool.query<{
      platform_result: unknown;
    }>(
      `SELECT platform_result
       FROM channel_delivery_attempts
       WHERE status = 'sent'`,
    );
    expect(JSON.stringify(platformResult.rows[0]))
      .not.toContain("must-not-persist");
  });

  it("requeues the same dead letter without creating another assistant", async () => {
    const events = createChannelEventRepository(pool);
    await events.accept(
      scope,
      normalizedEvent("event-manual-requeue"),
    );
    const runAgentTurn = vi.fn(async () => "固定回复");
    await worker({
      owner: "event-worker-manual-requeue",
      events,
      runAgentTurn,
    }).runOne();

    const deliveries = createChannelDeliveryRepository(pool);
    let clock = new Date(Date.now() + 1_000);
    const send = vi.fn()
      .mockRejectedValueOnce(new ChannelSendError({
        code: "credential_invalid",
        retryable: false,
      }))
      .mockResolvedValueOnce({
        externalMessageId: "platform-after-requeue",
        sentAt: clock,
        rawSummary: {},
      });
    const deliveryWorker = createChannelDeliveryWorker({
      owner: "delivery-worker-manual-requeue",
      deliveries,
      transport: {
        mode: async () => "segmented",
        send,
      },
      loadCadence: async () => ({
        responseDelayMs: 0,
        segmentDelayMs: 0,
        maxSegments: 5,
      }),
      now: () => clock,
      random: () => 0.5,
    });

    await deliveryWorker.runOne();
    const deadLetter = await pool.query<{
      id: string;
      status: string;
    }>(
      `SELECT id, status
       FROM channel_deliveries`,
    );
    expect(deadLetter.rows[0]?.status).toBe("dead_letter");

    clock = new Date(clock.getTime() + 1_000);
    await pool.query(
      `UPDATE channel_deliveries
       SET attempts = 8
       WHERE id = $1`,
      [deadLetter.rows[0]!.id],
    );
    await expect(deliveries.requeue(
      scope,
      deadLetter.rows[0]!.id,
      clock,
    )).resolves.toBe(true);
    await deliveryWorker.runOne();

    const finalDelivery = await pool.query<{
      id: string;
      status: string;
    }>(
      `SELECT id, status
       FROM channel_deliveries`,
    );
    expect(finalDelivery.rows).toEqual([{
      id: deadLetter.rows[0]!.id,
      status: "sent",
    }]);
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    await expect(countRows(
      "messages",
      "role = 'assistant'",
    )).resolves.toBe(1);
  });

  it("marks an unfinished platform attempt ambiguous after lease recovery", async () => {
    const events = createChannelEventRepository(pool);
    await events.accept(
      scope,
      normalizedEvent("event-send-ambiguous"),
    );
    await worker({
      owner: "event-worker-send-ambiguous",
      events,
      runAgentTurn: vi.fn(async () => "固定回复"),
    }).runOne();

    const deliveries = createChannelDeliveryRepository(
      pool,
      { leaseMs: 1_000 },
    );
    const start = new Date(Date.now() + 1_000);
    const first = await deliveries.claimNext(
      "delivery-worker-crash",
      start,
    );
    expect(first).not.toBeNull();
    await expect(deliveries.beginSegment(
      first!,
      1,
      start,
    )).resolves.toEqual({
      action: "send",
      previousResult: null,
    });

    const recoveredAt = new Date(start.getTime() + 1_001);
    const recovered = await deliveries.claimNext(
      "delivery-worker-recovery",
      recoveredAt,
    );
    expect(recovered).not.toBeNull();
    await expect(deliveries.beginSegment(
      recovered!,
      1,
      recoveredAt,
    )).resolves.toEqual({
      action: "ambiguous",
      previousResult: null,
    });
    await expect(deliveries.deadLetter(
      recovered!,
      "delivery_outcome_unknown",
      recoveredAt,
    )).resolves.toBe(true);
    await expect(deliveries.requeue(
      scope,
      recovered!.id,
      new Date(recoveredAt.getTime() + 1),
    )).resolves.toBe(true);
    const manualClaim = await deliveries.claimNext(
      "delivery-worker-manual-override",
      new Date(recoveredAt.getTime() + 2),
    );
    await expect(deliveries.beginSegment(
      manualClaim!,
      1,
      new Date(recoveredAt.getTime() + 2),
    )).resolves.toEqual({
      action: "send",
      previousResult: null,
    });
  });

  function worker(input: {
    owner: string;
    events: ReturnType<typeof createChannelEventRepository>;
    runAgentTurn(
      context: ChannelAgentTurnContext,
    ): Promise<string>;
    crashAt?: ChannelTurnFaultPoint;
  }) {
    const repositories = createRepositories(pool);
    const persistReply = createAtomicChannelReplyPersister(pool, {
      faultInjector: input.crashAt
        ? async (point) => {
            if (point === input.crashAt) {
              throw new ChannelProcessCrashError(point);
            }
          }
        : undefined,
    });
    const executor = createChannelTurnExecutor({
      messages: repositories.messages,
      resolveConversationId: async () => CONVERSATION_ID,
      resolveAttachmentIds: async () => [],
      createJournal: (claim) =>
        createExecutionJournal(pool, claim.scope, claim.id),
      runAgentTurn: input.runAgentTurn,
      persistReply,
      faultInjector: input.crashAt === "after_claim"
        ? async (point) => {
            if (point === input.crashAt) {
              throw new ChannelProcessCrashError(point);
            }
          }
        : undefined,
    });
    return createChannelEventWorker({
      owner: input.owner,
      events: input.events,
      executor,
    });
  }

  async function expireLease(eventId: string): Promise<void> {
    await pool.query(
      `UPDATE channel_inbound_events
       SET claim_expires_at = now() - interval '1 second'
       WHERE id = $1`,
      [eventId],
    );
  }

  async function countRows(
    table: string,
    predicate: string,
  ): Promise<number> {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table} WHERE ${predicate}`,
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async function nextDeliveryAttemptAt(): Promise<Date> {
    const result = await pool.query<{
      next_attempt_at: Date;
    }>(
      `SELECT next_attempt_at
       FROM channel_deliveries`,
    );
    return new Date(result.rows[0]!.next_attempt_at);
  }
});

function normalizedEvent(externalEventId: string): NormalizedChannelEvent {
  return {
    connectionId: CONNECTION_ID,
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
