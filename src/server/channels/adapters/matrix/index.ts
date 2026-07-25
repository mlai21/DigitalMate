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
  isMatrixRoomId,
  isMatrixUserId,
  parseMatrixConfig,
  type MatrixConfig,
} from "./config";
import { normalizeMatrixInbound } from "./normalize";
import {
  createMatrixClient,
  mapMatrixError,
  MatrixTransportError,
  type MatrixClientFactory,
  type MatrixClientPort,
} from "./transport";

export type MatrixAdapterDependencies = Readonly<{
  clientFactory?: MatrixClientFactory;
  scope?: AgentScope;
  acceptInbound?(
    payload: unknown,
    context: InboundContext,
    scope: AgentScope,
  ): Promise<IngressResult>;
  cryptoStorageKey?: Uint8Array;
  cryptoStorageRoot?: string;
  autoListen?: boolean;
  now?: () => Date;
}>;

export function createMatrixAdapter(
  dependencies: MatrixAdapterDependencies = {},
): ChannelAdapter<MatrixConfig> {
  const manifest = getChannelManifest("matrix");
  const now = dependencies.now ?? (() => new Date());
  let config: MatrixConfig | null = null;
  let client: MatrixClientPort | null = null;
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

  const adapter: ChannelAdapter<MatrixConfig> = {
    manifest,

    validateConfig(input) {
      const parsed = parseMatrixConfig(input);
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
      return normalizeMatrixInbound(payload, context);
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
      const activeClient = requireClient(client);
      const address = deliveryAddress(delivery);
      const content = messageContent(
        delivery.body,
        address.senderId,
        address.replyToEventId,
        context.config,
      );
      const sentAt = context.now();
      const result = await activeClient.sendMessage({
        roomId: address.roomId,
        content,
        txnId: delivery.id,
      });
      return sendResult(result.eventId, sentAt, false);
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
      const activeClient = requireClient(client);
      const address = deliveryAddress(delivery);
      const replacement = messageContent(
        delivery.body,
        address.senderId,
        null,
        activeConfig,
      );
      const previousEventId =
        state.previousResult.externalMessageId;
      await activeClient.sendMessage({
        roomId: address.roomId,
        txnId: `${delivery.id}:edit:${state.sequence}`,
        content: {
          msgtype: "m.text",
          body: `* ${delivery.body}`,
          "m.new_content": replacement,
          "m.relates_to": {
            rel_type: "m.replace",
            event_id: previousEventId,
          },
        },
      });
      return sendResult(previousEventId, now(), true);
    },

    async typing(recipient, active) {
      const roomId = recipient.address.roomId;
      if (!isMatrixRoomId(roomId ?? "")) {
        throw new Error("matrix_room_id_invalid");
      }
      await requireClient(client).sendTyping({
        roomId: roomId!,
        active,
        timeoutMs: 30_000,
      });
    },

    async resolveRecipient(target) {
      if (!isMatrixRoomId(target.externalConversationId)) {
        throw new Error("matrix_room_id_invalid");
      }
      if (
        target.externalUserId
        && !isMatrixUserId(target.externalUserId)
      ) {
        throw new Error("matrix_user_id_invalid");
      }
      return {
        address: {
          roomId: target.externalConversationId,
          conversationId: target.externalConversationId,
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
    const activeConfig = parseMatrixConfig(context.config);
    config = activeConfig;
    if (
      dependencies.autoListen !== false
      && (!dependencies.acceptInbound || !dependencies.scope)
    ) {
      const error = new ChannelConnectionError({
        code: "runtime_prerequisite_missing",
        detail: "matrix_ingress_unavailable",
      });
      applyError(error);
      throw error;
    }
    if (
      activeConfig.encryption
      && !dependencies.cryptoStorageKey
    ) {
      const error = new ChannelConnectionError({
        code: "runtime_prerequisite_missing",
        detail: "matrix_crypto_storage_unavailable",
      });
      applyError(error);
      throw error;
    }

    status = "connecting";
    const scope = dependencies.scope ?? {
      userId: "local-user",
      agentId: context.agentId,
    };
    const activeClient = (
      dependencies.clientFactory ?? createMatrixClient
    )(activeConfig, {
      identity: {
        userId: scope.userId,
        agentId: scope.agentId,
        connectionId: context.connectionId,
      },
      cryptoStorageKey:
        dependencies.cryptoStorageKey ?? null,
      ...(dependencies.cryptoStorageRoot
        ? { cryptoStorageRoot: dependencies.cryptoStorageRoot }
        : {}),
    });
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
      await activeClient.start({
        signal: context.signal,
        initialSyncLimit: activeConfig.history_limit,
        syncTimeoutMs: activeConfig.sync_timeout_ms,
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
    const mapped = error instanceof MatrixTransportError
      ? error
      : mapMatrixError(error);
    healthError = {
      code: mapped.code,
      detail: mapped.code,
    };
    nextAttemptAt = mapped.retryAfterMs === undefined
      ? undefined
      : new Date(now().getTime() + mapped.retryAfterMs);
  }
}

function deliveryAddress(
  delivery: Parameters<
    ChannelAdapter<MatrixConfig>["send"]
  >[0],
): Readonly<{
  roomId: string;
  senderId: string | null;
  replyToEventId: string | null;
}> {
  const roomId = (
    delivery.replyHandle?.publicFields.roomId
    ?? delivery.recipient.externalConversationId
  ).trim();
  if (!isMatrixRoomId(roomId)) {
    throw new Error("matrix_room_id_invalid");
  }
  const rawSenderId =
    delivery.replyHandle?.publicFields.senderId
    ?? delivery.recipient.externalUserId
    ?? null;
  const senderId = rawSenderId?.trim() ?? null;
  if (senderId && !isMatrixUserId(senderId)) {
    throw new Error("matrix_user_id_invalid");
  }
  const rawReplyId =
    delivery.replyHandle?.publicFields.eventId
    ?? delivery.eventId;
  const replyToEventId = rawReplyId?.startsWith("$")
    ? rawReplyId
    : null;
  return { roomId, senderId, replyToEventId };
}

function messageContent(
  body: string,
  mentionedUserId: string | null,
  replyToEventId: string | null,
  config: MatrixConfig,
): Record<string, unknown> {
  const content: Record<string, unknown> = {
    msgtype: "m.text",
    body,
  };
  if (
    config.outbound_structured_mentions
    && mentionedUserId
  ) {
    content["m.mentions"] = {
      user_ids: [mentionedUserId],
    };
  }
  if (config.mention_pill_in_body && mentionedUserId) {
    content.format = "org.matrix.custom.html";
    content.formatted_body =
      `<a href="https://matrix.to/#/${escapeHtmlAttribute(mentionedUserId)}">`
      + `${escapeHtml(mentionedUserId)}</a> ${escapeHtml(body)}`;
  }
  if (replyToEventId) {
    content["m.relates_to"] = {
      "m.in_reply_to": {
        event_id: replyToEventId,
      },
    };
  }
  return content;
}

function sendResult(
  eventId: string,
  sentAt: Date,
  edited: boolean,
): SendResult {
  return {
    externalMessageId: eventId,
    sentAt,
    rawSummary: {
      sent: true,
      edited,
      eventType: "m.room.message",
    },
  };
}

function requireClient(
  client: MatrixClientPort | null,
): MatrixClientPort {
  if (!client) {
    throw new MatrixTransportError({
      code: "network_unreachable",
      retryable: true,
    });
  }
  return client;
}

function requireConfig(
  config: MatrixConfig | null,
): MatrixConfig {
  if (!config) {
    throw new MatrixTransportError({
      code: "runtime_prerequisite_missing",
      retryable: false,
    });
  }
  return config;
}

function connectionError(error: unknown): ChannelConnectionError {
  if (error instanceof ChannelConnectionError) return error;
  const mapped = error instanceof MatrixTransportError
    ? error
    : mapMatrixError(error);
  return new ChannelConnectionError({
    code: mapped.code,
    detail: mapped.code,
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value)
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

export type { MatrixConfig };
