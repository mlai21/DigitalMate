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
  ResolvedRecipient,
  SendResult,
} from "@/server/channels/runtime/types";

import {
  parseYuanbaoConfig,
  type YuanbaoConfig,
} from "./config";
import { normalizeYuanbaoInbound } from "./normalize";
import {
  createYuanbaoWebSocketClient,
  mapYuanbaoError,
  type YuanbaoClientFactory,
  type YuanbaoClientPort,
  type YuanbaoConnectionState,
} from "./transport";

export {
  parseYuanbaoConfig,
  type YuanbaoConfig,
} from "./config";
export { normalizeYuanbaoInbound } from "./normalize";

export type YuanbaoAdapterDependencies = Readonly<{
  clientFactory?: YuanbaoClientFactory;
  scope?: AgentScope;
  acceptInbound?(
    payload: unknown,
    context: InboundContext,
    scope: AgentScope,
    attachmentFetcher: InboundAttachmentFetcher,
  ): Promise<IngressResult>;
  autoListen?: boolean;
  now?: () => Date;
}>;

export function createYuanbaoAdapter(
  dependencies: YuanbaoAdapterDependencies = {},
): ChannelAdapter<YuanbaoConfig> {
  const manifest = getChannelManifest("yuanbao");
  const now = dependencies.now ?? (() => new Date());
  let config: YuanbaoConfig | null = null;
  let client: YuanbaoClientPort | null = null;
  let botId = "";
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
  const typingStates = new Map<string, {
    timer: ReturnType<typeof setInterval> | null;
    chatType: "direct" | "group";
    targetId: string;
  }>();

  const adapter: ChannelAdapter<YuanbaoConfig> = {
    manifest,

    validateConfig(input) {
      config = parseYuanbaoConfig(input);
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
        retryExhausted,
        ...(lastConnectedAt ? { lastConnectedAt } : {}),
        ...(lastEventAt ? { lastEventAt } : {}),
        ...(nextAttemptAt ? { nextAttemptAt } : {}),
        ...(healthError ? { error: healthError } : {}),
      };
    },

    async normalizeInbound(payload, context) {
      return normalizeYuanbaoInbound(
        payload,
        context,
        requireConfig(config),
        botId,
      );
    },

    async acknowledge() {
      return {
        status: 202,
        headers: {
          "content-type":
            "application/json; charset=utf-8",
        },
        body: "{\"accepted\":true}",
      };
    },

    async send(delivery, context) {
      context.signal.throwIfAborted();
      const activeConfig = parseYuanbaoConfig(
        context.config,
      );
      const active = requireClient(client);
      const route = deliveryRoute(delivery);
      const prefix = delivery.deliverySequence === undefined
        || delivery.deliverySequence === 1
        ? activeConfig.bot_prefix
        : "";
      const body = prefixedBody(
        delivery.body,
        prefix,
      );
      if (!body.trim()) {
        throw new Error("yuanbao_delivery_body_empty");
      }
      if (Array.from(body).length > 2_800) {
        throw new Error(
          "yuanbao_delivery_body_too_large",
        );
      }
      const sent = await active.sendText({
        chatType: route.chatType,
        targetId: route.targetId,
        text: body,
        signal: context.signal,
      });
      return sendResult(
        sent.messageId,
        context.now(),
        route,
      );
    },

    async typing(recipient, active) {
      const route = typingRoute(recipient);
      const key =
        `${route.chatType}\u0000${route.targetId}`;
      if (active) {
        if (typingStates.has(key)) return;
        const state: {
          timer: ReturnType<typeof setInterval> | null;
          chatType: "direct" | "group";
          targetId: string;
        } = {
          timer: null,
          ...route,
        };
        typingStates.set(key, state);
        try {
          const activeClient = requireClient(client);
          await activeClient.sendTyping({
            ...route,
            heartbeat: 1,
          });
          if (typingStates.get(key) !== state) return;
          state.timer = setInterval(() => {
            if (
              typingStates.get(key) !== state
              || client !== activeClient
            ) {
              return;
            }
            void activeClient.sendTyping({
              ...route,
              heartbeat: 1,
            }).catch(() => undefined);
          }, 3_000);
          state.timer?.unref?.();
        } catch (error) {
          if (typingStates.get(key) === state) {
            typingStates.delete(key);
          }
          throw error;
        }
        return;
      }
      const state = typingStates.get(key);
      if (!state) return;
      typingStates.delete(key);
      if (state.timer) clearInterval(state.timer);
      await requireClient(client).sendTyping({
        ...route,
        heartbeat: 2,
      });
    },

    async resolveRecipient(target) {
      const chatType = target.chatType === "group"
        ? "group"
        : "direct";
      const targetId = chatType === "group"
        ? validIdentifier(
            target.externalConversationId,
          )
        : validIdentifier(
            target.externalUserId
            ?? target.externalConversationId,
          );
      if (!targetId) {
        throw new Error("yuanbao_recipient_invalid");
      }
      return {
        address: {
          chatType,
          targetId,
        },
      };
    },
  };

  return adapter;

  async function start(
    context: Parameters<typeof adapter.start>[0],
  ): Promise<void> {
    context.signal.throwIfAborted();
    const activeConfig = parseYuanbaoConfig(
      context.config,
    );
    config = activeConfig;
    if (
      dependencies.autoListen !== false
      && (
        !dependencies.acceptInbound
        || !dependencies.scope
      )
    ) {
      const error = new ChannelConnectionError({
        code: "runtime_prerequisite_missing",
        detail: "yuanbao_ingress_unavailable",
      });
      applyError(error);
      throw error;
    }
    status = "connecting";
    healthError = undefined;
    retryExhausted = false;
    const active = (
      dependencies.clientFactory
      ?? createYuanbaoWebSocketClient
    )(activeConfig);
    client = active;
    const onAbort = () => void stop();
    context.signal.addEventListener(
      "abort",
      onAbort,
      { once: true },
    );
    detachParent = () =>
      context.signal.removeEventListener(
        "abort",
        onAbort,
      );
    try {
      const ready = await active.start({
        signal: context.signal,
        async onInbound(inbound) {
          if (dependencies.autoListen !== false) {
            await dependencies.acceptInbound!(
              inbound,
              {
                connectionId: context.connectionId,
                agentId: context.agentId,
                receivedAt: now(),
              },
              dependencies.scope!,
              active.attachmentFetcher(),
            );
          }
          lastEventAt = now();
        },
        onState: applyState,
        onError: applyError,
        onReconnecting(attempt, attemptAt) {
          reconnectAttempts = attempt;
          nextAttemptAt = attemptAt;
          status = "degraded";
          healthError = {
            code: "network_unreachable",
            detail: "yuanbao_reconnecting",
          };
        },
        onReconnected() {
          status = "healthy";
          reconnectAttempts = 0;
          retryExhausted = false;
          nextAttemptAt = undefined;
          healthError = undefined;
          lastConnectedAt = now();
        },
      });
      botId = ready.botId;
      status = "healthy";
      reconnectAttempts = 0;
      retryExhausted = false;
      nextAttemptAt = undefined;
      healthError = undefined;
      lastConnectedAt = now();
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
      healthError = undefined;
      reconnectAttempts = 0;
      retryExhausted = false;
      nextAttemptAt = undefined;
      botId = "";
      clearTypingStates();
      await stopClient();
    })().finally(() => {
      stopPromise = null;
    });
    return stopPromise;
  }

  async function stopClient(): Promise<void> {
    const active = client;
    client = null;
    await active?.stop().catch(() => undefined);
  }

  function applyState(
    state: YuanbaoConnectionState,
  ): void {
    reconnectAttempts = state.reconnectAttempts;
    retryExhausted = state.retryExhausted === true;
    nextAttemptAt = state.nextAttemptAt;
    if (state.status === "connected") {
      status = "healthy";
      healthError = undefined;
      lastConnectedAt = now();
    } else if (status !== "stopped") {
      status = state.retryExhausted
        ? "disconnected"
        : "degraded";
    }
  }

  function applyError(error: unknown): void {
    const mapped = mapYuanbaoError(error);
    reconnectAttempts += 1;
    status = "degraded";
    healthError = {
      code: mapped.code,
      detail: mapped.detail,
    };
  }

  function clearTypingStates(): void {
    for (const state of typingStates.values()) {
      if (state.timer) clearInterval(state.timer);
    }
    typingStates.clear();
  }
}

function deliveryRoute(
  delivery: Parameters<
    ChannelAdapter<YuanbaoConfig>["send"]
  >[0],
): Readonly<{
  chatType: "direct" | "group";
  targetId: string;
}> {
  const handle = delivery.replyHandle?.publicFields;
  const chatType = handle?.chatType === "group"
    || (
      !handle
      && delivery.recipient.chatType === "group"
    )
    ? "group"
    : "direct";
  const targetId = validIdentifier(
    handle?.targetId
    ?? (
      chatType === "group"
        ? delivery.recipient.externalConversationId
        : delivery.recipient.externalUserId
          ?? delivery.recipient.externalConversationId
    ),
  );
  if (!targetId) {
    throw new Error("yuanbao_reply_target_invalid");
  }
  return { chatType, targetId };
}

function typingRoute(
  recipient: ResolvedRecipient,
): Readonly<{
  chatType: "direct" | "group";
  targetId: string;
}> {
  const chatType = recipient.address.chatType === "group"
    ? "group"
    : recipient.address.chatType === "direct"
      ? "direct"
      : null;
  const targetId = validIdentifier(
    recipient.address.targetId,
  );
  if (!chatType || !targetId) {
    throw new Error("yuanbao_recipient_invalid");
  }
  return { chatType, targetId };
}

function prefixedBody(
  body: string,
  prefix: string,
): string {
  if (!body.trim()) return "";
  return prefix ? `${prefix}${body}` : body;
}

function sendResult(
  externalMessageId: string,
  sentAt: Date,
  route: Readonly<{
    chatType: "direct" | "group";
    targetId: string;
  }>,
): SendResult {
  return {
    externalMessageId,
    sentAt,
    rawSummary: {
      chatType: route.chatType,
      targetId: route.targetId,
      chunkLimit: 2_800,
    },
  };
}

function connectionError(
  error: unknown,
): ChannelConnectionError {
  if (error instanceof ChannelConnectionError) {
    return error;
  }
  const mapped = mapYuanbaoError(error);
  return new ChannelConnectionError({
    code: mapped.code,
    detail: mapped.detail,
  });
}

function requireConfig(
  value: YuanbaoConfig | null,
): YuanbaoConfig {
  if (!value) {
    throw new Error("yuanbao_config_not_validated");
  }
  return value;
}

function requireClient(
  value: YuanbaoClientPort | null,
): YuanbaoClientPort {
  if (!value) {
    throw new Error("yuanbao_client_not_started");
  }
  return value;
}

function validIdentifier(
  value: unknown,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized
    && normalized.length <= 512
    && !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : null;
}
