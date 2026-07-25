import { createHash } from "node:crypto";

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
  NormalizedChannelEvent,
  SendResult,
} from "@/server/channels/runtime/types";

import {
  parseWeComConfig,
  type WeComConfig,
} from "./config";
import {
  normalizeWeComInbound,
  normalizeWeComWelcome,
} from "./normalize";
import {
  createWeComAttachmentFetcher,
} from "./media";
import type {
  InboundAttachmentFetcher,
} from "@/server/channels/runtime/attachment-ingress";
import {
  createWeComSdkClient,
  mapWeComError,
  WeComTransportError,
  type WeComClientFactory,
  type WeComClientPort,
} from "./transport";

export type WeComAdapterDependencies = Readonly<{
  clientFactory?: WeComClientFactory;
  scope?: AgentScope;
  acceptInbound?(
    payload: unknown,
    context: InboundContext,
    scope: AgentScope,
    attachmentFetcher: InboundAttachmentFetcher,
  ): Promise<IngressResult>;
  acceptWelcome?(
    event: NormalizedChannelEvent,
    scope: AgentScope,
  ): Promise<boolean>;
  autoListen?: boolean;
  now?: () => Date;
}>;

export function createWeComAdapter(
  dependencies: WeComAdapterDependencies = {},
): ChannelAdapter<WeComConfig> {
  const manifest = getChannelManifest("wecom");
  const now = dependencies.now ?? (() => new Date());
  let config: WeComConfig | null = null;
  let client: WeComClientPort | null = null;
  let status:
    | "stopped"
    | "connecting"
    | "healthy"
    | "degraded" = "stopped";
  let lastConnectedAt: Date | undefined;
  let lastEventAt: Date | undefined;
  let nextAttemptAt: Date | undefined;
  let reconnectAttempts = 0;
  let healthError:
    | Readonly<{
        code: ChannelHealthErrorCode;
        detail: string;
      }>
    | undefined;
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let detachParent: (() => void) | null = null;

  const adapter: ChannelAdapter<WeComConfig> = {
    manifest,

    validateConfig(input) {
      const parsed = parseWeComConfig(input);
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
        ...(nextAttemptAt ? { nextAttemptAt } : {}),
        ...(healthError ? { error: healthError } : {}),
      };
    },

    async normalizeInbound(payload, context) {
      return normalizeWeComInbound(
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
      const activeConfig = parseWeComConfig(context.config);
      const body = prefixedBody(
        delivery.body,
        activeConfig.bot_prefix,
      );
      const requestId = replyRequestId(delivery.replyHandle);
      if (requestId) {
        const streamId = deliveryStreamId(delivery.id);
        const sent = await requireClient(client).replyStream({
          requestId,
          streamId,
          content: body,
          finish: true,
          nonBlocking: false,
        });
        return streamResult(
          sent.messageId,
          streamId,
          context.now(),
          true,
          sent.skipped,
        );
      }
      const chatId = deliveryChatId(delivery);
      const sent = await requireClient(client).sendMarkdown({
        chatId,
        content: body,
      });
      return {
        externalMessageId: sent.messageId,
        sentAt: context.now(),
        rawSummary: {
          mode: "proactive",
          chatId,
        },
      };
    },

    async streaming(delivery, state) {
      const activeConfig = requireConfig(config);
      const signal =
        state.signal ?? new AbortController().signal;
      if (!activeConfig.streaming_enabled) {
        return adapter.send(delivery, {
          config: activeConfig,
          signal,
          now,
        });
      }
      signal.throwIfAborted();
      const requestId = replyRequestId(delivery.replyHandle);
      if (!requestId) {
        return adapter.send(delivery, {
          config: activeConfig,
          signal,
          now,
        });
      }
      const streamId = previousStreamId(state.previousResult)
        ?? deliveryStreamId(delivery.id);
      const sent = await requireClient(client).replyStream({
        requestId,
        streamId,
        content: prefixedBody(
          delivery.body,
          activeConfig.bot_prefix,
        ),
        finish: state.final,
        nonBlocking: !state.final,
      });
      return streamResult(
        state.previousResult?.externalMessageId
          ?? sent.messageId,
        streamId,
        now(),
        state.final,
        sent.skipped,
      );
    },

    async resolveRecipient(target) {
      const chatId = validIdentifier(
        target.externalConversationId,
      );
      if (!chatId) {
        throw new Error("wecom_chat_id_invalid");
      }
      return {
        address: {
          chatId,
          conversationId: chatId,
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
  ): Promise<void> {
    context.signal.throwIfAborted();
    const activeConfig = parseWeComConfig(context.config);
    config = activeConfig;
    if (
      dependencies.autoListen !== false
      && (!dependencies.acceptInbound || !dependencies.scope)
    ) {
      const error = new ChannelConnectionError({
        code: "runtime_prerequisite_missing",
        detail: "wecom_ingress_unavailable",
      });
      applyError(error);
      throw error;
    }

    status = "connecting";
    const activeClient = (
      dependencies.clientFactory ?? createWeComSdkClient
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
        onMessage: async (payload) => {
          if (dependencies.autoListen !== false) {
            await dependencies.acceptInbound!(
              payload,
              {
                connectionId: context.connectionId,
                agentId: context.agentId,
                receivedAt: now(),
              },
              dependencies.scope!,
              createWeComAttachmentFetcher(activeClient),
            );
          }
          lastEventAt = now();
        },
        onWelcome: async (payload) => {
          const welcome = normalizeWeComWelcome(
            payload,
            {
              connectionId: context.connectionId,
              agentId: context.agentId,
              receivedAt: now(),
            },
            activeConfig.bot_id,
            activeConfig.share_session_in_group,
          );
          if (!welcome || !activeConfig.welcome_text) return;
          if (
            dependencies.autoListen !== false
            && (
              !dependencies.acceptWelcome
              || !await dependencies.acceptWelcome(
                welcome.event,
                dependencies.scope!,
              )
            )
          ) {
            return;
          }
          await activeClient.replyWelcome({
            requestId: welcome.requestId,
            content: activeConfig.welcome_text,
          });
          lastEventAt = now();
        },
        onAuthenticated() {
          status = "healthy";
          lastConnectedAt = now();
          nextAttemptAt = undefined;
          reconnectAttempts = 0;
          healthError = undefined;
        },
        onDisconnected() {
          applyError(new WeComTransportError({
            code: "network_unreachable",
            detail: "wecom_disconnected",
            retryable: true,
          }));
        },
        onReconnecting(attempt) {
          status = "connecting";
          reconnectAttempts = attempt;
        },
        onError(error) {
          applyError(error);
        },
      });
      status = "healthy";
      lastConnectedAt = now();
      nextAttemptAt = undefined;
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
      status = "stopped";
      reconnectAttempts = 0;
      nextAttemptAt = undefined;
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

  function applyError(error: unknown): void {
    status = "degraded";
    reconnectAttempts += 1;
    const mapped = error instanceof ChannelConnectionError
      ? error
      : mapWeComError(error);
    healthError = {
      code: mapped.code,
      detail: mapped.detail,
    };
    if (
      mapped instanceof WeComTransportError
      && mapped.retryAfterMs
    ) {
      nextAttemptAt = new Date(
        now().getTime() + mapped.retryAfterMs,
      );
    }
  }
}

function replyRequestId(
  handle: Parameters<
    ChannelAdapter<WeComConfig>["send"]
  >[0]["replyHandle"],
): string | null {
  return validIdentifier(handle?.secretFields.requestId);
}

function deliveryChatId(
  delivery: Parameters<
    ChannelAdapter<WeComConfig>["send"]
  >[0],
): string {
  const handleChatId = validIdentifier(
    delivery.replyHandle?.publicFields.chatId,
  );
  const recipientChatId = validIdentifier(
    delivery.recipient.externalConversationId,
  );
  const chatId = handleChatId ?? recipientChatId;
  if (!chatId) throw new Error("wecom_chat_id_invalid");
  return chatId;
}

function deliveryStreamId(deliveryId: string): string {
  return `dm-${createHash("sha256")
    .update(deliveryId)
    .digest("hex")
    .slice(0, 32)}`;
}

function previousStreamId(
  result: SendResult | null | undefined,
): string | null {
  return validIdentifier(result?.rawSummary.streamId);
}

function streamResult(
  externalMessageId: string,
  streamId: string,
  sentAt: Date,
  final: boolean,
  skipped: boolean,
): SendResult {
  return {
    externalMessageId,
    sentAt,
    rawSummary: {
      mode: "ws-stream",
      streamId,
      final,
      skipped,
    },
  };
}

function prefixedBody(body: string, prefix: string): string {
  const text = body.trim();
  if (!text) throw new Error("wecom_message_empty");
  return prefix ? `${prefix}${text}` : text;
}

function validIdentifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized
    && normalized.length <= 1_024
    && !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : null;
}

function requireClient(
  client: WeComClientPort | null,
): WeComClientPort {
  if (!client) throw new Error("wecom_client_not_started");
  return client;
}

function requireConfig(
  config: WeComConfig | null,
): WeComConfig {
  if (!config) throw new Error("wecom_config_not_validated");
  return config;
}

function connectionError(error: unknown): Error {
  if (error instanceof ChannelConnectionError) return error;
  return mapWeComError(error);
}

export {
  parseWeComConfig,
  type WeComConfig,
} from "./config";
