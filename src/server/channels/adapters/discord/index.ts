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
  InboundContext,
  IngressResult,
  SendResult,
} from "@/server/channels/runtime/types";

import {
  parseDiscordConfig,
  type DiscordConfig,
} from "./config";
import {
  normalizeDiscordInbound,
} from "./normalize";
import {
  createDiscordJsClient,
  DiscordTransportError,
  type DiscordClientFactory,
  type DiscordClientPort,
} from "./transport";

const MIN_STREAM_EDIT_INTERVAL_MS = 500;

export type DiscordAdapterDependencies = Readonly<{
  clientFactory?: DiscordClientFactory;
  scope?: AgentScope;
  acceptInbound?(
    payload: unknown,
    context: InboundContext,
    scope: AgentScope,
  ): Promise<IngressResult>;
  autoListen?: boolean;
  delay?(milliseconds: number, signal: AbortSignal): Promise<void>;
  now?: () => Date;
}>;

export function createDiscordAdapter(
  dependencies: DiscordAdapterDependencies = {},
): ChannelAdapter<DiscordConfig> {
  const manifest = getChannelManifest("discord");
  const now = dependencies.now ?? (() => new Date());
  let config: DiscordConfig | null = null;
  let client: DiscordClientPort | null = null;
  let botUserId: string | null = null;
  let status: "stopped" | "healthy" | "degraded" = "stopped";
  let lastConnectedAt: Date | undefined;
  let lastEventAt: Date | undefined;
  let reconnectAttempts = 0;
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

  const adapter: ChannelAdapter<DiscordConfig> = {
    manifest,

    validateConfig(input) {
      const parsed = parseDiscordConfig(input);
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
        ...(lastConnectedAt ? { lastConnectedAt } : {}),
        ...(lastEventAt ? { lastEventAt } : {}),
        ...(healthError ? { error: healthError } : {}),
      };
    },

    async normalizeInbound(payload, context) {
      return normalizeDiscordInbound(payload, context, {
        botUserId,
        acceptBotMessages: config?.accept_bot_messages === true,
      });
    },

    async acknowledge() {
      return {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
        },
        body: "{\"ok\":true}",
      };
    },

    async send(delivery, context) {
      context.signal.throwIfAborted();
      const address = deliveryAddress(delivery);
      const result = await withClient(
        context.config,
        (activeClient) =>
          activeClient.sendMessage({
            ...(address.channelId
              ? { channelId: address.channelId }
              : {}),
            ...(address.userId ? { userId: address.userId } : {}),
            content: delivery.body,
            ...(address.replyToMessageId
              ? {
                  replyToMessageId: address.replyToMessageId,
                }
              : {}),
          }),
      );
      const sentAt = context.now();
      return sendResult(result.messageId, sentAt, false);
    },

    async typing(recipient, active) {
      if (!active) return;
      const channelId = recipient.address.channelId
        ?? recipient.address.conversationId;
      if (!channelId) {
        throw new Error("discord_recipient_invalid");
      }
      await requireClient(client).sendTyping(channelId);
    },

    async streaming(delivery, state) {
      const activeConfig = requireConfig(config);
      const signal =
        state.signal ?? new AbortController().signal;
      if (
        !activeConfig.streaming_enabled
        || !state.previousResult
      ) {
        return adapter.send(delivery, {
          config: activeConfig,
          signal,
          now,
        });
      }

      const address = deliveryAddress(delivery);
      if (!address.channelId) {
        throw new Error("discord_stream_channel_missing");
      }
      const messageId =
        state.previousResult.externalMessageId;
      const elapsed = now().getTime()
        - state.previousResult.sentAt.getTime();
      if (elapsed < MIN_STREAM_EDIT_INTERVAL_MS) {
        await (dependencies.delay ?? delayWithSignal)(
          MIN_STREAM_EDIT_INTERVAL_MS - Math.max(elapsed, 0),
          signal,
        );
      }
      signal.throwIfAborted();
      await withClient(activeConfig, (activeClient) =>
        activeClient.editMessage({
          channelId: address.channelId!,
          messageId,
          content: delivery.body,
        })
      );
      const sentAt = now();
      return sendResult(messageId, sentAt, true);
    },

    async resolveRecipient(target) {
      return {
        address: {
          channelId:
            target.externalThreadId
            ?? target.externalConversationId,
          conversationId: target.externalConversationId,
          ...(target.externalUserId
            ? { userId: target.externalUserId }
            : {}),
        },
      };
    },
  };

  return adapter;

  async function start(
    context: Parameters<typeof adapter.start>[0],
  ): Promise<void> {
    context.signal.throwIfAborted();
    const activeConfig = parseDiscordConfig(context.config);
    config = activeConfig;
    if (
      dependencies.autoListen !== false
      && (!dependencies.acceptInbound || !dependencies.scope)
    ) {
      const error = new ChannelConnectionError({
        code: "runtime_prerequisite_missing",
        detail: "discord_ingress_unavailable",
      });
      applyError(error);
      throw error;
    }

    const activeClient = (
      dependencies.clientFactory ?? createDiscordJsClient
    )(activeConfig);
    client = activeClient;
    const onParentAbort = () => {
      void stop();
    };
    context.signal.addEventListener("abort", onParentAbort, {
      once: true,
    });
    detachParent = () =>
      context.signal.removeEventListener(
        "abort",
        onParentAbort,
      );

    try {
      const ready = await activeClient.start({
        token: activeConfig.bot_token,
        signal: context.signal,
        onMessage: async (payload) => {
          if (dependencies.autoListen === false) return;
          await dependencies.acceptInbound!(
            payload,
            {
              connectionId: context.connectionId,
              agentId: context.agentId,
              receivedAt: now(),
            },
            dependencies.scope!,
          );
          lastEventAt = now();
        },
        onError(error) {
          applyError(error);
        },
      });
      botUserId = ready.botUserId;
      status = "healthy";
      lastConnectedAt = now();
      reconnectAttempts = 0;
      healthError = undefined;
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
      botUserId = null;
      status = "stopped";
      healthError = undefined;
      reconnectAttempts = 0;
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

  function applyError(error: unknown): void {
    status = "degraded";
    reconnectAttempts += 1;
    const code = error instanceof DiscordTransportError
      ? error.code === "response_invalid"
        ? "unknown"
        : error.code
      : error instanceof ChannelConnectionError
        ? error.code
        : "network_unreachable";
    healthError = {
      code,
      detail: code,
    };
  }

  async function withClient<T>(
    activeConfig: DiscordConfig,
    action: (activeClient: DiscordClientPort) => Promise<T>,
  ): Promise<T> {
    if (client) return action(client);
    const transient = (
      dependencies.clientFactory ?? createDiscordJsClient
    )(activeConfig);
    try {
      return await action(transient);
    } finally {
      await transient.stop().catch(() => undefined);
    }
  }
}

function deliveryAddress(
  delivery: Parameters<
    ChannelAdapter<DiscordConfig>["send"]
  >[0],
): Readonly<{
  channelId?: string;
  userId?: string;
  replyToMessageId?: string;
}> {
  const publicFields = delivery.replyHandle?.publicFields;
  const channelId = publicFields?.channelId
    ?? delivery.recipient.externalThreadId
    ?? delivery.recipient.externalConversationId;
  const userId = delivery.recipient.externalUserId;
  const replyToMessageId =
    publicFields?.replyToMessageId;
  return {
    ...(channelId ? { channelId } : {}),
    ...(userId ? { userId } : {}),
    ...(replyToMessageId ? { replyToMessageId } : {}),
  };
}

function sendResult(
  messageId: string,
  sentAt: Date,
  edited: boolean,
): SendResult {
  return {
    externalMessageId: messageId,
    sentAt,
    rawSummary: { ok: true, edited },
  };
}

function requireClient(
  value: DiscordClientPort | null,
): DiscordClientPort {
  if (!value) throw new Error("discord_client_unavailable");
  return value;
}

function requireConfig(
  value: DiscordConfig | null,
): DiscordConfig {
  if (!value) throw new Error("discord_config_unavailable");
  return value;
}

function connectionError(error: unknown): ChannelConnectionError {
  if (error instanceof ChannelConnectionError) return error;
  if (error instanceof DiscordTransportError) {
    return new ChannelConnectionError({
      code: error.code === "credential_invalid"
        ? "credential_invalid"
        : error.code === "permission_denied"
          ? "permission_denied"
          : error.code === "rate_limited"
            ? "rate_limited"
            : "network_unreachable",
      detail: error.code,
    });
  }
  return new ChannelConnectionError({
    code: "network_unreachable",
    detail: "discord_connection_failed",
  });
}

async function delayWithSignal(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("discord_delay_aborted"),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export type {
  DiscordConfig,
};
