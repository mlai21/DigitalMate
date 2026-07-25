import {
  getChannelManifest,
  type ChannelType,
} from "@/server/channels/manifests/catalog";
import type { ChannelAdapter } from "@/server/channels/runtime/adapter";
import type {
  ChannelDelivery,
  InboundContext,
  NormalizedChannelEvent,
  SendContext,
  SendResult,
} from "@/server/channels/runtime/types";

type WebhookAdapterDefinition = Readonly<{
  type: Extract<
    ChannelType,
    "telegram" | "slack" | "feishu" | "dingtalk"
  >;
  normalize(
    payload: unknown,
    context: InboundContext,
  ): NormalizedChannelEvent | null;
  send(
    delivery: ChannelDelivery,
    context: SendContext<Record<string, unknown>>,
  ): Promise<SendResult>;
}>;

export function createWebhookAdapter(
  definition: WebhookAdapterDefinition,
): ChannelAdapter<Record<string, unknown>> {
  const manifest = getChannelManifest(definition.type);
  let running = false;
  let lastConnectedAt: Date | undefined;

  return {
    manifest,
    validateConfig(config) {
      return manifest.configSchema.parse(config);
    },
    async start(context) {
      context.signal.throwIfAborted();
      manifest.configSchema.parse(context.config);
      running = true;
      lastConnectedAt = context.now();
    },
    async stop() {
      running = false;
    },
    async health() {
      const checkedAt = new Date();
      return running
        ? {
            status: "healthy",
            checkedAt,
            reconnectAttempts: 0,
            ...(lastConnectedAt
              ? { lastConnectedAt }
              : {}),
          }
        : {
            status: "stopped",
            checkedAt,
            reconnectAttempts: 0,
          };
    },
    async normalizeInbound(payload, context) {
      return definition.normalize(payload, context);
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
    send: definition.send,
    async resolveRecipient(target) {
      return {
        address: {
          conversationId: target.externalConversationId,
          ...(target.externalThreadId
            ? { threadId: target.externalThreadId }
            : {}),
          ...(target.externalUserId
            ? { userId: target.externalUserId }
            : {}),
        },
      };
    },
  };
}

export function normalizedEvent(input: Readonly<{
  context: InboundContext;
  channelType: Extract<
    ChannelType,
    "telegram" | "slack" | "feishu" | "dingtalk"
  >;
  externalEventId: string;
  externalConversationId: string;
  externalSenderId: string;
  chatType: "direct" | "group";
  mentioned: boolean;
  text: string;
  occurredAt: Date;
  thread?: Readonly<{
    externalThreadId?: string;
    replyToEventId?: string;
  }>;
  rawSummary: Readonly<
    Record<string, string | number | boolean | null>
  >;
  replyHandle?: NormalizedChannelEvent["replyHandle"];
}>): NormalizedChannelEvent {
  return {
    connectionId: input.context.connectionId,
    agentId: input.context.agentId,
    channelType: input.channelType,
    externalEventId: input.externalEventId,
    externalConversationId: input.externalConversationId,
    externalSenderId: input.externalSenderId,
    chatType: input.chatType,
    mentioned: input.mentioned,
    text: input.text,
    thread: input.thread ?? {},
    attachments: [],
    occurredAt: input.occurredAt,
    receivedAt: input.context.receivedAt,
    permission: {
      webSearch: false,
      backgroundNetwork: false,
      tools: false,
      skills: input.text.trimStart().startsWith("/")
        ? "explicit_slash"
        : "none",
      attachmentsPresent: false,
    },
    rawSummary: input.rawSummary,
    ...(input.replyHandle
      ? { replyHandle: input.replyHandle }
      : {}),
  };
}

export async function requireJsonResponse(
  response: Response,
  platform: string,
): Promise<Record<string, unknown>> {
  if (!response.ok) {
    throw new Error(
      `${platform}_send_http_${response.status}`,
    );
  }
  const payload = await response.json() as unknown;
  if (
    payload === null
    || typeof payload !== "object"
    || Array.isArray(payload)
  ) {
    throw new Error(`${platform}_send_response_invalid`);
  }
  return payload as Record<string, unknown>;
}

export function readString(
  value: unknown,
  maximum = 4_096,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximum
    ? normalized
    : null;
}

export function safeDate(
  milliseconds: number,
  fallback: Date,
): Date {
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date : fallback;
}
