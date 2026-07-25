import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import type { Pool } from "pg";

import { withUserDataLease } from "@/server/admin/user-data-lease";
import { searchWeb } from "@/server/agent/tools/web-search";
import { assertAuthorizedModelRoutes } from "@/server/agents/service";
import { createDingTalkWebhookAdapter } from "@/server/channels/adapters/webhook/dingtalk";
import { createFeishuWebhookAdapter } from "@/server/channels/adapters/webhook/feishu";
import { createSlackWebhookAdapter } from "@/server/channels/adapters/webhook/slack";
import { createTelegramWebhookAdapter } from "@/server/channels/adapters/webhook/telegram";
import {
  getChannelManifest,
  type ChannelType,
} from "@/server/channels/manifests/catalog";
import type { AppEnv } from "@/server/config/env";
import { getPool } from "@/server/db/client";
import {
  createRepositories,
} from "@/server/db/repositories";
import type { NormalizedChannelMessage } from "@/server/channels/types";
import { getLlmClient } from "@/server/llm/router";
import { installSkillsFromGitHub } from "@/server/skills/install";

import type { ChannelAdapter } from "./adapter";
import { createChannelAgentTurnRunner } from "./agent-turn";
import {
  createChannelConnectionManager,
  createPostgresChannelConnectionRuntimeStore,
  type RuntimeChannelConnection,
} from "./connection-manager";
import type {
  ClaimedChannelDelivery,
} from "./delivery-repository";
import {
  ChannelSendError,
  createChannelDeliveryWorker,
  type ChannelDeliveryTransport,
} from "./delivery-worker";
import { createChannelEventWorker } from "./event-worker";
import { createExecutionJournal } from "./execution-journal";
import { importLegacyChannelEnvironment } from "./legacy-env-import";
import {
  createChannelReplyHandleRepository,
} from "./reply-handle";
import {
  createAtomicChannelNoReplyPersister,
  createAtomicChannelReplyPersister,
  createChannelTurnExecutor,
  type ChannelTurnExecutor,
} from "./turn-executor";
import type {
  ChannelDelivery,
  SendResult,
  UnsealedReplyHandle,
} from "./types";

type Repositories = ReturnType<typeof createRepositories>;
type SendAdapter = Pick<
  ChannelAdapter<Record<string, unknown>>,
  "send" | "streaming" | "validateConfig"
>;

const WORKER_IDLE_MS = 250;
const EVENT_WORK_TIMEOUT_MS = 120_000;

export async function startChannelRuntime(input: Readonly<{
  repositories: Repositories;
  env: AppEnv;
  pool?: Pool;
  owner?: string;
}>): Promise<Readonly<{
  stop(): Promise<void>;
}>> {
  const pool = input.pool ?? getPool();
  const secretKey = input.env.channelSecretsKey.status === "ready"
    ? input.env.channelSecretsKey.key
    : null;
  const owner = input.owner
    ?? `${hostname()}:${process.pid}:${randomUUID()}`;

  const defaultUser = await input.repositories.users.ensureDefault();
  const defaultAgent = await input.repositories.agents.ensureDefault(
    defaultUser.id,
  );
  const defaultScope = {
    userId: defaultUser.id,
    agentId: defaultAgent.id,
  };
  if (secretKey) {
    const imported = await importLegacyChannelEnvironment({
      scope: defaultScope,
      env: input.env,
      pool,
      secretKey,
    });
    if (imported.imported.length > 0) {
      console.log("channel_legacy_environment_imported", {
        connections: imported.imported,
      });
    }
  } else if (hasLegacyChannelEnvironment(input.env)) {
    console.error("channel_legacy_environment_import_blocked", {
      code: "channel_secret_storage_blocked",
    });
  }

  const store = createPostgresChannelConnectionRuntimeStore(
    pool,
    secretKey,
  );
  const connectionManager = createChannelConnectionManager({
    store,
    createAdapter: (connection) =>
      createManagedAdapter(connection.channelType),
    onError(error, context) {
      console.error("channel_connection_runtime_failed", {
        ...context,
        code: stableRuntimeErrorCode(error),
      });
    },
  });
  await connectionManager.startAll();

  const replyHandles = secretKey
    ? createChannelReplyHandleRepository(pool, secretKey)
    : null;
  const agentTurn = createChannelAgentTurnRunner({
    repositories: input.repositories,
    resolveMainModel: async (scope, routing) => {
      await assertAuthorizedModelRoutes(
        scope,
        ["main"],
        routing,
        input.repositories.agents,
      );
      return getLlmClient("main", input.env, routing);
    },
    search: (query, _ignored, signal) =>
      searchWeb(query, input.env, signal),
    skillInstaller: {
      install: async (scope, url, signal) => {
        const settings =
          await input.repositories.settings.get(scope);
        await assertAuthorizedModelRoutes(
          scope,
          ["light"],
          settings.modelRouting,
          input.repositories.agents,
        );
        const light = getLlmClient(
          "light",
          input.env,
          settings.modelRouting,
        );
        return installSkillsFromGitHub({
          url,
          userId: scope.userId,
          repositories: input.repositories,
          scanner: {
            llm: light.client,
            model: light.model,
          },
          token: input.env.githubToken,
          signal,
        });
      },
    },
  });
  const baseExecutor = createChannelTurnExecutor({
    messages: input.repositories.messages,
    resolveConversationId: async (claim) => (
      await input.repositories.channels.ensureConversation(
        claim.scope,
        {
          channel:
            claim.normalizedEvent
              .channelType as "telegram" | "slack" | "feishu" | "dingtalk",
          externalConversationId:
            claim.normalizedEvent.externalConversationId,
          externalMessageId:
            claim.normalizedEvent.externalEventId,
          senderId: claim.normalizedEvent.externalSenderId,
          chatType: claim.normalizedEvent.chatType,
          text: claim.normalizedEvent.text,
          occurredAt: claim.normalizedEvent.occurredAt,
          raw: claim.normalizedEvent.rawSummary,
        },
      )
    ).id,
    resolveAttachmentIds: async (claim) => {
      if (claim.normalizedEvent.attachments.length > 0) {
        throw new Error("channel_attachments_not_ready");
      }
      return [];
    },
    resolveReplyHandleId: (claim) =>
      replyHandles?.findIdForEvent(
        claim.scope,
        claim.id,
      ) ?? Promise.resolve(null),
    createJournal: (claim) =>
      createExecutionJournal(pool, claim.scope, claim.id),
    decideTurn: agentTurn.decideTurn,
    runAgentTurn: agentTurn.runAgentTurn,
    persistReply: createAtomicChannelReplyPersister(pool),
    completeWithoutReply:
      createAtomicChannelNoReplyPersister(pool),
  });
  const leasedExecutor = createLeasedChannelTurnExecutor(
    input.repositories,
    pool,
    baseExecutor,
  );
  const eventWorker = createChannelEventWorker({
    owner: `${owner}:event`,
    events: input.repositories.channelEvents,
    executor: leasedExecutor,
  });

  const deliveryTransport = createChannelDeliveryTransport({
    loadConnection: (connectionId) =>
      store.get(connectionId),
    createAdapter: (connection) =>
      createManagedAdapter(connection.channelType),
    loadReplyHandle: (scope, handleId) =>
      replyHandles?.load(scope, handleId)
      ?? Promise.resolve(null),
  });
  const deliveryWorker = createChannelDeliveryWorker({
    owner: `${owner}:delivery`,
    deliveries: input.repositories.channelDeliveries,
    transport: deliveryTransport,
    loadCadence: async (delivery) => (
      await input.repositories.settings.get(delivery.scope)
    ).cadence,
  });

  const eventLoop = startWorkerLoop(
    (signal) => eventWorker.runOne({ signal }),
    "channel_event_worker_failed",
  );
  const deliveryLoop = startWorkerLoop(
    (signal) => deliveryWorker.runOne({ signal }),
    "channel_delivery_worker_failed",
  );
  let stopPromise: Promise<void> | null = null;

  return {
    stop() {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        await eventLoop.stop();
        await deliveryLoop.stop();
        await connectionManager.shutdown();
      })();
      return stopPromise;
    },
  };
}

export async function enqueueProactiveChannelDelivery(input: Readonly<{
  pool?: Pool;
  repositories: Repositories;
  scope: ClaimedChannelDelivery["scope"];
  taskId: string;
  assistantMessageId: string;
  target: NormalizedChannelMessage;
  content: string;
}>): Promise<Readonly<{ queued: boolean }>> {
  if (
    !["telegram", "slack", "feishu", "dingtalk"]
      .includes(input.target.channel)
  ) {
    return { queued: false };
  }
  const pool = input.pool ?? getPool();
  const connection = await pool.query<{ id: string }>(
    `SELECT id
     FROM channel_connections
     WHERE user_id = $1
       AND agent_id = $2
       AND channel_type = $3
       AND enabled = true
       AND deleted_at IS NULL
     ORDER BY created_at, id
     LIMIT 1`,
    [
      input.scope.userId,
      input.scope.agentId,
      input.target.channel,
    ],
  );
  const connectionId = connection.rows[0]?.id;
  if (!connectionId) return { queued: false };

  let replyHandleId: string | undefined;
  if (input.target.channel === "dingtalk") {
    const handle = await pool.query<{ id: string }>(
      `SELECT handle.id
       FROM channel_reply_handles AS handle
       JOIN channel_inbound_events AS event
         ON event.id = handle.event_id
        AND event.user_id = handle.user_id
        AND event.agent_id = handle.agent_id
       WHERE handle.user_id = $1
         AND handle.agent_id = $2
         AND event.connection_id = $3
         AND event.external_conversation_id = $4
         AND (
           handle.expires_at IS NULL
           OR handle.expires_at > now()
         )
       ORDER BY event.received_at DESC
       LIMIT 1`,
      [
        input.scope.userId,
        input.scope.agentId,
        connectionId,
        input.target.externalConversationId,
      ],
    );
    replyHandleId = handle.rows[0]?.id;
    if (!replyHandleId) return { queued: false };
  }

  await input.repositories.channelDeliveries.enqueueProactive({
    scope: input.scope,
    sourceTaskId: input.taskId,
    connectionId,
    assistantMessageId: input.assistantMessageId,
    ...(replyHandleId ? { replyHandleId } : {}),
    body: input.content,
    recipient: {
      externalConversationId:
        input.target.externalConversationId,
      externalUserId: input.target.senderId,
    },
  });
  return { queued: true };
}

export function createChannelDeliveryTransport(input: Readonly<{
  loadConnection(
    connectionId: string,
  ): Promise<RuntimeChannelConnection | null>;
  createAdapter(
    connection: RuntimeChannelConnection,
  ): SendAdapter;
  loadReplyHandle(
    scope: ClaimedChannelDelivery["scope"],
    handleId: string,
  ): Promise<UnsealedReplyHandle | null>;
  now?: () => Date;
}>): ChannelDeliveryTransport {
  const now = input.now ?? (() => new Date());

  return {
    async mode(delivery) {
      const resolved = await resolveDeliveryTarget(
        input,
        delivery,
      );
      return resolved.adapter.streaming
        ? "streaming"
        : "segmented";
    },

    async send(part, signal): Promise<SendResult> {
      signal.throwIfAborted();
      try {
        const resolved = await resolveDeliveryTarget(
          input,
          part.delivery,
        );
        const replyHandle = part.delivery.replyHandleId
          ? await input.loadReplyHandle(
              part.delivery.scope,
              part.delivery.replyHandleId,
            )
          : null;
        if (
          part.delivery.replyHandleId
          && !replyHandle
        ) {
          throw new ChannelSendError({
            code: "runtime_prerequisite_missing",
            retryable: false,
          });
        }
        const channelDelivery: ChannelDelivery = {
          id: part.delivery.id,
          eventId: part.delivery.eventId,
          connectionId: part.delivery.connectionId,
          assistantMessageId:
            part.delivery.assistantMessageId,
          body: part.body,
          recipient: part.delivery.recipient,
          ...(replyHandle ? { replyHandle } : {}),
        };
        if (
          part.mode === "streaming"
          && resolved.adapter.streaming
        ) {
          return await resolved.adapter.streaming(
            channelDelivery,
            part.state,
          );
        }
        return await resolved.adapter.send(
          channelDelivery,
          {
            config: resolved.config,
            signal,
            now,
          },
        );
      } catch (error) {
        if (signal.aborted) throw error;
        throw normalizeAdapterSendError(error);
      }
    },
  };
}

async function resolveDeliveryTarget(
  input: Readonly<{
    loadConnection(
      connectionId: string,
    ): Promise<RuntimeChannelConnection | null>;
    createAdapter(
      connection: RuntimeChannelConnection,
    ): SendAdapter;
  }>,
  delivery: ClaimedChannelDelivery,
) {
  const connection = await input.loadConnection(
    delivery.connectionId,
  );
  if (
    !connection
    || !connection.enabled
    || connection.runtimeError
    || connection.scope.userId !== delivery.scope.userId
    || connection.scope.agentId !== delivery.scope.agentId
  ) {
    throw new ChannelSendError({
      code: "runtime_prerequisite_missing",
      retryable: false,
    });
  }
  const adapter = input.createAdapter(connection);
  let config: Record<string, unknown>;
  try {
    config = adapter.validateConfig(connection.config);
  } catch {
    throw new ChannelSendError({
      code: "credential_invalid",
      retryable: false,
    });
  }
  return { adapter, config };
}

function createManagedAdapter(
  type: ChannelType,
): ChannelAdapter<Record<string, unknown>> {
  switch (type) {
    case "telegram":
      return createTelegramWebhookAdapter();
    case "slack":
      return createSlackWebhookAdapter();
    case "feishu":
      return createFeishuWebhookAdapter();
    case "dingtalk":
      return createDingTalkWebhookAdapter();
    default:
      return unavailableAdapter(type);
  }
}

function unavailableAdapter(
  type: ChannelType,
): ChannelAdapter<Record<string, unknown>> {
  const manifest = getChannelManifest(type);
  return {
    manifest,
    validateConfig(config) {
      return manifest.configSchema.parse(config);
    },
    async start() {
      throw new Error("channel_adapter_runtime_unavailable");
    },
    async stop() {},
    async health() {
      return {
        status: "stopped",
        checkedAt: new Date(),
        reconnectAttempts: 0,
      };
    },
    async normalizeInbound() {
      return null;
    },
    async acknowledge() {
      return { status: 200 };
    },
    async send() {
      throw new ChannelSendError({
        code: "runtime_prerequisite_missing",
        retryable: false,
      });
    },
    async resolveRecipient(target) {
      return {
        address: {
          conversationId: target.externalConversationId,
        },
      };
    },
  };
}

export function createLeasedChannelTurnExecutor(
  repositories: Repositories,
  database: Pick<Pool, "query">,
  executor: ChannelTurnExecutor,
): ChannelTurnExecutor {
  return {
    execute(claim, options = {}) {
      return withUserDataLease(
        repositories,
        claim.scope.userId,
        async (_lease, signal) => {
          const current = await database.query(
            `SELECT 1
             FROM channel_inbound_events
             WHERE id = $1
               AND user_id = $2
               AND agent_id = $3
               AND connection_id = $4
               AND status = 'running'
               AND claim_owner = $5`,
            [
              claim.id,
              claim.scope.userId,
              claim.scope.agentId,
              claim.connectionId,
              claim.claimOwner,
            ],
          );
          if (current.rowCount !== 1) {
            return {
              skipped: true,
              reason: "event_no_longer_current",
              assistantMessageId: null,
              deliveryId: null,
              created: false,
              degraded: false,
            };
          }
          return executor.execute(claim, { signal });
        },
        {
          signal: options.signal,
          timeoutMs: EVENT_WORK_TIMEOUT_MS,
          timeoutCode: "channel_event_work_timeout",
        },
      );
    },
  };
}

function startWorkerLoop(
  runOne: (signal: AbortSignal) => Promise<boolean>,
  errorCode: string,
) {
  const controller = new AbortController();
  let stopping = false;
  const loop = (async () => {
    while (!stopping) {
      const operation = new AbortController();
      try {
        const processed = await runOne(operation.signal);
        if (!processed) {
          await idleWait(controller.signal);
        }
      } catch (error) {
        if (stopping || controller.signal.aborted) break;
        console.error(errorCode, {
          code: stableRuntimeErrorCode(error),
        });
        await idleWait(controller.signal).catch(() => undefined);
      }
    }
  })();
  return {
    async stop() {
      stopping = true;
      controller.abort(new Error("channel_worker_stopped"));
      await loop;
    },
  };
}

function idleWait(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, WORKER_IDLE_MS);
    timer.unref?.();
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    function cleanup() {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
    function finish() {
      cleanup();
      resolve();
    }
  });
}

function normalizeAdapterSendError(
  error: unknown,
): ChannelSendError {
  if (error instanceof ChannelSendError) return error;
  const code = stableRuntimeErrorCode(error);
  const httpStatus = /_http_(\d{3})$/.exec(code)?.[1];
  const status = httpStatus ? Number(httpStatus) : null;
  const nonRetryable = (
    /(?:credential|permission|reply_handle|runtime_prerequisite)/i
      .test(code)
    || (
      status !== null
      && status >= 400
      && status < 500
      && ![408, 409, 425, 429].includes(status)
    )
  );
  return new ChannelSendError({
    code: code === "channel_runtime_failed"
      ? "network_unreachable"
      : code,
    retryable: !nonRetryable,
  });
}

function stableRuntimeErrorCode(error: unknown): string {
  if (
    error instanceof Error
    && /^[a-z0-9_:-]{1,128}$/i.test(error.message)
  ) {
    return error.message.toLowerCase();
  }
  return "channel_runtime_failed";
}

function hasLegacyChannelEnvironment(env: AppEnv): boolean {
  return Boolean(
    env.telegramBotToken
    || env.telegramWebhookSecret
    || env.slackBotToken
    || env.slackSigningSecret
    || env.feishuAppId
    || env.feishuAppSecret
    || env.feishuVerificationToken
    || env.dingTalkRobotCode
  );
}
