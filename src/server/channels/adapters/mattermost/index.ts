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
  parseMattermostConfig,
  type MattermostConfig,
} from "./config";
import {
  mattermostSequence,
  normalizeMattermostInbound,
} from "./normalize";
import {
  createMattermostClient,
  MattermostTransportError,
  type MattermostClientFactory,
  type MattermostClientPort,
} from "./transport";

export type MattermostAdapterDependencies = Readonly<{
  clientFactory?: MattermostClientFactory;
  scope?: AgentScope;
  acceptInbound?(
    payload: unknown,
    context: InboundContext,
    scope: AgentScope,
  ): Promise<IngressResult>;
  autoListen?: boolean;
  now?: () => Date;
}>;

export function createMattermostAdapter(
  dependencies: MattermostAdapterDependencies = {},
): ChannelAdapter<MattermostConfig> {
  const manifest = getChannelManifest("mattermost");
  const now = dependencies.now ?? (() => new Date());
  let config: MattermostConfig | null = null;
  let client: MattermostClientPort | null = null;
  let botUserId: string | null = null;
  let botUsername: string | null = null;
  let lastSequence = -1;
  const followedThreadIds = new Set<string>();
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

  const adapter: ChannelAdapter<MattermostConfig> = {
    manifest,

    validateConfig(input) {
      const parsed = parseMattermostConfig(input);
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
      return normalizeMattermostInbound(payload, context, {
        botUserId,
        botUsername,
        threadFollowWithoutMention:
          config?.thread_follow_without_mention === true,
        followedThreadIds,
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
          activeClient.post({
            channelId: address.channelId,
            message: delivery.body,
            ...(address.rootId
              ? { rootId: address.rootId }
              : {}),
          }),
      );
      if (address.rootId) {
        followedThreadIds.add(address.rootId);
      }
      return sendResult(result.postId, context.now());
    },

    async typing(recipient, active) {
      if (!active || config?.show_typing === false) return;
      if (!botUserId) {
        throw new Error("mattermost_bot_user_unavailable");
      }
      const channelId = recipient.address.channelId
        ?? recipient.address.conversationId;
      if (!channelId) {
        throw new Error("mattermost_recipient_invalid");
      }
      await requireClient(client).sendTyping({
        userId: botUserId,
        channelId,
        ...(recipient.address.rootId
          ? { parentId: recipient.address.rootId }
          : {}),
      });
    },

    async resolveRecipient(target) {
      return {
        address: {
          channelId: target.externalConversationId,
          conversationId: target.externalConversationId,
          ...(target.externalThreadId
            ? { rootId: target.externalThreadId }
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
    const activeConfig =
      parseMattermostConfig(context.config);
    config = activeConfig;
    if (
      dependencies.autoListen !== false
      && (!dependencies.acceptInbound || !dependencies.scope)
    ) {
      const error = new ChannelConnectionError({
        code: "runtime_prerequisite_missing",
        detail: "mattermost_ingress_unavailable",
      });
      applyError(error);
      throw error;
    }
    const activeClient = (
      dependencies.clientFactory ?? createMattermostClient
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
        signal: context.signal,
        onEvent: async (payload) => {
          const sequence = mattermostSequence(payload);
          if (sequence !== null && sequence <= lastSequence) {
            return;
          }
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
          if (sequence !== null) lastSequence = sequence;
          lastEventAt = now();
        },
        onError(error) {
          applyError(error);
        },
      });
      botUserId = ready.botUserId;
      botUsername = ready.botUsername;
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
      botUsername = null;
      lastSequence = -1;
      followedThreadIds.clear();
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

  async function withClient<T>(
    activeConfig: MattermostConfig,
    action: (activeClient: MattermostClientPort) => Promise<T>,
  ): Promise<T> {
    if (client) return action(client);
    const transient = (
      dependencies.clientFactory ?? createMattermostClient
    )(activeConfig);
    try {
      return await action(transient);
    } finally {
      await transient.stop().catch(() => undefined);
    }
  }

  function applyError(error: unknown): void {
    status = "degraded";
    reconnectAttempts += 1;
    const code = error instanceof MattermostTransportError
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
}

function deliveryAddress(
  delivery: Parameters<
    ChannelAdapter<MattermostConfig>["send"]
  >[0],
): Readonly<{
  channelId: string;
  rootId?: string;
}> {
  const publicFields = delivery.replyHandle?.publicFields;
  const channelId = publicFields?.channelId
    ?? delivery.recipient.externalConversationId;
  if (!channelId) {
    throw new Error("mattermost_channel_missing");
  }
  const rootId = publicFields?.rootId
    ?? delivery.recipient.externalThreadId;
  return {
    channelId,
    ...(rootId ? { rootId } : {}),
  };
}

function sendResult(
  postId: string,
  sentAt: Date,
): SendResult {
  return {
    externalMessageId: postId,
    sentAt,
    rawSummary: { ok: true },
  };
}

function requireClient(
  value: MattermostClientPort | null,
): MattermostClientPort {
  if (!value) {
    throw new Error("mattermost_client_unavailable");
  }
  return value;
}

function connectionError(error: unknown): ChannelConnectionError {
  if (error instanceof ChannelConnectionError) return error;
  if (error instanceof MattermostTransportError) {
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
    detail: "mattermost_connection_failed",
  });
}

export type {
  MattermostConfig,
};
