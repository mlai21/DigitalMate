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
} from "@/server/channels/runtime/types";

import {
  parseTelegramConfig,
  type TelegramConfig,
} from "./config";
import {
  normalizeTelegramInbound,
} from "./normalize";
import {
  createTelegramTransport,
  TelegramTransportError,
  type TelegramHttpClient,
} from "./transport";

export type TelegramAdapterDependencies = Readonly<{
  http?: TelegramHttpClient;
  scope?: AgentScope;
  acceptInbound?(
    payload: unknown,
    context: InboundContext,
    scope: AgentScope,
  ): Promise<IngressResult>;
  loadLastUpdateId?(
    connectionId: string,
    scope: AgentScope,
  ): Promise<number | null>;
  delay?(
    milliseconds: number,
    signal: AbortSignal,
  ): Promise<void>;
  autoPoll?: boolean;
  now?: () => Date;
}>;

export function createTelegramAdapter(
  dependencies: TelegramAdapterDependencies = {},
): ChannelAdapter<TelegramConfig> {
  const manifest = getChannelManifest("telegram");
  const now = dependencies.now ?? (() => new Date());
  const transport = createTelegramTransport({
    ...(dependencies.http ? { http: dependencies.http } : {}),
    now,
  });
  let config: TelegramConfig | null = null;
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
  let controller: AbortController | null = null;
  let detachParent: (() => void) | null = null;
  let pollTask: Promise<void> | null = null;
  let startPromise: Promise<void> | null = null;

  const adapter: ChannelAdapter<TelegramConfig> = {
    manifest,

    validateConfig(input) {
      const parsed = parseTelegramConfig(input);
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
      controller?.abort(new Error("telegram_adapter_stopped"));
      detachParent?.();
      detachParent = null;
      await pollTask?.catch(() => undefined);
      pollTask = null;
      controller = null;
      status = "stopped";
      healthError = undefined;
      reconnectAttempts = 0;
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
      return normalizeTelegramInbound(payload, context);
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

    send(delivery, context) {
      return transport.send(delivery, context);
    },

    async typing(recipient, active) {
      if (!active || config?.show_typing === false) return;
      const activeConfig = requireConfig(config);
      const chatId = recipient.address.chatId
        ?? recipient.address.conversationId;
      if (!chatId) {
        throw new Error("telegram_recipient_invalid");
      }
      await transport.typing(
        activeConfig,
        chatId,
        recipient.address.messageThreadId
          ?? recipient.address.threadId,
        new AbortController().signal,
      );
    },

    async streaming(delivery, state) {
      const activeConfig = requireConfig(config);
      const signal =
        state.signal ?? new AbortController().signal;
      if (
        !activeConfig.streaming_enabled
        || !state.previousResult
      ) {
        return transport.send(delivery, {
          config: activeConfig,
          signal,
          now,
        });
      }
      return transport.edit(
        delivery,
        activeConfig,
        state.previousResult.externalMessageId,
        signal,
      );
    },

    async resolveRecipient(target) {
      return {
        address: {
          chatId: target.externalConversationId,
          conversationId: target.externalConversationId,
          ...(target.externalThreadId
            ? {
                messageThreadId: target.externalThreadId,
                threadId: target.externalThreadId,
              }
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
    const activeConfig = parseTelegramConfig(context.config);
    config = activeConfig;
    const local = new AbortController();
    controller = local;
    const onParentAbort = () =>
      local.abort(context.signal.reason);
    context.signal.addEventListener("abort", onParentAbort, {
      once: true,
    });
    detachParent = () =>
      context.signal.removeEventListener(
        "abort",
        onParentAbort,
      );
    if (context.signal.aborted) onParentAbort();

    try {
      await transport.verify(activeConfig, local.signal);
    } catch (error) {
      applyError(error);
      detachParent();
      detachParent = null;
      controller = null;
      throw connectionError(error);
    }
    status = "healthy";
    lastConnectedAt = now();
    reconnectAttempts = 0;
    healthError = undefined;

    if (activeConfig.webhook_secret.trim().length > 0) return;
    if (dependencies.autoPoll === false) return;
    if (!dependencies.acceptInbound) {
      const error = new ChannelConnectionError({
        code: "runtime_prerequisite_missing",
        detail: "telegram_ingress_unavailable",
      });
      applyError(error);
      throw error;
    }

    const storedUpdateId =
      await dependencies.loadLastUpdateId?.(
        context.connectionId,
        requireScope(dependencies.scope),
      ) ?? null;
    const initialOffset = storedUpdateId === null
      ? 0
      : storedUpdateId + 1;
    pollTask = pollLoop(
      activeConfig,
      {
        connectionId: context.connectionId,
        agentId: context.agentId,
        receivedAt: now(),
      },
      requireScope(dependencies.scope),
      initialOffset,
      local.signal,
    );
  }

  async function pollLoop(
    activeConfig: TelegramConfig,
    baseContext: InboundContext,
    scope: AgentScope,
    initialOffset: number,
    signal: AbortSignal,
  ): Promise<void> {
    let offset = initialOffset;
    while (!signal.aborted) {
      try {
        const nextOffset = await transport.pollOnce({
          config: activeConfig,
          offset,
          context: {
            ...baseContext,
            receivedAt: now(),
          },
          accept: (payload, inboundContext) =>
            dependencies.acceptInbound!(
              payload,
              inboundContext,
              scope,
            ),
          signal,
        });
        if (nextOffset > offset) {
          offset = nextOffset;
          lastEventAt = now();
        }
        status = "healthy";
        reconnectAttempts = 0;
        healthError = undefined;
      } catch (error) {
        if (signal.aborted) return;
        applyError(error);
        if (
          error instanceof TelegramTransportError
          && !error.retryable
        ) {
          return;
        }
        const delayMs = error instanceof TelegramTransportError
          ? error.retryAfterMs ?? 1_000
          : 1_000;
        await (dependencies.delay ?? delayWithSignal)(
          delayMs,
          signal,
        );
      }
    }
  }

  function applyError(error: unknown): void {
    status = "degraded";
    reconnectAttempts += 1;
    const code = error instanceof TelegramTransportError
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

function requireConfig(
  value: TelegramConfig | null,
): TelegramConfig {
  if (!value) throw new Error("telegram_config_unavailable");
  return value;
}

function requireScope(value: AgentScope | undefined): AgentScope {
  if (!value) {
    throw new ChannelConnectionError({
      code: "runtime_prerequisite_missing",
      detail: "telegram_scope_unavailable",
    });
  }
  return value;
}

function connectionError(error: unknown): ChannelConnectionError {
  if (error instanceof ChannelConnectionError) return error;
  if (error instanceof TelegramTransportError) {
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
    detail: "telegram_connection_failed",
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
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export {
  parseTelegramConfig,
  telegramConfigSchema,
} from "./config";
export {
  normalizeTelegramInbound,
  telegramEventId,
} from "./normalize";
