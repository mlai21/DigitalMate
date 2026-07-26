import type { AgentScope } from "@/server/agents/types";
import {
  getChannelManifest,
} from "@/server/channels/manifests/catalog";
import type {
  ChannelAdapter,
} from "@/server/channels/runtime/adapter";
import {
  ChannelConnectionError,
} from "@/server/channels/runtime/connection-manager";
import type {
  ChannelHealthErrorCode,
  InboundContext,
  IngressResult,
  SendResult,
} from "@/server/channels/runtime/types";

import {
  parseOneBotConfig,
  type OneBotConfig,
} from "./config";
import { normalizeOneBotInbound } from "./normalize";
import {
  oneBotGatewayHub,
  OneBotTransportError,
  type OneBotTransportPort,
} from "./transport";

export type OneBotAdapterDependencies = Readonly<{
  transport?: OneBotTransportPort;
  scope?: AgentScope;
  acceptInbound?(
    payload: unknown,
    context: InboundContext,
    scope: AgentScope,
  ): Promise<IngressResult>;
  autoListen?: boolean;
  now?: () => Date;
}>;

export function createOneBotAdapter(
  dependencies: OneBotAdapterDependencies = {},
): ChannelAdapter<OneBotConfig> {
  const manifest = getChannelManifest("onebot");
  const now = dependencies.now ?? (() => new Date());
  const transport = dependencies.transport
    ?? oneBotGatewayHub.createTransport();
  let config: OneBotConfig | null = null;
  let status:
    | "stopped"
    | "healthy"
    | "degraded" = "stopped";
  let started = false;
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let stopRequested = false;
  let lastConnectedAt: Date | undefined;
  let lastEventAt: Date | undefined;
  let reconnectAttempts = 0;
  let detachParent: (() => void) | null = null;
  let healthError:
    | Readonly<{
        code: ChannelHealthErrorCode;
        detail: string;
      }>
    | undefined;

  const adapter: ChannelAdapter<OneBotConfig> = {
    manifest,
    validateConfig(input) {
      config = parseOneBotConfig(input);
      return config;
    },
    start(context) {
      if (stopPromise) {
        return stopPromise.then(() => adapter.start(context));
      }
      if (started) return Promise.resolve();
      if (startPromise) return startPromise;
      stopRequested = false;
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
        ...(lastConnectedAt ? { lastConnectedAt } : {}),
        ...(lastEventAt ? { lastEventAt } : {}),
        ...(healthError ? { error: healthError } : {}),
      };
    },
    async normalizeInbound(payload, context) {
      if (!config) {
        throw new Error("onebot_config_unavailable");
      }
      return normalizeOneBotInbound(payload, context, {
        shareSessionInGroup: config.share_session_in_group,
      });
    },
    async acknowledge() {
      return { status: 200, body: "{\"ok\":true}" };
    },
    async send(delivery, context) {
      context.signal.throwIfAborted();
      const activeConfig = parseOneBotConfig(context.config);
      const route = deliveryRoute(delivery);
      const response = await transport.request(
        route.messageType === "group"
          ? "send_group_msg"
          : "send_private_msg",
        route.messageType === "group"
          ? {
              group_id: route.groupId,
              message: textSegments(
                `${activeConfig.bot_prefix}${delivery.body}`,
              ),
            }
          : {
              user_id: route.userId,
              message: textSegments(
                `${activeConfig.bot_prefix}${delivery.body}`,
              ),
            },
        context.signal,
      );
      const externalMessageId = oneBotId(
        response.data.message_id,
      );
      if (!externalMessageId) {
        throw new OneBotTransportError({
          code: "response_invalid",
          retryable: false,
        });
      }
      return sendResult(externalMessageId, context.now());
    },
    async resolveRecipient(target) {
      const route = parseConversation(
        target.externalConversationId,
        target.externalUserId,
        target.chatType,
      );
      const address: Record<string, string> =
        route.messageType === "group"
          ? {
              messageType: "group",
              groupId: route.groupId,
            }
          : {
              messageType: "private",
              userId: route.userId,
            };
      return {
        address,
      };
    },
  };
  return adapter;

  async function start(
    context: Parameters<typeof adapter.start>[0],
  ): Promise<void> {
    const activeConfig = parseOneBotConfig(context.config);
    config = activeConfig;
    if (
      dependencies.autoListen !== false
      && (!dependencies.acceptInbound || !dependencies.scope)
    ) {
      const error = new ChannelConnectionError({
        code: "runtime_prerequisite_missing",
        detail: "onebot_ingress_unavailable",
      });
      applyError(error);
      throw error;
    }
    try {
      const onAbort = () => void stop();
      context.signal.addEventListener("abort", onAbort, {
        once: true,
      });
      detachParent = () =>
        context.signal.removeEventListener("abort", onAbort);
      await transport.start({
        connectionId: context.connectionId,
        accessToken: activeConfig.access_token,
        signal: context.signal,
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
        onConnected() {
          status = "healthy";
          reconnectAttempts = 0;
          healthError = undefined;
          lastConnectedAt = now();
        },
        onDisconnected(error) {
          if (!started) return;
          status = "degraded";
          reconnectAttempts += 1;
          applyError(error, false);
        },
      });
      if (stopRequested || context.signal.aborted) {
        throw context.signal.reason instanceof Error
          ? context.signal.reason
          : new Error("onebot_start_cancelled");
      }
      started = true;
      // A reverse-WS adapter is operational once its authenticated route is
      // registered; lastConnectedAt distinguishes a connected OneBot peer.
      status = "healthy";
      reconnectAttempts = 0;
      healthError = undefined;
    } catch (error) {
      detachParent?.();
      detachParent = null;
      if (!stopRequested) {
        await transport.stop().catch(() => undefined);
      }
      applyError(error);
      throw connectionError(error);
    }
  }

  async function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    if (!started && !startPromise && status === "stopped") return;
    stopRequested = true;
    const pendingStart = startPromise;
    stopPromise = (async () => {
      await pendingStart?.catch(() => undefined);
      started = false;
      detachParent?.();
      detachParent = null;
      await transport.stop();
    })().finally(() => {
      status = "stopped";
      reconnectAttempts = 0;
      healthError = undefined;
      stopPromise = null;
    });
    return stopPromise;
  }

  function applyError(error: unknown, increment = true): void {
    status = "degraded";
    if (increment) reconnectAttempts += 1;
    const code = error instanceof OneBotTransportError
      ? error.code === "response_invalid" ? "unknown" : error.code
      : error instanceof ChannelConnectionError
        ? error.code
        : "network_unreachable";
    healthError = {
      code,
      detail: code,
    };
  }
}

function deliveryRoute(
  delivery: Parameters<
    ChannelAdapter<OneBotConfig>["send"]
  >[0],
) {
  const fields = delivery.replyHandle?.publicFields;
  return parseConversation(
    delivery.recipient.externalConversationId,
    fields?.userId ?? delivery.recipient.externalUserId,
    fields?.messageType === "group"
      ? "group"
      : fields?.messageType === "private"
        ? "direct"
        : delivery.recipient.chatType,
    fields?.groupId,
  );
}

function parseConversation(
  value: string,
  userId?: string,
  chatType?: "direct" | "group",
  explicitGroupId?: string,
) {
  const groupMatch = /^group:([^:]+)(?::user:([^:]+))?$/u.exec(value);
  if (chatType === "group" || groupMatch) {
    const groupId = oneBotId(explicitGroupId ?? groupMatch?.[1]);
    if (!groupId) throw new Error("onebot_recipient_invalid");
    return {
      messageType: "group" as const,
      groupId,
      userId: oneBotId(userId ?? groupMatch?.[2]) ?? "",
    };
  }
  const privateMatch = /^private:([^:]+)$/u.exec(value);
  const resolvedUserId = oneBotId(
    userId ?? privateMatch?.[1] ?? value,
  );
  if (!resolvedUserId) throw new Error("onebot_recipient_invalid");
  return {
    messageType: "private" as const,
    userId: resolvedUserId,
    groupId: "",
  };
}

function textSegments(text: string) {
  return [{ type: "text", data: { text } }] as const;
}

function oneBotId(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const normalized = String(value).trim();
  return normalized.length > 0
    && normalized.length <= 256
    && /^[A-Za-z0-9_.:-]+$/u.test(normalized)
    ? normalized
    : null;
}

function sendResult(
  externalMessageId: string,
  sentAt: Date,
): SendResult {
  return {
    externalMessageId,
    sentAt,
    rawSummary: {
      ok: true,
      action: "send_message",
    },
  };
}

function connectionError(error: unknown): ChannelConnectionError {
  if (error instanceof ChannelConnectionError) return error;
  const code = error instanceof OneBotTransportError
    ? error.code === "response_invalid"
      ? "unknown"
      : error.code
    : "network_unreachable";
  return new ChannelConnectionError({
    code,
    detail: code,
  });
}
