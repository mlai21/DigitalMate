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
  type WechatIlinkClientFactory,
  mapWechatError,
  WechatTransportError,
} from "./client";
import {
  parseWechatConfig,
  type WechatConfig,
} from "./config";
import {
  createWechatAttachmentFetcher,
  type WechatAttachmentFetcher,
} from "./media";
import {
  normalizeWechatInbound,
} from "./normalize";
import {
  createWechatLongPollTransport,
  type WechatTransportPort,
  type WechatTransportState,
} from "./transport";

export {
  parseWechatConfig,
  type WechatConfig,
} from "./config";
export {
  normalizeWechatInbound,
} from "./normalize";

export type WechatAdapterDependencies = Readonly<{
  clientFactory?: WechatIlinkClientFactory;
  attachmentFetcher?: WechatAttachmentFetcher;
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

export function createWechatAdapter(
  dependencies: WechatAdapterDependencies = {},
): ChannelAdapter<WechatConfig> {
  const manifest = getChannelManifest("wechat");
  const now = dependencies.now ?? (() => new Date());
  const attachmentFetcher =
    dependencies.attachmentFetcher
    ?? createWechatAttachmentFetcher();
  let config: WechatConfig | null = null;
  let transport: WechatTransportPort | null = null;
  let status:
    | "stopped"
    | "connecting"
    | "healthy"
    | "degraded"
    | "disconnected" = "stopped";
  let healthError:
    | Readonly<{
        code: ChannelHealthErrorCode;
        detail: string;
      }>
    | undefined;
  let lastConnectedAt: Date | undefined;
  let lastEventAt: Date | undefined;
  let nextAttemptAt: Date | undefined;
  let reconnectAttempts = 0;
  let retryExhausted = false;
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let lifecycleGeneration = 0;
  let detachParent: (() => void) | null = null;
  const contextTokens = new Map<string, string>();
  const typingTickets = new Map<string, {
    ticket: string;
    expiresAt: number;
  }>();
  const typingStates = new Map<string, {
    timer: ReturnType<typeof setInterval> | null;
    ticket: string;
  }>();

  const adapter: ChannelAdapter<WechatConfig> = {
    manifest,

    validateConfig(input) {
      const parsed = parseWechatConfig(input);
      config = parsed;
      return parsed;
    },

    start(context) {
      if (stopPromise) {
        return stopPromise.then(() =>
          adapter.start(context));
      }
      if (status === "healthy") return Promise.resolve();
      if (startPromise) return startPromise;
      const generation = lifecycleGeneration + 1;
      lifecycleGeneration = generation;
      startPromise = start(
        context,
        generation,
      ).finally(() => {
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
      const normalized = normalizeWechatInbound(
        payload,
        context,
        requireConfig(config),
      );
      const targetId =
        normalized?.replyHandle?.publicFields.targetId;
      const contextToken =
        normalized?.replyHandle?.secretFields.contextToken;
      if (targetId && contextToken) {
        contextTokens.set(targetId, contextToken);
      }
      return normalized;
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

    async send(delivery, sendContext) {
      sendContext.signal.throwIfAborted();
      const activeConfig = parseWechatConfig(
        sendContext.config,
      );
      const targetId = deliveryTarget(delivery);
      const contextToken =
        delivery.replyHandle?.secretFields.contextToken
        ?? contextTokens.get(targetId)
        ?? "";
      if (!contextToken) {
        throw new WechatTransportError({
          code: "runtime_prerequisite_missing",
          retryable: false,
          detail: "wechat_reply_handle_required",
        });
      }
      const body = `${activeConfig.bot_prefix}${
        delivery.body
      }`;
      if (!body.trim()) {
        throw new Error("wechat_delivery_body_empty");
      }
      const response = await requireTransport(
        transport,
      ).sendText({
        toUserId: targetId,
        text: body,
        contextToken,
        signal: sendContext.signal,
      });
      const ret = integer(response.ret);
      const errcode = integer(response.errcode);
      if (ret === -2) {
        if (contextTokens.get(targetId) === contextToken) {
          contextTokens.delete(targetId);
        }
        throw new WechatTransportError({
          code: "unknown",
          retryable: false,
          detail: "reply_handle_invalid",
        });
      }
      if (ret !== 0 || errcode !== 0) {
        throw new WechatTransportError({
          code: "unknown",
          retryable: false,
          detail: "wechat_send_rejected",
        });
      }
      return {
        externalMessageId: delivery.id,
        sentAt: sendContext.now(),
        rawSummary: {
          targetId,
          merged:
            activeConfig.message_merge_enabled,
          mergeDelayMs:
            activeConfig.message_merge_delay_ms,
        },
      } satisfies SendResult;
    },

    async typing(recipient, active) {
      const targetId = typingTarget(recipient);
      const activeTransport = requireTransport(transport);
      if (!active) {
        const state = typingStates.get(targetId);
        if (!state) return;
        typingStates.delete(targetId);
        if (state.timer) clearInterval(state.timer);
        await activeTransport.sendTyping({
          toUserId: targetId,
          typingTicket: state.ticket,
          status: 2,
        });
        return;
      }
      if (typingStates.has(targetId)) return;
      const contextToken = contextTokens.get(targetId);
      if (!contextToken) return;
      const ticket = await typingTicket(
        activeTransport,
        targetId,
        contextToken,
      );
      if (!ticket) return;
      const state = {
        timer: null as ReturnType<typeof setInterval> | null,
        ticket,
      };
      typingStates.set(targetId, state);
      await activeTransport.sendTyping({
        toUserId: targetId,
        typingTicket: ticket,
        status: 1,
      });
      if (typingStates.get(targetId) !== state) return;
      state.timer = setInterval(() => {
        if (
          typingStates.get(targetId) !== state
          || transport !== activeTransport
        ) {
          return;
        }
        void activeTransport.sendTyping({
          toUserId: targetId,
          typingTicket: ticket,
          status: 1,
        }).catch(() => undefined);
      }, 5_000);
      state.timer.unref?.();
    },

    async resolveRecipient(target) {
      const targetId = validIdentifier(
        target.externalUserId
        ?? target.externalConversationId,
      );
      if (!targetId) {
        throw new Error("wechat_recipient_invalid");
      }
      return {
        address: {
          targetId,
          chatType:
            target.chatType === "group"
              ? "group"
              : "direct",
        },
      };
    },
  };

  return adapter;

  async function start(
    context: Parameters<typeof adapter.start>[0],
    generation: number,
  ): Promise<void> {
    context.signal.throwIfAborted();
    const activeConfig = parseWechatConfig(context.config);
    config = activeConfig;
    if (!activeConfig.bot_token) {
      const error = new ChannelConnectionError({
        code: "credential_invalid",
        detail: "wechat_qrcode_login_required",
      });
      applyError(error);
      throw error;
    }
    if (
      dependencies.autoListen !== false
      && (
        !dependencies.acceptInbound
        || !dependencies.scope
      )
    ) {
      const error = new ChannelConnectionError({
        code: "runtime_prerequisite_missing",
        detail: "wechat_ingress_unavailable",
      });
      applyError(error);
      throw error;
    }
    status = "connecting";
    healthError = undefined;
    retryExhausted = false;
    const active = createWechatLongPollTransport(
      {
        botToken: activeConfig.bot_token,
        baseUrl: activeConfig.base_url,
      },
      {
        ...(dependencies.clientFactory
          ? {
              clientFactory:
                dependencies.clientFactory,
            }
          : {}),
        poll: dependencies.autoListen !== false,
        now,
      },
    );
    transport = active;
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
      await active.start({
        signal: context.signal,
        async onInbound(payload) {
          await dependencies.acceptInbound!(
            payload,
            {
              connectionId: context.connectionId,
              agentId: context.agentId,
              receivedAt: now(),
            },
            dependencies.scope!,
            attachmentFetcher,
          );
          lastEventAt = now();
        },
        onState: applyState,
        onError: applyError,
      });
      if (generation !== lifecycleGeneration) {
        throw new WechatTransportError({
          code: "network_unreachable",
          retryable: true,
          detail: "wechat_adapter_start_cancelled",
        });
      }
      status = "healthy";
      lastConnectedAt = now();
    } catch (error) {
      if (generation !== lifecycleGeneration) {
        await active.stop().catch(() => undefined);
        throw connectionError(error);
      }
      applyError(error);
      await stopTransport();
      throw connectionError(error);
    }
  }

  async function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    lifecycleGeneration += 1;
    stopPromise = (async () => {
      detachParent?.();
      detachParent = null;
      clearTyping();
      contextTokens.clear();
      typingTickets.clear();
      await stopTransport();
      status = "stopped";
      healthError = undefined;
      reconnectAttempts = 0;
      retryExhausted = false;
      nextAttemptAt = undefined;
    })().finally(() => {
      stopPromise = null;
    });
    return stopPromise;
  }

  async function stopTransport(): Promise<void> {
    const active = transport;
    transport = null;
    await active?.stop().catch(() => undefined);
  }

  function applyState(state: WechatTransportState): void {
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
    const mapped = mapWechatError(error);
    status = "degraded";
    healthError = {
      code: mapped.code,
      detail: mapped.detail,
    };
  }

  function clearTyping(): void {
    for (const state of typingStates.values()) {
      if (state.timer) clearInterval(state.timer);
    }
    typingStates.clear();
  }

  async function typingTicket(
    active: WechatTransportPort,
    targetId: string,
    contextToken: string,
  ): Promise<string> {
    const cached = typingTickets.get(targetId);
    if (cached && cached.expiresAt > now().getTime()) {
      return cached.ticket;
    }
    const response = await active.getConfig({
      ilinkUserId: targetId,
      contextToken,
    });
    if (
      integer(response.ret) !== 0
      || integer(response.errcode) !== 0
    ) {
      return "";
    }
    const ticket = validIdentifier(
      response.typing_ticket,
      16 * 1024,
    );
    if (ticket) {
      typingTickets.set(targetId, {
        ticket,
        expiresAt:
          now().getTime() + 24 * 60 * 60 * 1_000,
      });
    }
    return ticket;
  }
}

function deliveryTarget(
  delivery: Parameters<
    ChannelAdapter<WechatConfig>["send"]
  >[0],
): string {
  const targetId = validIdentifier(
    delivery.replyHandle?.publicFields.targetId
    ?? delivery.recipient.externalUserId
    ?? delivery.recipient.externalConversationId,
  );
  if (!targetId) {
    throw new Error("wechat_recipient_invalid");
  }
  return targetId;
}

function typingTarget(
  recipient: ResolvedRecipient,
): string {
  const targetId = validIdentifier(
    recipient.address.targetId,
  );
  if (!targetId) {
    throw new Error("wechat_recipient_invalid");
  }
  return targetId;
}

function requireConfig(
  value: WechatConfig | null,
): WechatConfig {
  if (!value) {
    throw new Error("wechat_config_not_validated");
  }
  return value;
}

function requireTransport(
  value: WechatTransportPort | null,
): WechatTransportPort {
  if (!value) {
    throw new Error("wechat_transport_not_started");
  }
  return value;
}

function validIdentifier(
  value: unknown,
  maxLength = 512,
): string {
  const normalized =
    typeof value === "string" ? value.trim() : "";
  return normalized.length > 0
    && normalized.length <= maxLength
    && !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : "";
}

function integer(value: unknown): number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    ? value
    : 0;
}

function connectionError(
  error: unknown,
): ChannelConnectionError {
  if (error instanceof ChannelConnectionError) {
    return error;
  }
  const mapped = mapWechatError(error);
  return new ChannelConnectionError({
    code: mapped.code,
    detail: mapped.detail,
  });
}
