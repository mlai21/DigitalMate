import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import type { Pool } from "pg";

import { withUserDataLease } from "@/server/admin/user-data-lease";
import { searchWeb } from "@/server/agent/tools/web-search";
import { assertAuthorizedModelRoutes } from "@/server/agents/service";
import {
  createDiscordAdapter,
} from "@/server/channels/adapters/discord";
import {
  parseDiscordConfig,
} from "@/server/channels/adapters/discord/config";
import {
  createDiscordAttachmentFetcher,
} from "@/server/channels/adapters/discord/transport";
import {
  createDingTalkAdapter,
} from "@/server/channels/adapters/dingtalk";
import {
  parseDingTalkConfig,
} from "@/server/channels/adapters/dingtalk/config";
import {
  createDingTalkAttachmentFetcher,
} from "@/server/channels/adapters/dingtalk/transport";
import {
  createFeishuAdapter,
} from "@/server/channels/adapters/feishu";
import {
  parseFeishuConfig,
} from "@/server/channels/adapters/feishu/config";
import {
  createFeishuAttachmentFetcher,
} from "@/server/channels/adapters/feishu/transport";
import {
  createMattermostAdapter,
} from "@/server/channels/adapters/mattermost";
import {
  parseMattermostConfig,
} from "@/server/channels/adapters/mattermost/config";
import {
  createMattermostAttachmentFetcher,
} from "@/server/channels/adapters/mattermost/transport";
import {
  createMatrixAdapter,
} from "@/server/channels/adapters/matrix";
import {
  createMatrixAttachmentFetcher,
} from "@/server/channels/adapters/matrix/transport";
import {
  createMqttAdapter,
} from "@/server/channels/adapters/mqtt";
import {
  createQQAdapter,
} from "@/server/channels/adapters/qq";
import {
  parseQQConfig,
} from "@/server/channels/adapters/qq/config";
import {
  createQQAttachmentFetcher,
} from "@/server/channels/adapters/qq/transport";
import {
  createSlackAdapter,
} from "@/server/channels/adapters/slack";
import {
  parseSlackConfig,
} from "@/server/channels/adapters/slack/config";
import {
  createSlackAttachmentFetcher,
} from "@/server/channels/adapters/slack/transport";
import {
  createTelegramAdapter,
  parseTelegramConfig,
} from "@/server/channels/adapters/telegram";
import {
  createWeComAdapter,
} from "@/server/channels/adapters/wecom";
import {
  createXiaoYiAdapter,
} from "@/server/channels/adapters/xiaoyi";
import {
  createXiaoYiAttachmentFetcher,
  prepareXiaoYiAttachmentBatch,
} from "@/server/channels/adapters/xiaoyi/transport";
import {
  createYuanbaoAdapter,
} from "@/server/channels/adapters/yuanbao";
import {
  prepareYuanbaoAttachmentBatch,
  type YuanbaoAttachmentFetcher,
} from "@/server/channels/adapters/yuanbao/media";
import {
  createTelegramTransport,
} from "@/server/channels/adapters/telegram/transport";
import { createSlackWebhookAdapter } from "@/server/channels/adapters/webhook/slack";
import { createChannelAccessControl } from "@/server/channels/runtime/access";
import {
  createChannelAttachmentLocatorRepository,
  downloadInboundAttachment,
} from "@/server/channels/runtime/attachment-ingress";
import { acceptInbound } from "@/server/channels/runtime/ingress";
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
import type {
  ChannelSecretsKey,
} from "@/server/security/encrypted-secret";

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
  const replyHandles = secretKey
    ? createChannelReplyHandleRepository(pool, secretKey)
    : null;
  const attachmentLocators = secretKey
    ? createChannelAttachmentLocatorRepository(pool, secretKey)
    : null;
  const managedAdapterDependencies = {
    pool,
    repositories: input.repositories,
    secretKey,
    replyHandles,
    attachmentLocators,
    attachmentStorageDir: input.env.attachmentStorageDir,
  };
  const connectionManager = createChannelConnectionManager({
    store,
    createAdapter: (connection) =>
      createManagedAdapter(
        connection,
        managedAdapterDependencies,
      ),
    onError(error, context) {
      console.error("channel_connection_runtime_failed", {
        ...context,
        code: stableRuntimeErrorCode(error),
      });
    },
  });
  await connectionManager.startAll();

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
              .channelType as NormalizedChannelMessage["channel"],
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
      const expected = claim.normalizedEvent.attachments;
      if (expected.length === 0) return [];
      const stored = await pool.query<{
        external_attachment_id: string;
        private_attachment_id: string | null;
      }>(
        `SELECT external_attachment_id, private_attachment_id
         FROM channel_event_attachments
         WHERE event_id = $1
           AND user_id = $2
           AND agent_id = $3`,
        [
          claim.id,
          claim.scope.userId,
          claim.scope.agentId,
        ],
      );
      const byExternalId = new Map(
        stored.rows.map((row) => [
          row.external_attachment_id,
          row.private_attachment_id,
        ]),
      );
      const attachmentIds = expected.map((descriptor) =>
        byExternalId.get(descriptor.externalAttachmentId)
      );
      if (attachmentIds.some((attachmentId) => !attachmentId)) {
        throw new Error("channel_attachments_not_ready");
      }
      return attachmentIds as string[];
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
    typing: async (claim, active) => {
      const connection = await store.get(
        claim.connectionId,
      );
      if (
        !connection
        || !connection.enabled
        || connection.scope.userId
          !== claim.scope.userId
        || connection.scope.agentId
          !== claim.scope.agentId
      ) {
        return;
      }
      const adapter = connectionManager.getAdapter(
        connection.id,
        connection.revision,
      );
      if (!adapter?.typing) return;
      const event = claim.normalizedEvent;
      const recipient = await adapter.resolveRecipient({
        externalConversationId:
          event.externalConversationId,
        externalUserId: event.externalSenderId,
        chatType: event.chatType,
        ...(event.thread.externalThreadId
          ? {
              externalThreadId:
                event.thread.externalThreadId,
            }
          : {}),
      });
      await adapter.typing(recipient, active);
    },
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
      connectionManager.getAdapter(
        connection.id,
        connection.revision,
      ) ?? createManagedAdapter(
        connection,
        managedAdapterDependencies,
      ),
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
    ![
      "telegram",
      "discord",
      "slack",
      "mattermost",
      "feishu",
      "dingtalk",
      "qq",
      "mqtt",
      "matrix",
      "wecom",
      "yuanbao",
    ]
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

  await input.repositories.channelDeliveries.enqueueProactive({
    scope: input.scope,
    sourceTaskId: input.taskId,
    connectionId,
    assistantMessageId: input.assistantMessageId,
    body: input.content,
    recipient: {
      externalConversationId:
        input.target.externalConversationId,
      externalUserId: input.target.senderId,
      chatType: input.target.chatType,
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
      if (
        resolved.channelType === "xiaoyi"
        && resolved.adapter.streaming
      ) {
        return "task-streaming";
      }
      return resolved.adapter.streaming
        && resolved.config.streaming_enabled === true
        && (
          (
            delivery.eventId === null
              ? resolved.config.cron_message_type
              : resolved.config.message_type
          ) === undefined
          || (
            delivery.eventId === null
              ? resolved.config.cron_message_type
              : resolved.config.message_type
          ) === "card"
        )
        ? "streaming"
        : "segmented";
    },

    async taskSegmentCodePointLimit(delivery) {
      try {
        const resolved = await resolveDeliveryTarget(
          input,
          delivery,
        );
        if (resolved.channelType !== "xiaoyi") return 4_000;
        const prefix =
          typeof resolved.config.bot_prefix === "string"
            ? resolved.config.bot_prefix
            : "";
        return Math.max(
          1,
          4_000 - Array.from(prefix).length,
        );
      } catch {
        // The normal send path records the stable delivery error.
        return 4_000;
      }
    },

    async segmentBodies(delivery, signal) {
      signal.throwIfAborted();
      const resolved = await resolveDeliveryTarget(
        input,
        delivery,
      );
      if (resolved.channelType !== "yuanbao") {
        return null;
      }
      const prefix =
        typeof resolved.config.bot_prefix === "string"
          ? resolved.config.bot_prefix
          : "";
      const firstLimit = Math.max(
        1,
        2_800 - Array.from(prefix).length,
      );
      return {
        segments: segmentCodePoints(
          delivery.body,
          firstLimit,
          2_800,
        ),
        prefix,
      };
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
          deliverySequence: part.state.sequence,
          body: part.body,
          recipient: part.delivery.recipient,
          ...(replyHandle ? { replyHandle } : {}),
        };
        if (
          (
            part.mode === "streaming"
            || part.mode === "task-streaming"
          )
          && resolved.adapter.streaming
        ) {
          return await resolved.adapter.streaming(
            channelDelivery,
            {
              ...part.state,
              previousResult: part.previousResult,
              signal,
            },
          );
        }
        return await resolved.adapter.send(
          channelDelivery,
          {
            config: resolved.channelType === "yuanbao"
              ? {
                  ...resolved.config,
                  bot_prefix: "",
                }
              : resolved.config,
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
  return {
    adapter,
    config,
    channelType: connection.channelType,
  };
}

function segmentCodePoints(
  value: string,
  firstLimit: number,
  followingLimit: number,
): string[] {
  const codePoints = Array.from(value);
  if (codePoints.length === 0) return [];
  const segments = [
    codePoints.slice(0, firstLimit).join(""),
  ];
  for (
    let index = firstLimit;
    index < codePoints.length;
    index += followingLimit
  ) {
    segments.push(
      codePoints
        .slice(index, index + followingLimit)
        .join(""),
    );
  }
  return segments;
}

type ManagedAdapterDependencies = Readonly<{
  pool: Pool;
  repositories: Repositories;
  secretKey: ChannelSecretsKey | null;
  replyHandles: ReturnType<
    typeof createChannelReplyHandleRepository
  > | null;
  attachmentLocators: ReturnType<
    typeof createChannelAttachmentLocatorRepository
  > | null;
  attachmentStorageDir: string;
}>;

function createManagedAdapter(
  connection: RuntimeChannelConnection,
  dependencies: ManagedAdapterDependencies,
): ChannelAdapter<Record<string, unknown>> {
  switch (connection.channelType) {
    case "discord":
      return createManagedDiscordAdapter(
        connection,
        dependencies,
      ) as ChannelAdapter<Record<string, unknown>>;
    case "mattermost":
      return createManagedMattermostAdapter(
        connection,
        dependencies,
      ) as ChannelAdapter<Record<string, unknown>>;
    case "mqtt":
      return createManagedMqttAdapter(
        connection,
        dependencies,
      ) as ChannelAdapter<Record<string, unknown>>;
    case "matrix":
      return createManagedMatrixAdapter(
        connection,
        dependencies,
      ) as ChannelAdapter<Record<string, unknown>>;
    case "wecom":
      return createManagedWeComAdapter(
        connection,
        dependencies,
      ) as ChannelAdapter<Record<string, unknown>>;
    case "xiaoyi":
      return createManagedXiaoYiAdapter(
        connection,
        dependencies,
      ) as ChannelAdapter<Record<string, unknown>>;
    case "yuanbao":
      return createManagedYuanbaoAdapter(
        connection,
        dependencies,
      ) as ChannelAdapter<Record<string, unknown>>;
    case "telegram":
      return createManagedTelegramAdapter(
        connection,
        dependencies,
      ) as ChannelAdapter<Record<string, unknown>>;
    case "slack":
      return hasConfiguredString(connection.config.app_token)
        ? createManagedSlackAdapter(
            connection,
            dependencies,
          ) as ChannelAdapter<Record<string, unknown>>
        : createSlackWebhookAdapter();
    case "feishu":
      return createManagedFeishuAdapter(
        connection,
        dependencies,
      ) as ChannelAdapter<Record<string, unknown>>;
    case "dingtalk":
      return createManagedDingTalkAdapter(
        connection,
        dependencies,
      ) as ChannelAdapter<Record<string, unknown>>;
    case "qq":
      return createManagedQQAdapter(
        connection,
        dependencies,
      ) as ChannelAdapter<Record<string, unknown>>;
    default:
      return unavailableAdapter(connection.channelType);
  }
}

function createManagedMatrixAdapter(
  connection: RuntimeChannelConnection,
  dependencies: ManagedAdapterDependencies,
) {
  const cryptoStorageKey =
    dependencies.secretKey?.runtimeStorageKey(
      "matrix-crypto-store",
      {
        userId: connection.scope.userId,
        agentId: connection.scope.agentId,
        connectionId: connection.id,
      },
    );
  const adapter = createMatrixAdapter({
    scope: connection.scope,
    ...(cryptoStorageKey ? { cryptoStorageKey } : {}),
    acceptInbound: (payload, context, scope) =>
      withUserDataLease(
        dependencies.repositories,
        scope.userId,
        async (_lease, signal) => {
          signal.throwIfAborted();
          return acceptInbound({
            adapter: adapter as ChannelAdapter<
              Record<string, unknown>
            >,
            payload,
            context,
            scope,
            access: createChannelAccessControl(
              dependencies.pool,
            ),
            events:
              dependencies.repositories.channelEvents,
            afterPersist: async (event, normalized) => {
              if (normalized.replyHandle) {
                if (!dependencies.replyHandles) {
                  throw new Error(
                    "channel_secret_storage_blocked",
                  );
                }
                await dependencies.replyHandles.persist(
                  event.scope,
                  event.id,
                  event.connectionId,
                  normalized.replyHandle,
                  context.receivedAt,
                );
              }
              if (normalized.attachments.length === 0) {
                return;
              }
              const locators = dependencies.attachmentLocators;
              if (!locators) {
                throw new Error(
                  "channel_secret_storage_blocked",
                );
              }
              const expiresAt = new Date(
                context.receivedAt.getTime()
                  + 60 * 60 * 1_000,
              );
              const fetcher = createMatrixAttachmentFetcher();
              for (const descriptor of normalized.attachments) {
                const persisted = await locators.persist(
                  event.scope,
                  event.id,
                  event.connectionId,
                  descriptor,
                  expiresAt,
                  context.receivedAt,
                );
                if (!persisted) continue;
                await downloadInboundAttachment({
                  scope: event.scope,
                  descriptor,
                  fetcher,
                  storageRoot:
                    dependencies.attachmentStorageDir,
                  repository:
                    dependencies.repositories.messageAttachments,
                  bindPrivateAttachment: async (
                    attachmentId,
                  ) => {
                    const bound =
                      await locators.bindPrivateAttachment(
                        event.scope,
                        event.id,
                        descriptor.externalAttachmentId,
                        attachmentId,
                        new Date(),
                      );
                    if (!bound) {
                      throw new Error(
                        "attachment_bind_transition_failed",
                      );
                    }
                  },
                  signal,
                });
              }
            },
          });
        },
        {
          timeoutMs: 30_000,
          timeoutCode: "channel_ingress_timeout",
        },
      ),
  });
  return adapter;
}

function createManagedWeComAdapter(
  connection: RuntimeChannelConnection,
  dependencies: ManagedAdapterDependencies,
) {
  const adapter = createWeComAdapter({
    scope: connection.scope,
    acceptWelcome: (event, scope) =>
      withUserDataLease(
        dependencies.repositories,
        scope.userId,
        async (_lease, signal) => {
          signal.throwIfAborted();
          const access = createChannelAccessControl(
            dependencies.pool,
          );
          const decision = await access.evaluate(
            scope,
            event,
          );
          const accepted =
            await dependencies.repositories.channelEvents.accept(
              scope,
              event,
              {
                initialStatus: "failed",
                failureCode: decision.allowed
                  ? "wecom_welcome_completed"
                  : decision.reason,
              },
            );
          if (
            accepted.created
            && decision.kind === "pending"
          ) {
            await access.recordPendingRequest(
              scope,
              accepted.event,
            );
          }
          return accepted.created && decision.allowed;
        },
        {
          timeoutMs: 30_000,
          timeoutCode: "channel_ingress_timeout",
        },
      ),
    acceptInbound: (
      payload,
      context,
      scope,
      attachmentFetcher,
    ) =>
      withUserDataLease(
        dependencies.repositories,
        scope.userId,
        async (_lease, signal) => {
          signal.throwIfAborted();
          return acceptInbound({
            adapter: adapter as ChannelAdapter<
              Record<string, unknown>
            >,
            payload,
            context,
            scope,
            access: createChannelAccessControl(
              dependencies.pool,
            ),
            events:
              dependencies.repositories.channelEvents,
            afterPersist: async (event, normalized) => {
              if (normalized.replyHandle) {
                if (!dependencies.replyHandles) {
                  throw new Error(
                    "channel_secret_storage_blocked",
                  );
                }
                await dependencies.replyHandles.persist(
                  event.scope,
                  event.id,
                  event.connectionId,
                  normalized.replyHandle,
                  context.receivedAt,
                );
              }
              if (normalized.attachments.length === 0) {
                return;
              }
              const locators = dependencies.attachmentLocators;
              if (!locators) {
                throw new Error(
                  "channel_secret_storage_blocked",
                );
              }
              const expiresAt = new Date(
                context.receivedAt.getTime()
                  + 4 * 60 * 1_000,
              );
              for (const descriptor of normalized.attachments) {
                const persisted = await locators.persist(
                  event.scope,
                  event.id,
                  event.connectionId,
                  descriptor,
                  expiresAt,
                  context.receivedAt,
                );
                if (!persisted) continue;
                await downloadInboundAttachment({
                  scope: event.scope,
                  descriptor,
                  fetcher: attachmentFetcher,
                  storageRoot:
                    dependencies.attachmentStorageDir,
                  repository:
                    dependencies.repositories.messageAttachments,
                  bindPrivateAttachment: async (
                    attachmentId,
                  ) => {
                    const bound =
                      await locators.bindPrivateAttachment(
                        event.scope,
                        event.id,
                        descriptor.externalAttachmentId,
                        attachmentId,
                        new Date(),
                      );
                    if (!bound) {
                      throw new Error(
                        "attachment_bind_transition_failed",
                      );
                    }
                  },
                  signal,
                });
              }
            },
          });
        },
        {
          timeoutMs: 30_000,
          timeoutCode: "channel_ingress_timeout",
        },
      ),
  });
  return adapter;
}

function createManagedXiaoYiAdapter(
  connection: RuntimeChannelConnection,
  dependencies: ManagedAdapterDependencies,
) {
  const attachmentFetcher =
    createXiaoYiAttachmentFetcher();
  const adapter = createXiaoYiAdapter({
    scope: connection.scope,
    attachmentFetcher,
    acceptControl: (event, scope) =>
      withUserDataLease(
        dependencies.repositories,
        scope.userId,
        async (_lease, signal) => {
          signal.throwIfAborted();
          const access = createChannelAccessControl(
            dependencies.pool,
          );
          const decision = await access.evaluate(
            scope,
            event,
          );
          const accepted =
            await dependencies.repositories.channelEvents.accept(
              scope,
              event,
              {
                initialStatus: "failed",
                failureCode: decision.allowed
                  ? "xiaoyi_control_completed"
                  : decision.reason,
              },
            );
          if (
            accepted.created
            && decision.kind === "pending"
          ) {
            await access.recordPendingRequest(
              scope,
              accepted.event,
            );
          }
          return accepted.created && decision.allowed;
        },
        {
          timeoutMs: 30_000,
          timeoutCode: "channel_ingress_timeout",
        },
      ),
    acceptInbound: (
      payload,
      context,
      scope,
    ) =>
      withUserDataLease(
        dependencies.repositories,
        scope.userId,
        async (_lease, signal) => {
          signal.throwIfAborted();
          return acceptInbound({
            adapter: adapter as ChannelAdapter<
              Record<string, unknown>
            >,
            payload,
            context,
            scope,
            access: createChannelAccessControl(
              dependencies.pool,
            ),
            events:
              dependencies.repositories.channelEvents,
            afterPersist: async (event, normalized) => {
              if (normalized.replyHandle) {
                if (!dependencies.replyHandles) {
                  throw new Error(
                    "channel_secret_storage_blocked",
                  );
                }
                await dependencies.replyHandles.persist(
                  event.scope,
                  event.id,
                  event.connectionId,
                  normalized.replyHandle,
                  context.receivedAt,
                  {
                    firstWriteWinsPublicFields: [
                      "serverName",
                    ],
                    firstWriteWinsExpiresAt: true,
                  },
                );
              }
              if (normalized.attachments.length === 0) {
                return;
              }
              const locators = dependencies.attachmentLocators;
              if (!locators) {
                throw new Error(
                  "channel_secret_storage_blocked",
                );
              }
              const expiresAt = new Date(
                context.receivedAt.getTime()
                  + 15 * 60 * 1_000,
              );
              const pendingAttachments =
                await prepareXiaoYiAttachmentBatch({
                  scope: event.scope,
                  eventId: event.id,
                  connectionId: event.connectionId,
                  descriptors: normalized.attachments,
                  expiresAt,
                  receivedAt: context.receivedAt,
                  locators,
                  fetcher: attachmentFetcher,
                  signal,
                });
              try {
                for (const descriptor of pendingAttachments) {
                  await downloadInboundAttachment({
                    scope: event.scope,
                    descriptor,
                    fetcher: attachmentFetcher,
                    storageRoot:
                      dependencies.attachmentStorageDir,
                    repository:
                      dependencies.repositories.messageAttachments,
                    bindPrivateAttachment: async (
                      attachmentId,
                    ) => {
                      const bound =
                        await locators.bindPrivateAttachment(
                          event.scope,
                          event.id,
                          descriptor.externalAttachmentId,
                          attachmentId,
                          new Date(),
                        );
                      if (!bound) {
                        throw new Error(
                          "attachment_bind_transition_failed",
                        );
                      }
                    },
                    signal,
                  });
                }
              } finally {
                for (const descriptor of pendingAttachments) {
                  attachmentFetcher.release(descriptor);
                }
              }
            },
          });
        },
        {
          timeoutMs: 30_000,
          timeoutCode: "channel_ingress_timeout",
        },
      ),
  });
  return adapter;
}

function createManagedYuanbaoAdapter(
  connection: RuntimeChannelConnection,
  dependencies: ManagedAdapterDependencies,
) {
  const adapter = createYuanbaoAdapter({
    scope: connection.scope,
    acceptInbound: (
      payload,
      context,
      scope,
      attachmentFetcher,
    ) =>
      withUserDataLease(
        dependencies.repositories,
        scope.userId,
        async (_lease, signal) => {
          signal.throwIfAborted();
          return acceptInbound({
            adapter: adapter as ChannelAdapter<
              Record<string, unknown>
            >,
            payload,
            context,
            scope,
            access: createChannelAccessControl(
              dependencies.pool,
            ),
            events:
              dependencies.repositories.channelEvents,
            afterPersist: async (event, normalized) => {
              if (normalized.replyHandle) {
                if (!dependencies.replyHandles) {
                  throw new Error(
                    "channel_secret_storage_blocked",
                  );
                }
                await dependencies.replyHandles.persist(
                  event.scope,
                  event.id,
                  event.connectionId,
                  normalized.replyHandle,
                  context.receivedAt,
                );
              }
              if (normalized.attachments.length === 0) {
                return;
              }
              const locators = dependencies.attachmentLocators;
              if (!locators) {
                throw new Error(
                  "channel_secret_storage_blocked",
                );
              }
              const expiresAt = new Date(
                context.receivedAt.getTime()
                  + 15 * 60 * 1_000,
              );
              const fetcher =
                attachmentFetcher as YuanbaoAttachmentFetcher;
              const pendingAttachments =
                await prepareYuanbaoAttachmentBatch({
                  scope: event.scope,
                  eventId: event.id,
                  connectionId: event.connectionId,
                  descriptors: normalized.attachments,
                  expiresAt,
                  receivedAt: context.receivedAt,
                  locators,
                  fetcher,
                  signal,
                });
              try {
                for (const descriptor of pendingAttachments) {
                  await downloadInboundAttachment({
                    scope: event.scope,
                    descriptor,
                    fetcher,
                    storageRoot:
                      dependencies.attachmentStorageDir,
                    repository:
                      dependencies.repositories.messageAttachments,
                    bindPrivateAttachment: async (
                      attachmentId,
                    ) => {
                      const bound =
                        await locators.bindPrivateAttachment(
                          event.scope,
                          event.id,
                          descriptor.externalAttachmentId,
                          attachmentId,
                          new Date(),
                        );
                      if (!bound) {
                        throw new Error(
                          "attachment_bind_transition_failed",
                        );
                      }
                    },
                    signal,
                  });
                }
              } finally {
                for (const descriptor of pendingAttachments) {
                  fetcher.release(descriptor);
                }
              }
            },
          });
        },
        {
          timeoutMs: 30_000,
          timeoutCode: "channel_ingress_timeout",
        },
      ),
  });
  return adapter;
}

function createManagedMqttAdapter(
  connection: RuntimeChannelConnection,
  dependencies: ManagedAdapterDependencies,
) {
  const adapter = createMqttAdapter({
    scope: connection.scope,
    acceptInbound: (payload, context, scope) =>
      withUserDataLease(
        dependencies.repositories,
        scope.userId,
        async (_lease, signal) => {
          signal.throwIfAborted();
          return acceptInbound({
            adapter: adapter as ChannelAdapter<
              Record<string, unknown>
            >,
            payload,
            context,
            scope,
            access: createChannelAccessControl(
              dependencies.pool,
            ),
            events:
              dependencies.repositories.channelEvents,
            afterPersist: async (event, normalized) => {
              if (!normalized.replyHandle) return;
              if (!dependencies.replyHandles) {
                throw new Error(
                  "channel_secret_storage_blocked",
                );
              }
              await dependencies.replyHandles.persist(
                event.scope,
                event.id,
                event.connectionId,
                normalized.replyHandle,
                context.receivedAt,
              );
            },
          });
        },
        {
          timeoutMs: 30_000,
          timeoutCode: "channel_ingress_timeout",
        },
      ),
  });
  return adapter;
}

function createManagedQQAdapter(
  connection: RuntimeChannelConnection,
  dependencies: ManagedAdapterDependencies,
) {
  const adapter = createQQAdapter({
    scope: connection.scope,
    ...(connection.resumeState
      ? { initialResumeState: connection.resumeState }
      : {}),
    acceptInbound: (payload, context, scope) =>
      withUserDataLease(
        dependencies.repositories,
        scope.userId,
        async (_lease, signal) => {
          signal.throwIfAborted();
          return acceptInbound({
            adapter: adapter as ChannelAdapter<
              Record<string, unknown>
            >,
            payload,
            context,
            scope,
            access: createChannelAccessControl(
              dependencies.pool,
            ),
            events:
              dependencies.repositories.channelEvents,
            afterPersist: async (event, normalized) => {
              if (normalized.replyHandle) {
                if (!dependencies.replyHandles) {
                  throw new Error(
                    "channel_secret_storage_blocked",
                  );
                }
                await dependencies.replyHandles.persist(
                  event.scope,
                  event.id,
                  event.connectionId,
                  normalized.replyHandle,
                  context.receivedAt,
                );
              }
              if (normalized.attachments.length === 0) {
                return;
              }
              const locators = dependencies.attachmentLocators;
              if (!locators) {
                throw new Error(
                  "channel_secret_storage_blocked",
                );
              }
              const expiresAt = new Date(
                context.receivedAt.getTime()
                  + 60 * 60 * 1_000,
              );
              const fetcher = createQQAttachmentFetcher(
                parseQQConfig(connection.config),
              );
              for (const descriptor of normalized.attachments) {
                const persisted = await locators.persist(
                  event.scope,
                  event.id,
                  event.connectionId,
                  descriptor,
                  expiresAt,
                  context.receivedAt,
                );
                if (!persisted) continue;
                await downloadInboundAttachment({
                  scope: event.scope,
                  descriptor,
                  fetcher,
                  storageRoot:
                    dependencies.attachmentStorageDir,
                  repository:
                    dependencies.repositories.messageAttachments,
                  bindPrivateAttachment: async (
                    attachmentId,
                  ) => {
                    const bound =
                      await locators.bindPrivateAttachment(
                        event.scope,
                        event.id,
                        descriptor.externalAttachmentId,
                        attachmentId,
                        new Date(),
                      );
                    if (!bound) {
                      throw new Error(
                        "attachment_bind_transition_failed",
                      );
                    }
                  },
                  signal,
                });
              }
            },
          });
        },
        {
          timeoutMs: 30_000,
          timeoutCode: "channel_ingress_timeout",
        },
      ),
  });
  return adapter;
}

function createManagedDingTalkAdapter(
  connection: RuntimeChannelConnection,
  dependencies: ManagedAdapterDependencies,
) {
  const adapter = createDingTalkAdapter({
    scope: connection.scope,
    acceptInbound: (
      payload,
      context,
      scope,
      acknowledge,
    ) =>
      withUserDataLease(
        dependencies.repositories,
        scope.userId,
        async (_lease, signal) => {
          signal.throwIfAborted();
          let acknowledged = false;
          const acknowledgeOnce = async () => {
            if (acknowledged) return;
            await acknowledge();
            acknowledged = true;
          };
          const result = await acceptInbound({
            adapter: adapter as ChannelAdapter<
              Record<string, unknown>
            >,
            payload,
            context,
            scope,
            access: createChannelAccessControl(
              dependencies.pool,
            ),
            events:
              dependencies.repositories.channelEvents,
            afterDurablePersist: acknowledgeOnce,
            afterPersist: async (event, normalized) => {
              if (normalized.replyHandle) {
                if (!dependencies.replyHandles) {
                  throw new Error(
                    "channel_secret_storage_blocked",
                  );
                }
                await dependencies.replyHandles.persist(
                  event.scope,
                  event.id,
                  event.connectionId,
                  normalized.replyHandle,
                  context.receivedAt,
                );
              }
              if (normalized.attachments.length === 0) {
                return;
              }
              const locators = dependencies.attachmentLocators;
              if (!locators) {
                throw new Error(
                  "channel_secret_storage_blocked",
                );
              }
              const expiresAt = new Date(
                context.receivedAt.getTime()
                  + 60 * 60 * 1_000,
              );
              const fetcher = createDingTalkAttachmentFetcher(
                parseDingTalkConfig(connection.config),
              );
              for (const descriptor of normalized.attachments) {
                const persisted = await locators.persist(
                  event.scope,
                  event.id,
                  event.connectionId,
                  descriptor,
                  expiresAt,
                  context.receivedAt,
                );
                if (!persisted) continue;
                await downloadInboundAttachment({
                  scope: event.scope,
                  descriptor,
                  fetcher,
                  storageRoot:
                    dependencies.attachmentStorageDir,
                  repository:
                    dependencies.repositories.messageAttachments,
                  bindPrivateAttachment: async (
                    attachmentId,
                  ) => {
                    const bound =
                      await locators.bindPrivateAttachment(
                        event.scope,
                        event.id,
                        descriptor.externalAttachmentId,
                        attachmentId,
                        new Date(),
                      );
                    if (!bound) {
                      throw new Error(
                        "attachment_bind_transition_failed",
                      );
                    }
                  },
                  signal,
                });
              }
            },
          });
          await acknowledgeOnce();
          return result;
        },
        {
          timeoutMs: 30_000,
          timeoutCode: "channel_ingress_timeout",
        },
      ),
  });
  return adapter;
}

function createManagedFeishuAdapter(
  connection: RuntimeChannelConnection,
  dependencies: ManagedAdapterDependencies,
) {
  const adapter = createFeishuAdapter({
    scope: connection.scope,
    acceptInbound: (payload, context, scope) =>
      withUserDataLease(
        dependencies.repositories,
        scope.userId,
        async (_lease, signal) => {
          signal.throwIfAborted();
          return acceptInbound({
            adapter: adapter as ChannelAdapter<
              Record<string, unknown>
            >,
            payload,
            context,
            scope,
            access: createChannelAccessControl(
              dependencies.pool,
            ),
            events:
              dependencies.repositories.channelEvents,
            afterPersist: async (event, normalized) => {
              if (normalized.replyHandle) {
                if (!dependencies.replyHandles) {
                  throw new Error(
                    "channel_secret_storage_blocked",
                  );
                }
                await dependencies.replyHandles.persist(
                  event.scope,
                  event.id,
                  event.connectionId,
                  normalized.replyHandle,
                  context.receivedAt,
                );
              }
              if (normalized.attachments.length === 0) {
                return;
              }
              const locators = dependencies.attachmentLocators;
              if (!locators) {
                throw new Error(
                  "channel_secret_storage_blocked",
                );
              }
              const expiresAt = new Date(
                context.receivedAt.getTime()
                  + 60 * 60 * 1_000,
              );
              const fetcher = createFeishuAttachmentFetcher(
                parseFeishuConfig(connection.config),
              );
              for (const descriptor of normalized.attachments) {
                const persisted = await locators.persist(
                  event.scope,
                  event.id,
                  event.connectionId,
                  descriptor,
                  expiresAt,
                  context.receivedAt,
                );
                if (!persisted) continue;
                await downloadInboundAttachment({
                  scope: event.scope,
                  descriptor,
                  fetcher,
                  storageRoot:
                    dependencies.attachmentStorageDir,
                  repository:
                    dependencies.repositories.messageAttachments,
                  bindPrivateAttachment: async (
                    attachmentId,
                  ) => {
                    const bound =
                      await locators.bindPrivateAttachment(
                        event.scope,
                        event.id,
                        descriptor.externalAttachmentId,
                        attachmentId,
                        new Date(),
                      );
                    if (!bound) {
                      throw new Error(
                        "attachment_bind_transition_failed",
                      );
                    }
                  },
                  signal,
                });
              }
            },
          });
        },
        {
          timeoutMs: 30_000,
          timeoutCode: "channel_ingress_timeout",
        },
      ),
  });
  return adapter;
}

function createManagedMattermostAdapter(
  connection: RuntimeChannelConnection,
  dependencies: ManagedAdapterDependencies,
) {
  const adapter = createMattermostAdapter({
    scope: connection.scope,
    acceptInbound: (payload, context, scope) =>
      withUserDataLease(
        dependencies.repositories,
        scope.userId,
        async (_lease, signal) => {
          signal.throwIfAborted();
          return acceptInbound({
            adapter: adapter as ChannelAdapter<
              Record<string, unknown>
            >,
            payload,
            context,
            scope,
            access: createChannelAccessControl(
              dependencies.pool,
            ),
            events:
              dependencies.repositories.channelEvents,
            afterPersist: async (event, normalized) => {
              if (normalized.replyHandle) {
                if (!dependencies.replyHandles) {
                  throw new Error(
                    "channel_secret_storage_blocked",
                  );
                }
                await dependencies.replyHandles.persist(
                  event.scope,
                  event.id,
                  event.connectionId,
                  normalized.replyHandle,
                  context.receivedAt,
                );
              }
              if (normalized.attachments.length === 0) {
                return;
              }
              const locators = dependencies.attachmentLocators;
              if (!locators) {
                throw new Error(
                  "channel_secret_storage_blocked",
                );
              }
              const expiresAt = new Date(
                context.receivedAt.getTime()
                  + 60 * 60 * 1_000,
              );
              const fetcher =
                createMattermostAttachmentFetcher(
                  parseMattermostConfig(connection.config),
                );
              for (const descriptor of normalized.attachments) {
                const persisted = await locators.persist(
                  event.scope,
                  event.id,
                  event.connectionId,
                  descriptor,
                  expiresAt,
                  context.receivedAt,
                );
                if (!persisted) continue;
                await downloadInboundAttachment({
                  scope: event.scope,
                  descriptor,
                  fetcher,
                  storageRoot:
                    dependencies.attachmentStorageDir,
                  repository:
                    dependencies.repositories.messageAttachments,
                  bindPrivateAttachment: async (
                    attachmentId,
                  ) => {
                    const bound =
                      await locators.bindPrivateAttachment(
                        event.scope,
                        event.id,
                        descriptor.externalAttachmentId,
                        attachmentId,
                        new Date(),
                      );
                    if (!bound) {
                      throw new Error(
                        "attachment_bind_transition_failed",
                      );
                    }
                  },
                  signal,
                });
              }
            },
          });
        },
        {
          timeoutMs: 30_000,
          timeoutCode: "channel_ingress_timeout",
        },
      ),
  });
  return adapter;
}

function createManagedSlackAdapter(
  connection: RuntimeChannelConnection,
  dependencies: ManagedAdapterDependencies,
) {
  const adapter = createSlackAdapter({
    scope: connection.scope,
    acceptInbound: (
      payload,
      context,
      scope,
      acknowledge,
    ) =>
      withUserDataLease(
        dependencies.repositories,
        scope.userId,
        async (_lease, signal) => {
          signal.throwIfAborted();
          let acknowledged = false;
          const acknowledgeOnce = async () => {
            if (acknowledged) return;
            await acknowledge();
            acknowledged = true;
          };
          const result = await acceptInbound({
            adapter: adapter as ChannelAdapter<
              Record<string, unknown>
            >,
            payload,
            context,
            scope,
            access: createChannelAccessControl(
              dependencies.pool,
            ),
            events:
              dependencies.repositories.channelEvents,
            afterDurablePersist: async () => {
              await acknowledgeOnce();
            },
            afterPersist: async (event, normalized) => {
              if (normalized.replyHandle) {
                if (!dependencies.replyHandles) {
                  throw new Error(
                    "channel_secret_storage_blocked",
                  );
                }
                await dependencies.replyHandles.persist(
                  event.scope,
                  event.id,
                  event.connectionId,
                  normalized.replyHandle,
                  context.receivedAt,
                );
              }
              if (normalized.attachments.length === 0) {
                return;
              }
              const locators = dependencies.attachmentLocators;
              if (!locators) {
                throw new Error(
                  "channel_secret_storage_blocked",
                );
              }
              const expiresAt = new Date(
                context.receivedAt.getTime()
                  + 60 * 60 * 1_000,
              );
              const fetcher = createSlackAttachmentFetcher(
                parseSlackConfig(connection.config),
              );
              for (const descriptor of normalized.attachments) {
                const persisted = await locators.persist(
                  event.scope,
                  event.id,
                  event.connectionId,
                  descriptor,
                  expiresAt,
                  context.receivedAt,
                );
                if (!persisted) continue;
                await downloadInboundAttachment({
                  scope: event.scope,
                  descriptor,
                  fetcher,
                  storageRoot:
                    dependencies.attachmentStorageDir,
                  repository:
                    dependencies.repositories.messageAttachments,
                  bindPrivateAttachment: async (
                    attachmentId,
                  ) => {
                    const bound =
                      await locators.bindPrivateAttachment(
                        event.scope,
                        event.id,
                        descriptor.externalAttachmentId,
                        attachmentId,
                        new Date(),
                      );
                    if (!bound) {
                      throw new Error(
                        "attachment_bind_transition_failed",
                      );
                    }
                  },
                  signal,
                });
              }
            },
          });
          await acknowledgeOnce();
          return result;
        },
        {
          timeoutMs: 30_000,
          timeoutCode: "channel_ingress_timeout",
        },
      ),
  });
  return adapter;
}

function createManagedDiscordAdapter(
  connection: RuntimeChannelConnection,
  dependencies: ManagedAdapterDependencies,
) {
  const adapter = createDiscordAdapter({
    scope: connection.scope,
    acceptInbound: (payload, context, scope) =>
      withUserDataLease(
        dependencies.repositories,
        scope.userId,
        async (_lease, signal) => {
          signal.throwIfAborted();
          return acceptInbound({
            adapter: adapter as ChannelAdapter<
              Record<string, unknown>
            >,
            payload,
            context,
            scope,
            access: createChannelAccessControl(
              dependencies.pool,
            ),
            events:
              dependencies.repositories.channelEvents,
            afterPersist: async (event, normalized) => {
              if (normalized.replyHandle) {
                if (!dependencies.replyHandles) {
                  throw new Error(
                    "channel_secret_storage_blocked",
                  );
                }
                await dependencies.replyHandles.persist(
                  event.scope,
                  event.id,
                  event.connectionId,
                  normalized.replyHandle,
                  context.receivedAt,
                );
              }
              if (normalized.attachments.length === 0) {
                return;
              }
              const locators = dependencies.attachmentLocators;
              if (!locators) {
                throw new Error(
                  "channel_secret_storage_blocked",
                );
              }
              const expiresAt = new Date(
                context.receivedAt.getTime()
                  + 60 * 60 * 1_000,
              );
              const fetcher = createDiscordAttachmentFetcher(
                parseDiscordConfig(connection.config),
              );
              for (const descriptor of normalized.attachments) {
                const persisted = await locators.persist(
                  event.scope,
                  event.id,
                  event.connectionId,
                  descriptor,
                  expiresAt,
                  context.receivedAt,
                );
                if (!persisted) continue;
                await downloadInboundAttachment({
                  scope: event.scope,
                  descriptor,
                  fetcher,
                  storageRoot:
                    dependencies.attachmentStorageDir,
                  repository:
                    dependencies.repositories.messageAttachments,
                  bindPrivateAttachment: async (
                    attachmentId,
                  ) => {
                    const bound =
                      await locators.bindPrivateAttachment(
                        event.scope,
                        event.id,
                        descriptor.externalAttachmentId,
                        attachmentId,
                        new Date(),
                      );
                    if (!bound) {
                      throw new Error(
                        "attachment_bind_transition_failed",
                      );
                    }
                  },
                  signal,
                });
              }
            },
          });
        },
        {
          timeoutMs: 30_000,
          timeoutCode: "channel_ingress_timeout",
        },
      ),
  });
  return adapter;
}

function hasConfiguredString(value: unknown): boolean {
  return typeof value === "string"
    && value.trim().length > 0;
}

function createManagedTelegramAdapter(
  connection: RuntimeChannelConnection,
  dependencies: ManagedAdapterDependencies,
) {
  const adapter = createTelegramAdapter({
    scope: connection.scope,
    acceptInbound: (payload, context, scope) =>
      withUserDataLease(
        dependencies.repositories,
        scope.userId,
        async (_lease, signal) => {
          signal.throwIfAborted();
          return acceptInbound({
            adapter: adapter as ChannelAdapter<
              Record<string, unknown>
            >,
            payload,
            context,
            scope,
            access: createChannelAccessControl(
              dependencies.pool,
            ),
            events:
              dependencies.repositories.channelEvents,
            afterPersist: async (event, normalized) => {
              if (normalized.replyHandle) {
                if (!dependencies.replyHandles) {
                  throw new Error(
                    "channel_secret_storage_blocked",
                  );
                }
                await dependencies.replyHandles.persist(
                  event.scope,
                  event.id,
                  event.connectionId,
                  normalized.replyHandle,
                  context.receivedAt,
                );
              }
              if (normalized.attachments.length > 0) {
                if (!dependencies.attachmentLocators) {
                  throw new Error(
                    "channel_secret_storage_blocked",
                  );
                }
                const expiresAt = new Date(
                  context.receivedAt.getTime()
                    + 60 * 60 * 1_000,
                );
                const fetcher = createTelegramTransport()
                  .attachmentFetcher(
                    parseTelegramConfig(connection.config),
                  );
                for (const descriptor of normalized.attachments) {
                  const persisted =
                    await dependencies.attachmentLocators.persist(
                      event.scope,
                      event.id,
                      event.connectionId,
                      descriptor,
                      expiresAt,
                      context.receivedAt,
                    );
                  if (!persisted) continue;
                  await downloadInboundAttachment({
                    scope: event.scope,
                    descriptor,
                    fetcher,
                    storageRoot:
                      dependencies.attachmentStorageDir,
                    repository:
                      dependencies.repositories.messageAttachments,
                    bindPrivateAttachment: async (
                      attachmentId,
                    ) => {
                      const bound =
                        await dependencies.attachmentLocators!
                          .bindPrivateAttachment(
                            event.scope,
                            event.id,
                            descriptor.externalAttachmentId,
                            attachmentId,
                            new Date(),
                          );
                      if (!bound) {
                        throw new Error(
                          "attachment_bind_transition_failed",
                        );
                      }
                    },
                    signal,
                  });
                }
              }
            },
          });
        },
        {
          timeoutMs: 30_000,
          timeoutCode: "channel_ingress_timeout",
        },
      ),
    loadLastUpdateId: async (_connectionId, scope) => {
      const result = await dependencies.pool.query<{
        update_id: string | null;
      }>(
        `SELECT max(
           substring(external_event_id from 8)::bigint
         )::text AS update_id
         FROM channel_inbound_events
         WHERE user_id = $1
           AND agent_id = $2
           AND connection_id = $3
           AND status <> 'pending_attachments'
           AND external_event_id ~ '^update:[0-9]+$'`,
        [
          scope.userId,
          scope.agentId,
          connection.id,
        ],
      );
      const value = result.rows[0]?.update_id;
      if (!value) return null;
      const updateId = Number(value);
      return Number.isSafeInteger(updateId)
        && updateId >= 0
        ? updateId
        : null;
    },
  });
  return adapter;
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
  if (
    error
    && typeof error === "object"
    && "retryable" in error
    && typeof error.retryable === "boolean"
  ) {
    const retryAfterMs = "retryAfterMs" in error
      && typeof error.retryAfterMs === "number"
      && Number.isFinite(error.retryAfterMs)
      && error.retryAfterMs > 0
      ? error.retryAfterMs
      : undefined;
    return new ChannelSendError({
      code: code === "channel_runtime_failed"
        ? "network_unreachable"
        : code,
      retryable: error.retryable,
      ...(retryAfterMs ? { retryAfterMs } : {}),
    });
  }
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
