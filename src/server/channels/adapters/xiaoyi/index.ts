import { createHash } from "node:crypto";

import type { AgentScope } from "@/server/agents/types";
import {
  getChannelManifest,
} from "@/server/channels/manifests/catalog";
import type {
  ChannelAdapter,
} from "@/server/channels/runtime/adapter";
import type {
  InboundAttachmentFetcher,
} from "@/server/channels/runtime/attachment-ingress";
import {
  ChannelConnectionError,
} from "@/server/channels/runtime/connection-manager";
import type {
  ChannelHealthErrorCode,
  InboundContext,
  IngressResult,
  NormalizedChannelEvent,
  SendResult,
  UnsealedReplyHandle,
} from "@/server/channels/runtime/types";

import {
  parseXiaoYiConfig,
  type XiaoYiConfig,
} from "./config";
import {
  buildXiaoYiArtifactFrame,
  buildXiaoYiCompletedFrame,
  buildXiaoYiControlResponse,
  normalizeXiaoYiInbound,
  XIAOYI_TEXT_CHUNK_LIMIT,
  xiaoYiControlRequest,
} from "./protocol";
import {
  createXiaoYiAttachmentFetcher,
  createXiaoYiWebSocketClient,
  mapXiaoYiError,
  XiaoYiTransportError,
  type XiaoYiClientFactory,
  type XiaoYiClientPort,
  type XiaoYiServerName,
} from "./transport";

export type XiaoYiAdapterDependencies = Readonly<{
  clientFactory?: XiaoYiClientFactory;
  scope?: AgentScope;
  acceptInbound?(
    payload: unknown,
    context: InboundContext,
    scope: AgentScope,
    attachmentFetcher: InboundAttachmentFetcher,
  ): Promise<IngressResult>;
  acceptControl?(
    event: NormalizedChannelEvent,
    scope: AgentScope,
  ): Promise<boolean>;
  attachmentFetcher?: InboundAttachmentFetcher;
  autoListen?: boolean;
  now?: () => Date;
}>;

export function createXiaoYiAdapter(
  dependencies: XiaoYiAdapterDependencies = {},
): ChannelAdapter<XiaoYiConfig> {
  const manifest = getChannelManifest("xiaoyi");
  const now = dependencies.now ?? (() => new Date());
  const attachmentFetcher =
    dependencies.attachmentFetcher
    ?? createXiaoYiAttachmentFetcher();
  const connectedServers =
    new Set<XiaoYiServerName>();
  let config: XiaoYiConfig | null = null;
  let client: XiaoYiClientPort | null = null;
  let status:
    | "stopped"
    | "connecting"
    | "healthy"
    | "degraded"
    | "disconnected" = "stopped";
  let lastConnectedAt: Date | undefined;
  let lastEventAt: Date | undefined;
  let nextAttemptAt: Date | undefined;
  let reconnectAttempts = 0;
  let retryExhausted = false;
  let healthError:
    | Readonly<{
        code: ChannelHealthErrorCode;
        detail: string;
      }>
    | undefined;
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let detachParent: (() => void) | null = null;

  const adapter: ChannelAdapter<XiaoYiConfig> = {
    manifest,

    validateConfig(input) {
      const parsed = parseXiaoYiConfig(input);
      config = parsed;
      return parsed;
    },

    start(context) {
      if (status === "healthy") return Promise.resolve();
      if (startPromise) return startPromise;
      startPromise = start(context).finally(() => {
        startPromise = null;
      });
      return startPromise;
    },

    async stop() {
      await stop();
    },

    async health() {
      return {
        status,
        checkedAt: now(),
        reconnectAttempts,
        retryExhausted,
        ...(lastConnectedAt ? { lastConnectedAt } : {}),
        ...(lastEventAt ? { lastEventAt } : {}),
        ...(nextAttemptAt ? { nextAttemptAt } : {}),
        ...(healthError ? { error: healthError } : {}),
      };
    },

    async normalizeInbound(payload, context) {
      return normalizeXiaoYiInbound(
        payload,
        context,
        requireConfig(config),
      );
    },

    async acknowledge() {
      return {
        status: 202,
        headers: {
          "content-type": "application/json; charset=utf-8",
        },
        body: "{\"accepted\":true}",
      };
    },

    async send(delivery, context) {
      context.signal.throwIfAborted();
      return sendDelivery({
        delivery,
        body: delivery.body,
        previousResult: null,
        final: true,
        signal: context.signal,
        sentAt: context.now(),
      });
    },

    async streaming(delivery, state) {
      const signal =
        state.signal ?? new AbortController().signal;
      signal.throwIfAborted();
      return sendDelivery({
        delivery,
        body: delivery.body,
        previousResult: state.previousResult ?? null,
        final: state.final,
        signal,
        sentAt: now(),
      });
    },

    async resolveRecipient(target) {
      const sessionId = validIdentifier(
        target.externalConversationId,
      );
      if (!sessionId) {
        throw new Error("xiaoyi_session_id_invalid");
      }
      return {
        address: {
          sessionId,
          conversationId: sessionId,
        },
      };
    },
  };

  return adapter;

  async function start(
    context: Parameters<typeof adapter.start>[0],
  ): Promise<void> {
    context.signal.throwIfAborted();
    const activeConfig = parseXiaoYiConfig(context.config);
    config = activeConfig;
    if (
      dependencies.autoListen !== false
      && (
        !dependencies.acceptInbound
        || !dependencies.acceptControl
        || !dependencies.scope
      )
    ) {
      const error = new ChannelConnectionError({
        code: "runtime_prerequisite_missing",
        detail: "xiaoyi_ingress_unavailable",
      });
      applyError(error);
      throw error;
    }

    status = "connecting";
    healthError = undefined;
    retryExhausted = false;
    connectedServers.clear();
    const activeClient = (
      dependencies.clientFactory
      ?? createXiaoYiWebSocketClient
    )(activeConfig);
    client = activeClient;
    const onParentAbort = () => {
      void stop();
    };
    context.signal.addEventListener(
      "abort",
      onParentAbort,
      { once: true },
    );
    detachParent = () =>
      context.signal.removeEventListener(
        "abort",
        onParentAbort,
      );

    try {
      await activeClient.start({
        signal: context.signal,
        config: activeConfig,
        onMessage: async (payload, serverName) => {
          const payloadAgentId = boundedAgentId(payload);
          if (
            payloadAgentId
            && payloadAgentId !== activeConfig.agent_id
          ) {
            return;
          }
          const control = xiaoYiControlRequest(payload);
          if (control) {
            if (
              dependencies.autoListen !== false
              && await dependencies.acceptControl!(
                controlEvent(
                  control,
                  serverName,
                  context,
                ),
                dependencies.scope!,
              )
            ) {
              await activeClient.send({
                preferredServer: serverName,
                payload: buildXiaoYiControlResponse({
                  agentId: activeConfig.agent_id,
                  ...control,
                }),
              });
            }
            lastEventAt = now();
            return;
          }
          if (dependencies.autoListen !== false) {
            await dependencies.acceptInbound!(
              { payload, serverName },
              {
                connectionId: context.connectionId,
                agentId: context.agentId,
                receivedAt: now(),
              },
              dependencies.scope!,
              attachmentFetcher,
            );
          }
          lastEventAt = now();
        },
        onServerState(serverName, connected) {
          if (connected) {
            connectedServers.add(serverName);
            status = "healthy";
            lastConnectedAt = now();
            reconnectAttempts = 0;
            nextAttemptAt = undefined;
            healthError = undefined;
            retryExhausted = false;
            return;
          }
          connectedServers.delete(serverName);
          if (connectedServers.size > 0) return;
          status = "disconnected";
          healthError = {
            code: "network_unreachable",
            detail: "xiaoyi_all_sockets_disconnected",
          };
        },
        onReconnect(_serverName, attempt, delayMs) {
          reconnectAttempts = Math.max(
            reconnectAttempts,
            attempt,
          );
          nextAttemptAt = new Date(
            now().getTime() + delayMs,
          );
          retryExhausted = attempt >= 50;
          if (connectedServers.size === 0) {
            status = "connecting";
          }
        },
        onError(error) {
          const mapped = mapXiaoYiError(error);
          if (
            connectedServers.size > 0
            && mapped.retryable
          ) {
            return;
          }
          applyError(mapped);
        },
      });
      if (connectedServers.size > 0) {
        status = "healthy";
        healthError = undefined;
      } else if (status === "connecting") {
        status = "disconnected";
        healthError = {
          code: "network_unreachable",
          detail: "xiaoyi_all_sockets_disconnected",
        };
      }
    } catch (error) {
      applyError(error);
      await stopClient();
      throw connectionError(error);
    }
  }

  async function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      detachParent?.();
      detachParent = null;
      status = "stopped";
      connectedServers.clear();
      reconnectAttempts = 0;
      nextAttemptAt = undefined;
      retryExhausted = false;
      healthError = undefined;
      await stopClient();
    })().finally(() => {
      stopPromise = null;
    });
    return stopPromise;
  }

  async function stopClient(): Promise<void> {
    const activeClient = client;
    client = null;
    await activeClient?.stop().catch(() => undefined);
  }

  async function sendDelivery(input: Readonly<{
    delivery: Parameters<typeof adapter.send>[0];
    body: string;
    previousResult: SendResult | null;
    final: boolean;
    signal: AbortSignal;
    sentAt: Date;
  }>): Promise<SendResult> {
    input.signal.throwIfAborted();
    const activeConfig = requireConfig(config);
    const route = replyRoute(
      input.delivery.replyHandle,
      input.sentAt,
    );
    const body = prefixedBody(
      input.body,
      activeConfig.bot_prefix,
    );
    const codePoints = Array.from(body);
    const previousCount = previousCodePointCount(
      input.previousResult,
    );
    if (previousCount > codePoints.length) {
      throw new Error("xiaoyi_stream_state_invalid");
    }
    const delta = codePoints.slice(previousCount).join("");
    const deltaLength = Array.from(delta).length;
    if (deltaLength > XIAOYI_TEXT_CHUNK_LIMIT) {
      throw new XiaoYiTransportError({
        code: "runtime_prerequisite_missing",
        detail: "xiaoyi_delivery_chunk_too_large",
        retryable: false,
      });
    }
    const responseId = deliveryMessageId(input.delivery.id);
    const activeClient = requireClient(client);
    let usedServer = route.serverName;
    if (input.final) {
      input.signal.throwIfAborted();
      const completed = await activeClient.send({
        preferredServer: usedServer,
        payload: buildXiaoYiCompletedFrame({
          agentId: activeConfig.agent_id,
          sessionId: route.sessionId,
          taskId: route.taskId,
          messageId: route.messageId,
        }),
      });
      usedServer = completed.serverName;
    }
    if (delta || input.final) {
      input.signal.throwIfAborted();
      const sent = await activeClient.send({
        preferredServer: usedServer,
        payload: buildXiaoYiArtifactFrame({
          agentId: activeConfig.agent_id,
          sessionId: route.sessionId,
          taskId: route.taskId,
          messageId: route.messageId,
          artifactId: artifactId(
            input.delivery.id,
            previousCount,
            deltaLength,
          ),
          text: delta,
          final: input.final,
        }),
      });
      usedServer = sent.serverName;
    }
    return {
      externalMessageId:
        `xiaoyi:response:${responseId}`,
      sentAt: input.sentAt,
      rawSummary: {
        mode: "a2a-stream",
        final: input.final,
        serverName: usedServer,
        sentCodePoints: codePoints.length,
      },
    };
  }

  function applyError(error: unknown): void {
    const mapped = error instanceof ChannelConnectionError
      ? error
      : mapXiaoYiError(error);
    status = "degraded";
    healthError = {
      code: mapped.code,
      detail: mapped.detail,
    };
    if (
      mapped instanceof XiaoYiTransportError
      && mapped.retryAfterMs !== undefined
    ) {
      nextAttemptAt = new Date(
        now().getTime() + mapped.retryAfterMs,
      );
    }
  }
}

function controlEvent(
  control: NonNullable<
    ReturnType<typeof xiaoYiControlRequest>
  >,
  serverName: XiaoYiServerName,
  context: Parameters<
    ChannelAdapter<XiaoYiConfig>["start"]
  >[0],
): NormalizedChannelEvent {
  const now = context.now();
  return {
    connectionId: context.connectionId,
    agentId: context.agentId,
    channelType: "xiaoyi",
    externalEventId:
      `xiaoyi:control:${control.method}:${control.requestId}`,
    externalConversationId: control.sessionId,
    externalSenderId: control.sessionId,
    chatType: "direct",
    mentioned: true,
    text: control.method === "tasks/cancel"
      ? "[取消任务]"
      : "[清除上下文]",
    thread: {},
    attachments: [],
    occurredAt: now,
    receivedAt: now,
    permission: {
      webSearch: false,
      backgroundNetwork: false,
      tools: false,
      skills: "none",
      attachmentsPresent: false,
    },
    rawSummary: {
      method: control.method,
      taskId: control.taskId,
      serverName,
      isBotEvent: false,
    },
  };
}

function replyRoute(
  handle: UnsealedReplyHandle | undefined,
  now: Date,
): Readonly<{
  sessionId: string;
  taskId: string;
  messageId: string;
  serverName: XiaoYiServerName;
}> {
  if (
    !handle
    || (
      handle.expiresAt
      && handle.expiresAt.getTime() <= now.getTime()
    )
  ) {
    throw new XiaoYiTransportError({
      code: "runtime_prerequisite_missing",
      detail: "xiaoyi_task_reply_handle_expired",
      retryable: false,
    });
  }
  const sessionId = validIdentifier(
    handle.publicFields.sessionId,
  );
  const taskId = validIdentifier(
    handle.secretFields.taskId,
  );
  const messageId = validIdentifier(
    handle.secretFields.messageId,
  );
  const serverName =
    handle.publicFields.serverName === "backup"
      ? "backup"
      : "primary";
  if (!sessionId || !taskId || !messageId) {
    throw new XiaoYiTransportError({
      code: "runtime_prerequisite_missing",
      detail: "xiaoyi_task_reply_handle_invalid",
      retryable: false,
    });
  }
  return {
    sessionId,
    taskId,
    messageId,
    serverName,
  };
}

function previousCodePointCount(
  result: SendResult | null,
): number {
  if (!result) return 0;
  const value = result.rawSummary.sentCodePoints;
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : 0;
}

function deliveryMessageId(deliveryId: string): string {
  return `dm-${createHash("sha256")
    .update(deliveryId)
    .digest("hex")
    .slice(0, 32)}`;
}

function artifactId(
  deliveryId: string,
  offset: number,
  length: number,
): string {
  return `artifact_${createHash("sha256")
    .update(deliveryId)
    .update(":")
    .update(String(offset))
    .update(":")
    .update(String(length))
    .digest("hex")
    .slice(0, 16)}`;
}

function prefixedBody(body: string, prefix: string): string {
  if (!body.trim()) throw new Error("xiaoyi_message_empty");
  return prefix ? `${prefix}${body}` : body;
}

function boundedAgentId(payload: unknown): string | null {
  const record = payload !== null
    && typeof payload === "object"
    && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  return validIdentifier(record.agentId);
}

function validIdentifier(value: unknown): string | null {
  if (
    typeof value !== "string"
    && typeof value !== "number"
  ) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized
    && normalized.length <= 1_024
    && !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : null;
}

function requireClient(
  client: XiaoYiClientPort | null,
): XiaoYiClientPort {
  if (!client) throw new Error("xiaoyi_client_not_started");
  return client;
}

function requireConfig(
  config: XiaoYiConfig | null,
): XiaoYiConfig {
  if (!config) throw new Error("xiaoyi_config_not_validated");
  return config;
}

function connectionError(error: unknown): Error {
  if (error instanceof ChannelConnectionError) return error;
  const mapped = mapXiaoYiError(error);
  return new ChannelConnectionError({
    code: mapped.code,
    detail: mapped.detail,
  });
}

export {
  parseXiaoYiConfig,
  type XiaoYiConfig,
} from "./config";
