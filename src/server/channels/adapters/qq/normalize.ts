import { createHash } from "node:crypto";

import type {
  InboundAttachmentDescriptor,
  InboundContext,
  NormalizedChannelEvent,
} from "@/server/channels/runtime/types";

type MessageRoute = Readonly<{
  messageType: "c2c" | "group" | "guild" | "dm";
  chatType: "direct" | "group";
  senderKeys: readonly string[];
  conversation(
    event: Record<string, unknown>,
    senderId: string,
  ): string | null;
  mentioned: boolean;
}>;

const ROUTES: Readonly<Record<string, MessageRoute>> = {
  C2C_MESSAGE_CREATE: {
    messageType: "c2c",
    chatType: "direct",
    senderKeys: ["user_openid", "id"],
    conversation: (_event, senderId) => `c2c:${senderId}`,
    mentioned: true,
  },
  GROUP_AT_MESSAGE_CREATE: {
    messageType: "group",
    chatType: "group",
    senderKeys: ["member_openid", "id"],
    conversation: (event) =>
      prefixedId("group", event.group_openid),
    mentioned: true,
  },
  AT_MESSAGE_CREATE: {
    messageType: "guild",
    chatType: "group",
    senderKeys: ["id", "username"],
    conversation: (event) =>
      prefixedId("guild", event.channel_id),
    mentioned: true,
  },
  DIRECT_MESSAGE_CREATE: {
    messageType: "dm",
    chatType: "direct",
    senderKeys: ["id", "username"],
    conversation: (event) =>
      prefixedId("dm", event.guild_id),
    mentioned: true,
  },
};

export function normalizeQQInbound(
  input: unknown,
  context: InboundContext,
): NormalizedChannelEvent | null {
  const envelope = asRecord(input);
  const frame = Object.keys(asRecord(envelope.frame)).length > 0
    ? asRecord(envelope.frame)
    : envelope;
  if (Number(frame.op) !== 0) return null;
  const eventType = readId(frame.t);
  const route = eventType ? ROUTES[eventType] : undefined;
  if (!eventType || !route) return null;
  const event = asRecord(frame.d);
  const author = asRecord(event.author);
  const senderId = firstId(author, route.senderKeys);
  const messageId = readId(event.id);
  if (!senderId || !messageId) return null;
  const conversationId = route.conversation(event, senderId);
  if (!conversationId) return null;
  const sequence = safeSequence(frame.s);
  const platformEventId = readId(frame.id);
  const sessionId = readId(envelope.sessionId);
  const externalEventId = platformEventId
    ? `event:${platformEventId}`
    : sessionId && sequence !== null
      ? `gateway:${sessionId}:${sequence}:${messageId}`
      : null;
  if (!externalEventId) return null;

  const attachments = attachmentDescriptors(event.attachments);
  const text = readText(event.content)
    ?? (attachments.length > 0 ? "[附件]" : null);
  if (!text) return null;
  const attachmentPresent = attachments.length > 0;
  const publicFields = replyPublicFields(
    route.messageType,
    event,
    senderId,
    messageId,
  );
  return {
    connectionId: context.connectionId,
    agentId: context.agentId,
    channelType: "qq",
    externalEventId,
    externalConversationId: conversationId,
    externalSenderId: senderId,
    chatType: route.chatType,
    mentioned: route.mentioned,
    text,
    thread: {},
    attachments,
    occurredAt: safeDate(event.timestamp, context.receivedAt),
    receivedAt: context.receivedAt,
    permission: {
      webSearch: false,
      backgroundNetwork: false,
      tools: false,
      skills: !attachmentPresent && text.startsWith("/")
        ? "explicit_slash"
        : "none",
      attachmentsPresent: attachmentPresent,
    },
    rawSummary: {
      eventType,
      platformMessageId: messageId,
      gatewaySequence: sequence,
      attachmentCount: attachments.length,
      isBotEvent: false,
    },
    replyHandle: {
      publicFields,
      secretFields: {},
      expiresAt: new Date(
        context.receivedAt.getTime() + 5 * 60 * 1_000,
      ),
    },
  };
}

function replyPublicFields(
  messageType: MessageRoute["messageType"],
  event: Record<string, unknown>,
  senderId: string,
  messageId: string,
) {
  return {
    messageType,
    messageId,
    senderId,
    ...(readId(event.group_openid)
      ? { groupOpenId: readId(event.group_openid)! }
      : {}),
    ...(readId(event.channel_id)
      ? { channelId: readId(event.channel_id)! }
      : {}),
    ...(readId(event.guild_id)
      ? { guildId: readId(event.guild_id)! }
      : {}),
  };
}

function attachmentDescriptors(
  value: unknown,
): InboundAttachmentDescriptor[] {
  if (!Array.isArray(value)) return [];
  const descriptors: InboundAttachmentDescriptor[] = [];
  for (const candidate of value.slice(0, 20)) {
    const attachment = asRecord(candidate);
    const url = readUrl(attachment.url);
    if (!url) continue;
    const id = readId(attachment.id) ?? stableAttachmentId(url);
    const fileName = readText(
      attachment.filename ?? attachment.file_name,
    );
    const mimeType = readText(
      attachment.content_type ?? attachment.contentType,
    );
    const sizeBytes = nonNegativeInteger(
      attachment.size ?? attachment.size_bytes,
    );
    descriptors.push({
      externalAttachmentId: id,
      fileName,
      mimeType,
      sizeBytes,
      source: { url },
    });
  }
  return descriptors;
}

function stableAttachmentId(url: string): string {
  return `url:${createHash("sha256").update(url).digest("hex")}`;
}

function firstId(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const id = readId(value[key]);
    if (id) return id;
  }
  return null;
}

function prefixedId(prefix: string, value: unknown): string | null {
  const id = readId(value);
  return id ? `${prefix}:${id}` : null;
}

function safeSequence(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0
    ? numeric
    : null;
}

function safeDate(value: unknown, fallback: Date): Date {
  if (typeof value !== "string" && typeof value !== "number") {
    return fallback;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : fallback;
}

function readUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 16_384) return null;
  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}

function readText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= 1024 * 1024 ? text : null;
}

function readId(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const id = String(value).trim();
  return id && id.length <= 16_384 ? id : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0
    ? numeric
    : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
