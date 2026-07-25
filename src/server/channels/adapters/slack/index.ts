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
  parseSlackConfig,
  type SlackConfig,
} from "./config";
import {
  normalizeSlackInbound,
} from "./normalize";
import {
  createSlackBoltClient,
  SlackTransportError,
  type SlackClientFactory,
  type SlackClientPort,
} from "./transport";

export type SlackAdapterDependencies = Readonly<{
  clientFactory?: SlackClientFactory;
  scope?: AgentScope;
  acceptInbound?(
    payload: unknown,
    context: InboundContext,
    scope: AgentScope,
    acknowledge: () => Promise<void>,
  ): Promise<IngressResult>;
  autoListen?: boolean;
  now?: () => Date;
}>;

export function createSlackAdapter(
  dependencies: SlackAdapterDependencies = {},
): ChannelAdapter<SlackConfig> {
  const manifest = getChannelManifest("slack");
  const now = dependencies.now ?? (() => new Date());
  let config: SlackConfig | null = null;
  let client: SlackClientPort | null = null;
  let botUserId: string | null = null;
  let botId: string | null = null;
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

  const adapter: ChannelAdapter<SlackConfig> = {
    manifest,

    validateConfig(input) {
      const parsed = parseSlackConfig(input);
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
      return normalizeSlackInbound(payload, context, {
        botUserId,
        botId,
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
          activeClient.postMessage({
            channel: address.channel,
            text: delivery.body,
            ...(address.threadTs
              ? { threadTs: address.threadTs }
              : {}),
          }),
      );
      return sendResult(result.ts, context.now(), false);
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
      signal.throwIfAborted();
      const address = deliveryAddress(delivery);
      const ts = state.previousResult.externalMessageId;
      await withClient(activeConfig, (activeClient) =>
        activeClient.updateMessage({
          channel: address.channel,
          ts,
          text: delivery.body,
        })
      );
      return sendResult(ts, now(), true);
    },

    async resolveRecipient(target) {
      return {
        address: {
          channel: target.externalConversationId,
          conversationId: target.externalConversationId,
          ...(target.externalThreadId
            ? { threadTs: target.externalThreadId }
            : {}),
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
    const activeConfig = parseSlackConfig(context.config);
    config = activeConfig;
    if (
      dependencies.autoListen !== false
      && (!dependencies.acceptInbound || !dependencies.scope)
    ) {
      const error = new ChannelConnectionError({
        code: "runtime_prerequisite_missing",
        detail: "slack_ingress_unavailable",
      });
      applyError(error);
      throw error;
    }

    const activeClient = (
      dependencies.clientFactory ?? createSlackBoltClient
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
        onEnvelope: async (payload, ack) => {
          if (dependencies.autoListen !== false) {
            await dependencies.acceptInbound!(
              payload,
              {
                connectionId: context.connectionId,
                agentId: context.agentId,
                receivedAt: now(),
              },
              dependencies.scope!,
              ack,
            );
          } else {
            await ack();
          }
          lastEventAt = now();
        },
        onError(error) {
          applyError(error);
        },
      });
      botUserId = ready.botUserId;
      botId = ready.botId;
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
      botId = null;
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
    activeConfig: SlackConfig,
    action: (activeClient: SlackClientPort) => Promise<T>,
  ): Promise<T> {
    if (client) return action(client);
    const transient = (
      dependencies.clientFactory ?? createSlackBoltClient
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
    const code = error instanceof SlackTransportError
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
    ChannelAdapter<SlackConfig>["send"]
  >[0],
): Readonly<{
  channel: string;
  threadTs?: string;
}> {
  const publicFields = delivery.replyHandle?.publicFields;
  const channel = publicFields?.channel
    ?? delivery.recipient.externalConversationId;
  if (!channel) throw new Error("slack_channel_missing");
  const threadTs = publicFields?.threadTs
    ?? delivery.recipient.externalThreadId;
  return {
    channel,
    ...(threadTs ? { threadTs } : {}),
  };
}

function sendResult(
  ts: string,
  sentAt: Date,
  edited: boolean,
): SendResult {
  return {
    externalMessageId: ts,
    sentAt,
    rawSummary: { ok: true, edited },
  };
}

function requireConfig(
  value: SlackConfig | null,
): SlackConfig {
  if (!value) throw new Error("slack_config_unavailable");
  return value;
}

function connectionError(error: unknown): ChannelConnectionError {
  if (error instanceof ChannelConnectionError) return error;
  if (error instanceof SlackTransportError) {
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
    detail: "slack_connection_failed",
  });
}

export type {
  SlackConfig,
};
