import type { AgentScope } from "@/server/agents/types";
import { getChannelManifest } from "@/server/channels/manifests/catalog";
import type { ChannelAdapter } from "@/server/channels/runtime/adapter";
import {
  ChannelConnectionError,
} from "@/server/channels/runtime/connection-manager";
import type {
  ChannelReaction,
  InboundContext,
  IngressResult,
  SendResult,
} from "@/server/channels/runtime/types";

import {
  parseDingTalkConfig,
  type DingTalkConfig,
} from "./config";
import { normalizeDingTalkInbound } from "./normalize";
import {
  createDingTalkSdkClient,
  DingTalkTransportError,
  type DingTalkClientFactory,
  type DingTalkClientPort,
} from "./transport";

type DingTalkAcknowledge = () => Promise<void>;

// DingTalk renders text emotions as a short label, capped at four characters.
const REACTION_LABELS: Readonly<Record<ChannelReaction, string>> = {
  pending: "🤔思考中",
  acknowledged: "收到",
  good_question: "好问题",
  agreed: "赞同",
  done: "已完成",
};

export type DingTalkAdapterDependencies = Readonly<{
  clientFactory?: DingTalkClientFactory;
  scope?: AgentScope;
  acceptInbound?(
    payload: unknown,
    context: InboundContext,
    scope: AgentScope,
    acknowledge: DingTalkAcknowledge,
  ): Promise<IngressResult>;
  autoListen?: boolean;
  now?: () => Date;
}>;

export function createDingTalkAdapter(
  dependencies: DingTalkAdapterDependencies = {},
): ChannelAdapter<DingTalkConfig> {
  const manifest = getChannelManifest("dingtalk");
  const now = dependencies.now ?? (() => new Date());
  let config: DingTalkConfig | null = null;
  let client: DingTalkClientPort | null = null;
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

  const adapter: ChannelAdapter<DingTalkConfig> = {
    manifest,
    validateConfig(input) {
      config = parseDingTalkConfig(input);
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
      return normalizeDingTalkInbound(
        payload,
        context,
        requireConfig(config),
      );
    },
    async acknowledge() {
      return { status: 200, body: "{\"status\":\"SUCCESS\"}" };
    },
    async send(delivery, context) {
      context.signal.throwIfAborted();
      const activeConfig = parseDingTalkConfig(context.config);
      const route = deliveryRoute(delivery, activeConfig);
      const body = withBotPrefix(delivery.body, activeConfig.bot_prefix);
      if (deliveryMessageType(delivery, activeConfig) === "card") {
        const card = await withClient(
          activeConfig,
          (active) => active.createCard({
            ...cardRoute(route, activeConfig),
            text: body,
            signal: context.signal,
          }),
        );
        await withClient(
          activeConfig,
          (active) => active.updateCard({
            cardInstanceId: card.cardInstanceId,
            templateKey: activeConfig.card_template_key,
            text: body,
            final: true,
            signal: context.signal,
          }),
        );
        return sendResult(
          card.cardInstanceId,
          context.now(),
          true,
          card.cardInstanceId,
        );
      }

      const sessionWebhook = validSessionWebhook(
        delivery.replyHandle,
        context.now(),
      );
      if (sessionWebhook) {
        try {
          const sent = await withClient(
            activeConfig,
            (active) => active.sendSessionWebhook({
              sessionWebhook,
              payload: sessionPayload(
                body,
                route,
                activeConfig,
              ),
              signal: context.signal,
            }),
          );
          return sendResult(sent.messageId, context.now(), false);
        } catch (error) {
          if (!isDefinitiveSessionRejection(error)) throw error;
        }
      }
      const sent = await sendOpenApi(
        activeConfig,
        route,
        body,
        context.signal,
      );
      return sendResult(sent.messageId, context.now(), false);
    },
    async streaming(delivery, state) {
      const activeConfig = requireConfig(config);
      const signal = state.signal ?? new AbortController().signal;
      if (
        !activeConfig.streaming_enabled
        || deliveryMessageType(delivery, activeConfig) !== "card"
      ) {
        return adapter.send(delivery, {
          config: activeConfig,
          signal,
          now,
        });
      }
      const body = withBotPrefix(delivery.body, activeConfig.bot_prefix);
      if (!state.previousResult) {
        const route = deliveryRoute(delivery, activeConfig);
        const card = await withClient(
          activeConfig,
          (active) => active.createCard({
            ...cardRoute(route, activeConfig),
            text: body,
            signal,
          }),
        );
        if (state.final) {
          await withClient(
            activeConfig,
            (active) => active.updateCard({
              cardInstanceId: card.cardInstanceId,
              templateKey: activeConfig.card_template_key,
              text: body,
              final: true,
              signal,
            }),
          );
        }
        return sendResult(
          card.cardInstanceId,
          now(),
          state.final,
          card.cardInstanceId,
        );
      }
      const cardInstanceId = readCardInstanceId(
        state.previousResult.rawSummary,
      );
      if (!cardInstanceId) {
        throw new Error("dingtalk_card_instance_missing");
      }
      await withClient(
        activeConfig,
        (active) => active.updateCard({
          cardInstanceId,
          templateKey: activeConfig.card_template_key,
          text: body,
          final: state.final,
          signal,
        }),
      );
      return sendResult(
        cardInstanceId,
        now(),
        true,
        cardInstanceId,
      );
    },
    async reaction(input) {
      const activeConfig = requireConfig(config);
      if (!input.platformMessageId) return;
      await withClient(
        activeConfig,
        (active) => active.react({
          messageId: input.platformMessageId,
          conversationId: input.externalConversationId,
          robotCode: activeConfig.robot_code.trim()
            || activeConfig.client_id,
          text: REACTION_LABELS[input.reaction],
          active: input.active,
        }),
      );
    },
    async resolveRecipient(target) {
      return {
        address: {
          conversationId: target.externalConversationId,
          ...(target.externalUserId
            ? { senderStaffId: target.externalUserId }
            : {}),
        },
      };
    },
  };
  return adapter;

  async function start(
    context: Parameters<typeof adapter.start>[0],
  ) {
    const activeConfig = parseDingTalkConfig(context.config);
    config = activeConfig;
    if (
      dependencies.autoListen !== false
      && (!dependencies.acceptInbound || !dependencies.scope)
    ) {
      const error = new ChannelConnectionError({
        code: "runtime_prerequisite_missing",
        detail: "dingtalk_ingress_unavailable",
      });
      applyError(error);
      throw error;
    }
    const active = (
      dependencies.clientFactory ?? createDingTalkSdkClient
    )(activeConfig);
    client = active;
    const onAbort = () => void stop();
    context.signal.addEventListener("abort", onAbort, { once: true });
    detachParent = () =>
      context.signal.removeEventListener("abort", onAbort);
    try {
      await active.start({
        signal: context.signal,
        onEvent: async (payload, acknowledge) => {
          if (dependencies.autoListen !== false) {
            await dependencies.acceptInbound!(
              payload,
              {
                connectionId: context.connectionId,
                agentId: context.agentId,
                receivedAt: now(),
              },
              dependencies.scope!,
              acknowledge,
            );
          } else {
            await acknowledge();
          }
          lastEventAt = now();
        },
        onError: applyError,
        onReconnecting() {
          status = "degraded";
          reconnectAttempts += 1;
          healthError = {
            code: "network_unreachable",
            detail: "network_unreachable",
          };
        },
        onReconnected() {
          status = "healthy";
          reconnectAttempts = 0;
          healthError = undefined;
          lastConnectedAt = now();
        },
      });
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
    activeConfig: DingTalkConfig,
    action: (active: DingTalkClientPort) => Promise<T>,
  ) {
    if (client) return action(client);
    const transient = (
      dependencies.clientFactory ?? createDingTalkSdkClient
    )(activeConfig);
    try {
      return await action(transient);
    } finally {
      await transient.stop().catch(() => undefined);
    }
  }

  async function sendOpenApi(
    activeConfig: DingTalkConfig,
    route: ReturnType<typeof deliveryRoute>,
    body: string,
    signal: AbortSignal,
  ) {
    return withClient(
      activeConfig,
      (active) => active.sendOpenApi({
        conversationId: route.conversationId,
        chatType: route.chatType,
        senderStaffId: route.senderStaffId,
        robotCode: requireRouteValue(
          route.robotCode,
          "dingtalk_robot_code_missing",
        ),
        text: body,
        format: body.length > 3_500 ? "text" : "markdown",
        signal,
      }),
    );
  }

  function applyError(error: unknown) {
    status = "degraded";
    reconnectAttempts += 1;
    const code = error instanceof DingTalkTransportError
      ? error.code === "response_invalid" ? "unknown" : error.code
      : error instanceof ChannelConnectionError
        ? error.code
        : "network_unreachable";
    const detail = error instanceof DingTalkTransportError
      ? error.detail
      : code;
    healthError = { code, detail };
  }
}

function deliveryRoute(
  delivery: Parameters<ChannelAdapter<DingTalkConfig>["send"]>[0],
  config: DingTalkConfig,
) {
  const fields = delivery.replyHandle?.publicFields;
  const conversationId = fields?.conversationId
    ?? delivery.recipient.externalConversationId;
  const senderStaffId = fields?.senderStaffId
    ?? delivery.recipient.externalUserId
    ?? "";
  const chatType = fields?.conversationType === "direct"
    ? "direct"
    : fields?.conversationType === "group"
      ? "group"
      : delivery.recipient.chatType
        ? delivery.recipient.chatType
        : delivery.recipient.externalUserId
          ? "direct"
          : "group";
  return {
    conversationId,
    senderStaffId,
    chatType,
    robotCode: fields?.robotCode ?? config.robot_code,
  } as const;
}

function cardRoute(
  route: ReturnType<typeof deliveryRoute>,
  config: DingTalkConfig,
) {
  return {
    conversationId: route.conversationId,
    chatType: route.chatType,
    senderStaffId: requireRouteValue(
      route.senderStaffId,
      "dingtalk_sender_staff_id_missing",
    ),
    robotCode: requireRouteValue(
      route.robotCode,
      "dingtalk_robot_code_missing",
    ),
    templateId: config.card_template_id,
    templateKey: config.card_template_key,
    autoLayout: config.card_auto_layout,
    atSender: config.at_sender_on_reply,
  };
}

function deliveryMessageType(
  delivery: Parameters<ChannelAdapter<DingTalkConfig>["send"]>[0],
  config: DingTalkConfig,
) {
  return delivery.eventId === null
    ? config.cron_message_type
    : config.message_type;
}

function sessionPayload(
  body: string,
  route: ReturnType<typeof deliveryRoute>,
  config: DingTalkConfig,
): Readonly<Record<string, unknown>> {
  const atSender = config.at_sender_on_reply
    && route.chatType === "group"
    && route.senderStaffId;
  const text = atSender
    ? `@${route.senderStaffId}\n${body}`
    : body;
  if (text.length > 3_500) {
    return {
      msgtype: "text",
      text: { content: text },
      ...(atSender
        ? { at: { atUserIds: [route.senderStaffId] } }
        : {}),
    };
  }
  return {
    msgtype: "markdown",
    markdown: {
      title: messageTitle(body),
      text,
    },
    ...(atSender
      ? { at: { atUserIds: [route.senderStaffId] } }
      : {}),
  };
}

function validSessionWebhook(
  handle: Parameters<ChannelAdapter<DingTalkConfig>["send"]>[0][
    "replyHandle"
  ],
  now: Date,
): string | null {
  if (!handle) return null;
  if (handle.expiresAt && handle.expiresAt <= now) return null;
  const value = handle.secretFields.sessionWebhook;
  return typeof value === "string" && value.length > 0
    ? value
    : null;
}

function isDefinitiveSessionRejection(error: unknown): boolean {
  return error instanceof DingTalkTransportError
    && !error.retryable;
}

function sendResult(
  id: string,
  sentAt: Date,
  edited: boolean,
  cardInstanceId?: string,
): SendResult {
  return {
    externalMessageId: id,
    sentAt,
    rawSummary: {
      ok: true,
      edited,
      ...(cardInstanceId ? { cardInstanceId } : {}),
    },
  };
}

function readCardInstanceId(
  summary: SendResult["rawSummary"],
): string | null {
  const value = summary.cardInstanceId;
  return typeof value === "string"
    && value.length > 0
    && value.length <= 1_024
    ? value
    : null;
}

function withBotPrefix(body: string, value: unknown) {
  const prefix = typeof value === "string" ? value : "";
  return `${prefix}${body}`;
}

function messageTitle(text: string) {
  return text.trim().split(/\s+/u).join(" ").slice(0, 20)
    || "DigitalMate";
}

function requireRouteValue(value: string, code: string) {
  if (!value) throw new Error(code);
  return value;
}

function requireConfig(value: DingTalkConfig | null) {
  if (!value) throw new Error("dingtalk_config_unavailable");
  return value;
}

function connectionError(error: unknown) {
  if (error instanceof ChannelConnectionError) return error;
  const code = error instanceof DingTalkTransportError
    ? error.code === "credential_invalid" ? "credential_invalid"
      : error.code === "permission_denied" ? "permission_denied"
        : error.code === "rate_limited" ? "rate_limited"
          : "network_unreachable"
    : "network_unreachable";
  return new ChannelConnectionError({
    code,
    detail: error instanceof DingTalkTransportError
      ? error.detail
      : code,
  });
}

export type { DingTalkConfig };
