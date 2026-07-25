import type { AgentScope } from "@/server/agents/types";
import { getChannelManifest } from "@/server/channels/manifests/catalog";
import type { ChannelAdapter } from "@/server/channels/runtime/adapter";
import {
  ChannelConnectionError,
} from "@/server/channels/runtime/connection-manager";
import type {
  InboundContext,
  IngressResult,
  SendResult,
} from "@/server/channels/runtime/types";

import { parseQQConfig, type QQConfig } from "./config";
import { normalizeQQInbound } from "./normalize";
import {
  createQQGatewayClient,
  QQTransportError,
  type QQClientFactory,
  type QQClientPort,
  type QQConnectionState,
  type QQResumeState,
} from "./transport";

export type QQAdapterDependencies = Readonly<{
  clientFactory?: QQClientFactory;
  scope?: AgentScope;
  acceptInbound?(
    payload: unknown,
    context: InboundContext,
    scope: AgentScope,
  ): Promise<IngressResult>;
  initialResumeState?: QQResumeState;
  autoListen?: boolean;
  now?: () => Date;
}>;

export function createQQAdapter(
  dependencies: QQAdapterDependencies = {},
): ChannelAdapter<QQConfig> {
  const manifest = getChannelManifest("qq");
  const now = dependencies.now ?? (() => new Date());
  const messageSequences = new Map<string, number>();
  let config: QQConfig | null = null;
  let client: QQClientPort | null = null;
  let status:
    | "stopped"
    | "healthy"
    | "degraded"
    | "disconnected" = "stopped";
  let lastConnectedAt: Date | undefined;
  let lastEventAt: Date | undefined;
  let reconnectAttempts = 0;
  let retryExhausted = false;
  let resumeState: QQResumeState | undefined =
    dependencies.initialResumeState;
  let healthError:
    | Readonly<{
        code:
          | "credential_invalid"
          | "permission_denied"
          | "polling_conflict"
          | "network_unreachable"
          | "rate_limited"
          | "runtime_prerequisite_missing"
          | "unknown";
        detail: string;
      }>
    | undefined;
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let detachParent: (() => void) | null = null;

  const adapter: ChannelAdapter<QQConfig> = {
    manifest,
    validateConfig(input) {
      config = parseQQConfig(input);
      return config;
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
        ...(retryExhausted ? { retryExhausted: true } : {}),
        ...(lastConnectedAt ? { lastConnectedAt } : {}),
        ...(lastEventAt ? { lastEventAt } : {}),
        ...(resumeState ? { resumeState } : {}),
        ...(healthError ? { error: healthError } : {}),
      };
    },
    async normalizeInbound(payload, context) {
      return normalizeQQInbound(payload, context);
    },
    async acknowledge() {
      return { status: 200, body: "{\"ok\":true}" };
    },
    async send(delivery, context) {
      context.signal.throwIfAborted();
      const activeConfig = parseQQConfig(context.config);
      const route = deliveryRoute(delivery);
      const sequenceKey = route.messageId
        ?? `${route.messageType}:${route.conversationId}`;
      const sent = await withClient(
        activeConfig,
        (active) => active.sendMessage({
          messageType: route.messageType,
          conversationId: route.conversationId,
          senderId: route.senderId,
          ...(route.messageId ? { messageId: route.messageId } : {}),
          content: withBotPrefix(
            delivery.body,
            activeConfig.bot_prefix,
          ),
          markdown: activeConfig.markdown_enabled,
          msgSeq: delivery.deliverySequence
            ?? nextMessageSequence(sequenceKey),
          signal: context.signal,
        }),
      );
      return sendResult(sent.messageId, context.now());
    },
    async resolveRecipient(target) {
      return {
        address: {
          conversationId: target.externalConversationId,
          ...(target.externalUserId
            ? { senderId: target.externalUserId }
            : {}),
        },
      };
    },
  };
  return adapter;

  async function start(
    context: Parameters<typeof adapter.start>[0],
  ) {
    const activeConfig = parseQQConfig(context.config);
    config = activeConfig;
    if (
      dependencies.autoListen !== false
      && (!dependencies.acceptInbound || !dependencies.scope)
    ) {
      const error = new ChannelConnectionError({
        code: "runtime_prerequisite_missing",
        detail: "qq_ingress_unavailable",
      });
      applyError(error);
      throw error;
    }
    const active = (
      dependencies.clientFactory ?? createQQGatewayClient
    )(activeConfig);
    client = active;
    const onAbort = () => void stop();
    context.signal.addEventListener("abort", onAbort, { once: true });
    detachParent = () =>
      context.signal.removeEventListener("abort", onAbort);
    try {
      const ready = await active.start({
        signal: context.signal,
        ...(resumeState ? { resumeState } : {}),
        onEvent: async (payload) => {
          if (dependencies.autoListen !== false) {
            await dependencies.acceptInbound!(
              payload,
              {
                connectionId: context.connectionId,
                agentId: context.agentId,
                receivedAt: now(),
              },
              dependencies.scope!,
            );
          }
          lastEventAt = now();
        },
        onState: applyConnectionState,
        onError: applyError,
        onReconnecting() {
          status = "degraded";
          healthError = {
            code: "network_unreachable",
            detail: "network_unreachable",
          };
        },
        onReconnected() {
          status = "healthy";
          reconnectAttempts = 0;
          retryExhausted = false;
          healthError = undefined;
          lastConnectedAt = now();
        },
      });
      resumeState = ready;
      status = "healthy";
      lastConnectedAt = now();
      reconnectAttempts = 0;
      retryExhausted = false;
      healthError = undefined;
    } catch (error) {
      applyError(error);
      await stopClient();
      throw connectionError(error);
    }
  }

  async function stop() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      detachParent?.();
      detachParent = null;
      status = "stopped";
      healthError = undefined;
      reconnectAttempts = 0;
      retryExhausted = false;
      await stopClient();
    })().finally(() => {
      stopPromise = null;
    });
    return stopPromise;
  }

  async function stopClient() {
    const active = client;
    client = null;
    await active?.stop().catch(() => undefined);
  }

  async function withClient<T>(
    activeConfig: QQConfig,
    action: (active: QQClientPort) => Promise<T>,
  ) {
    if (client) return action(client);
    const transient = (
      dependencies.clientFactory ?? createQQGatewayClient
    )(activeConfig);
    try {
      return await action(transient);
    } finally {
      await transient.stop().catch(() => undefined);
    }
  }

  function nextMessageSequence(key: string) {
    const next = (messageSequences.get(key) ?? 0) + 1;
    messageSequences.set(key, next);
    if (messageSequences.size > 1_000) {
      for (const existing of [...messageSequences.keys()].slice(0, 500)) {
        messageSequences.delete(existing);
      }
    }
    return next;
  }

  function applyConnectionState(state: QQConnectionState) {
    reconnectAttempts = state.reconnectAttempts;
    if (state.sessionId && state.sequence !== null) {
      resumeState = {
        sessionId: state.sessionId,
        sequence: state.sequence,
      };
    }
    if (state.exhausted) {
      status = "disconnected";
      retryExhausted = true;
      healthError = {
        code: "network_unreachable",
        detail: "qq_reconnect_exhausted",
      };
    }
  }

  function applyError(error: unknown) {
    status = "degraded";
    reconnectAttempts += 1;
    const code = error instanceof QQTransportError
      ? error.code === "response_invalid" ? "unknown" : error.code
      : error instanceof ChannelConnectionError
        ? error.code
        : "network_unreachable";
    const detail = error instanceof QQTransportError
      ? error.detail
      : code;
    healthError = { code, detail };
  }
}

function deliveryRoute(
  delivery: Parameters<ChannelAdapter<QQConfig>["send"]>[0],
) {
  const fields = delivery.replyHandle?.publicFields;
  const explicitType = fields?.messageType;
  const encoded = parseConversation(
    delivery.recipient.externalConversationId,
  );
  const messageType = isMessageType(explicitType)
    ? explicitType
    : encoded.messageType;
  const conversationId = messageType === "group"
    ? fields?.groupOpenId ?? encoded.id
    : messageType === "guild"
      ? fields?.channelId ?? encoded.id
      : messageType === "dm"
        ? fields?.guildId ?? encoded.id
        : delivery.recipient.externalUserId ?? encoded.id;
  const senderId = fields?.senderId
    ?? delivery.recipient.externalUserId
    ?? encoded.id;
  if (!conversationId || !senderId) {
    throw new Error("qq_recipient_invalid");
  }
  return {
    messageType,
    conversationId,
    senderId,
    messageId: fields?.messageId,
  } as const;
}

function parseConversation(value: string) {
  const separator = value.indexOf(":");
  const prefix = separator > 0 ? value.slice(0, separator) : "c2c";
  const id = separator > 0 ? value.slice(separator + 1) : value;
  return {
    messageType: isMessageType(prefix) ? prefix : "c2c",
    id,
  } as const;
}

function isMessageType(
  value: unknown,
): value is "c2c" | "group" | "guild" | "dm" {
  return ["c2c", "group", "guild", "dm"].includes(String(value));
}

function withBotPrefix(body: string, value: unknown) {
  const prefix = typeof value === "string" ? value : "";
  return `${prefix}${body}`;
}

function sendResult(id: string, sentAt: Date): SendResult {
  return {
    externalMessageId: id,
    sentAt,
    rawSummary: { ok: true, edited: false },
  };
}

function connectionError(error: unknown) {
  if (error instanceof ChannelConnectionError) return error;
  const code = error instanceof QQTransportError
    ? error.code === "credential_invalid" ? "credential_invalid"
      : error.code === "permission_denied" ? "permission_denied"
        : error.code === "rate_limited" ? "rate_limited"
          : "network_unreachable"
    : "network_unreachable";
  return new ChannelConnectionError({
    code,
    detail: error instanceof QQTransportError
      ? error.detail
      : code,
  });
}

export type { QQConfig, QQResumeState };
