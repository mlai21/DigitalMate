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

import { parseFeishuConfig, type FeishuConfig } from "./config";
import { normalizeFeishuInbound } from "./normalize";
import {
  createFeishuSdkClient,
  FeishuTransportError,
  type FeishuClientFactory,
  type FeishuClientPort,
} from "./transport";

export type FeishuAdapterDependencies = Readonly<{
  clientFactory?: FeishuClientFactory;
  scope?: AgentScope;
  acceptInbound?(
    payload: unknown,
    context: InboundContext,
    scope: AgentScope,
  ): Promise<IngressResult>;
  autoListen?: boolean;
  now?: () => Date;
}>;

export function createFeishuAdapter(
  dependencies: FeishuAdapterDependencies = {},
): ChannelAdapter<FeishuConfig> {
  const manifest = getChannelManifest("feishu");
  const now = dependencies.now ?? (() => new Date());
  let config: FeishuConfig | null = null;
  let client: FeishuClientPort | null = null;
  let botOpenId: string | null = null;
  let status: "stopped" | "healthy" | "degraded" = "stopped";
  let lastConnectedAt: Date | undefined;
  let lastEventAt: Date | undefined;
  let reconnectAttempts = 0;
  let healthError: {
    code: "credential_invalid" | "permission_denied"
      | "polling_conflict" | "network_unreachable"
      | "rate_limited" | "runtime_prerequisite_missing" | "unknown";
    detail: string;
  } | undefined;
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let detachParent: (() => void) | null = null;

  const adapter: ChannelAdapter<FeishuConfig> = {
    manifest,
    validateConfig(input) {
      config = parseFeishuConfig(input);
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
        ...(lastConnectedAt ? { lastConnectedAt } : {}),
        ...(lastEventAt ? { lastEventAt } : {}),
        ...(healthError ? { error: healthError } : {}),
      };
    },
    async normalizeInbound(payload, context) {
      return normalizeFeishuInbound(payload, context, {
        botOpenId,
        shareSessionInGroup:
          config?.share_session_in_group === true,
      });
    },
    async acknowledge() {
      return { status: 200, body: "{\"code\":0}" };
    },
    async send(delivery, context) {
      const address = deliveryAddress(delivery);
      const result = await withClient(
        context.config,
        (active) => active.send({
          chatId: address.chatId,
          ...(address.messageId
            ? { replyToMessageId: address.messageId }
            : {}),
          text: delivery.body,
          streaming: context.config.streaming_enabled,
        }),
      );
      return sendResult(
        result.messageId,
        context.now(),
        false,
        result.cardId,
      );
    },
    async streaming(delivery, state) {
      const activeConfig = requireConfig(config);
      const signal = state.signal ?? new AbortController().signal;
      if (!activeConfig.streaming_enabled || !state.previousResult) {
        const first = await adapter.send(delivery, {
          config: activeConfig,
          signal,
          now,
        });
        const firstCardId = readCardId(first.rawSummary);
        if (
          activeConfig.streaming_enabled
          && state.final
          && firstCardId
        ) {
          await withClient(activeConfig, (active) =>
            active.updateCard({
              messageId: first.externalMessageId,
              cardId: firstCardId,
              text: delivery.body,
              sequence: state.sequence,
              final: true,
            })
          );
          return sendResult(
            first.externalMessageId,
            now(),
            true,
            firstCardId,
          );
        }
        return first;
      }
      const id = state.previousResult.externalMessageId;
      const cardId = readCardId(
        state.previousResult.rawSummary,
      );
      await withClient(activeConfig, (active) =>
        active.updateCard({
          messageId: id,
          ...(cardId ? { cardId } : {}),
          text: delivery.body,
          sequence: state.sequence,
          final: state.final,
        })
      );
      return sendResult(id, now(), true);
    },
    async resolveRecipient(target) {
      return {
        address: {
          chatId: target.externalConversationId.split(":")[0]!,
          conversationId: target.externalConversationId,
        },
      };
    },
  };
  return adapter;

  async function start(
    context: Parameters<typeof adapter.start>[0],
  ) {
    const activeConfig = parseFeishuConfig(context.config);
    config = activeConfig;
    if (
      dependencies.autoListen !== false
      && (!dependencies.acceptInbound || !dependencies.scope)
    ) {
      const error = new ChannelConnectionError({
        code: "runtime_prerequisite_missing",
        detail: "feishu_ingress_unavailable",
      });
      applyError(error);
      throw error;
    }
    const active = (
      dependencies.clientFactory ?? createFeishuSdkClient
    )(activeConfig);
    client = active;
    const onAbort = () => void stop();
    context.signal.addEventListener("abort", onAbort, { once: true });
    detachParent = () =>
      context.signal.removeEventListener("abort", onAbort);
    try {
      const ready = await active.start({
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
        onError: applyError,
      });
      botOpenId = ready.botOpenId;
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

  async function stop() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      detachParent?.();
      detachParent = null;
      botOpenId = null;
      status = "stopped";
      healthError = undefined;
      reconnectAttempts = 0;
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
    activeConfig: FeishuConfig,
    action: (active: FeishuClientPort) => Promise<T>,
  ) {
    if (client) return action(client);
    const transient = (
      dependencies.clientFactory ?? createFeishuSdkClient
    )(activeConfig);
    try {
      return await action(transient);
    } finally {
      await transient.stop().catch(() => undefined);
    }
  }
  function applyError(error: unknown) {
    status = "degraded";
    reconnectAttempts += 1;
    const code = error instanceof FeishuTransportError
      ? error.code === "response_invalid" ? "unknown" : error.code
      : error instanceof ChannelConnectionError
        ? error.code
        : "network_unreachable";
    healthError = { code, detail: code };
  }
}

function deliveryAddress(
  delivery: Parameters<ChannelAdapter<FeishuConfig>["send"]>[0],
) {
  const fields = delivery.replyHandle?.publicFields;
  const chatId = fields?.chatId
    ?? delivery.recipient.externalConversationId.split(":")[0];
  if (!chatId) throw new Error("feishu_chat_id_missing");
  return { chatId, messageId: fields?.messageId };
}
function sendResult(
  id: string,
  sentAt: Date,
  edited: boolean,
  cardId?: string,
): SendResult {
  return {
    externalMessageId: id,
    sentAt,
    rawSummary: {
      ok: true,
      edited,
      ...(cardId ? { cardId } : {}),
    },
  };
}
function readCardId(
  summary: SendResult["rawSummary"],
): string | undefined {
  const value = summary.cardId;
  return typeof value === "string"
    && value.length > 0
    && value.length <= 1_024
    ? value
    : undefined;
}
function requireConfig(value: FeishuConfig | null) {
  if (!value) throw new Error("feishu_config_unavailable");
  return value;
}
function connectionError(error: unknown) {
  if (error instanceof ChannelConnectionError) return error;
  const code = error instanceof FeishuTransportError
    ? error.code === "credential_invalid" ? "credential_invalid"
      : error.code === "permission_denied" ? "permission_denied"
        : error.code === "rate_limited" ? "rate_limited"
          : "network_unreachable"
    : "network_unreachable";
  return new ChannelConnectionError({
    code,
    detail: code,
  });
}

export type { FeishuConfig };
