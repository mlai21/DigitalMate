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
  isValidMqttClientId,
  parseMqttConfig,
  type MqttConfig,
} from "./config";
import { normalizeMqttInbound } from "./normalize";
import {
  createMqttClient,
  MqttTransportError,
  type MqttClientFactory,
  type MqttClientPort,
} from "./transport";

export type MqttAdapterDependencies = Readonly<{
  clientFactory?: MqttClientFactory;
  scope?: AgentScope;
  acceptInbound?(
    payload: unknown,
    context: InboundContext,
    scope: AgentScope,
  ): Promise<IngressResult>;
  autoListen?: boolean;
  now?: () => Date;
}>;

export function createMqttAdapter(
  dependencies: MqttAdapterDependencies = {},
): ChannelAdapter<MqttConfig> {
  const manifest = getChannelManifest("mqtt");
  const now = dependencies.now ?? (() => new Date());
  let client: MqttClientPort | null = null;
  let status: "stopped" | "healthy" | "degraded" = "stopped";
  let lastConnectedAt: Date | undefined;
  let lastEventAt: Date | undefined;
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

  const adapter: ChannelAdapter<MqttConfig> = {
    manifest,

    validateConfig(input) {
      return parseMqttConfig(input);
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
      return normalizeMqttInbound(payload, context);
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
      const clientId = deliveryClientId(delivery);
      const topic = context.config.publish_topic
        .replaceAll("{client_id}", clientId);
      const sentAt = context.now();
      const result = await activeClient.publish({
        topic,
        payload: JSON.stringify({
          id: delivery.id,
          reply_to: delivery.eventId,
          text: delivery.body,
          created_at: sentAt.toISOString(),
        }),
        qos: context.config.qos,
        retain: false,
      });
      return sendResult(
        result.messageId,
        delivery.id,
        topic,
        context.config.qos,
        sentAt,
      );
    },

    async resolveRecipient(target) {
      const clientId = target.externalConversationId.trim();
      if (!isValidMqttClientId(clientId)) {
        throw new Error("mqtt_client_id_invalid");
      }
      return {
        address: {
          clientId,
          conversationId: clientId,
        },
      };
    },
  };

  return adapter;

  async function start(
    context: Parameters<typeof adapter.start>[0],
  ): Promise<void> {
    context.signal.throwIfAborted();
    const activeConfig = parseMqttConfig(context.config);
    if (
      dependencies.autoListen !== false
      && (!dependencies.acceptInbound || !dependencies.scope)
    ) {
      const error = new ChannelConnectionError({
        code: "runtime_prerequisite_missing",
        detail: "mqtt_ingress_unavailable",
      });
      applyError(error);
      throw error;
    }

    const activeClient = (
      dependencies.clientFactory ?? createMqttClient
    )(activeConfig, context.connectionId);
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
            );
          }
          lastEventAt = now();
        },
        onError(error) {
          applyError(error);
        },
        onConnected() {
          status = "healthy";
          lastConnectedAt = now();
          reconnectAttempts = 0;
          healthError = undefined;
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

  async function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      detachParent?.();
      detachParent = null;
      status = "stopped";
      reconnectAttempts = 0;
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
    const code = error instanceof MqttTransportError
      ? error.code
      : error instanceof ChannelConnectionError
        ? error.code
        : "network_unreachable";
    healthError = {
      code,
      detail: code,
    };
  }
}

function deliveryClientId(
  delivery: Parameters<
    ChannelAdapter<MqttConfig>["send"]
  >[0],
): string {
  const clientId = (
    delivery.replyHandle?.publicFields.clientId
    ?? delivery.recipient.externalConversationId
  ).trim();
  if (!isValidMqttClientId(clientId)) {
    throw new Error("mqtt_client_id_invalid");
  }
  return clientId;
}

function sendResult(
  messageId: number | null,
  deliveryId: string,
  topic: string,
  qos: number,
  sentAt: Date,
): SendResult {
  return {
    externalMessageId:
      `mqtt-publish:${messageId ?? deliveryId}`,
    sentAt,
    rawSummary: {
      published: true,
      topic,
      qos,
      brokerMessageId: messageId,
    },
  };
}

function requireClient(
  client: MqttClientPort | null,
): MqttClientPort {
  if (!client) {
    throw new MqttTransportError({
      code: "network_unreachable",
      retryable: true,
    });
  }
  return client;
}

function connectionError(error: unknown): ChannelConnectionError {
  if (error instanceof ChannelConnectionError) return error;
  if (error instanceof MqttTransportError) {
    return new ChannelConnectionError({
      code: error.code,
      detail: error.code,
    });
  }
  return new ChannelConnectionError({
    code: "network_unreachable",
    detail: "mqtt_connection_failed",
  });
}

export type { MqttConfig };
