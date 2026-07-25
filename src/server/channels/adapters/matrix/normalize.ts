import type {
  InboundAttachmentDescriptor,
  InboundContext,
  NormalizedChannelEvent,
} from "@/server/channels/runtime/types";

export type MatrixInboundFrame = Readonly<{
  eventId?: unknown;
  roomId?: unknown;
  senderId?: unknown;
  botUserId?: unknown;
  eventType?: unknown;
  timestamp?: unknown;
  isDirect?: unknown;
  encrypted?: unknown;
  visionEnabled?: unknown;
  mediaHomeserver?: unknown;
  mediaAccessToken?: unknown;
  content?: unknown;
}>;

export function normalizeMatrixInbound(
  payload: unknown,
  context: InboundContext,
): NormalizedChannelEvent | null {
  const frame = asRecord(payload) as MatrixInboundFrame;
  const eventId = matrixId(frame.eventId, "$");
  const roomId = matrixId(frame.roomId, "!");
  const senderId = matrixId(frame.senderId, "@");
  const botUserId = matrixId(frame.botUserId, "@");
  const eventType = stringValue(frame.eventType);
  const content = asRecord(frame.content);

  if (
    !eventId
    || !roomId
    || !senderId
    || eventType !== "m.room.message"
    || senderId === botUserId
    || isEdit(content)
  ) {
    return null;
  }

  const msgtype = stringValue(content.msgtype);
  if (
    msgtype !== "m.text"
    && msgtype !== "m.notice"
    && msgtype !== "m.image"
    && msgtype !== "m.file"
  ) {
    return null;
  }
  const attachments = matrixAttachments(
    frame,
    content,
    eventId,
    msgtype,
  );
  const rawText = boundedText(content.body);
  const text = (
    (msgtype === "m.text" || msgtype === "m.notice")
      ? stripLeadingMention(rawText, botUserId)
      : rawText
  )
    ?? (attachments.length > 0 ? "[附件]" : null);
  if (!text) return null;

  const direct = frame.isDirect === true;
  const replyToEventId = replyEventId(content);
  const mentioned = direct || mentionsBot(content, botUserId);
  return {
    connectionId: context.connectionId,
    agentId: context.agentId,
    channelType: "matrix",
    externalEventId: eventId,
    externalConversationId: roomId,
    externalSenderId: senderId,
    chatType: direct ? "direct" : "group",
    mentioned,
    text,
    thread: {
      ...(replyToEventId ? { replyToEventId } : {}),
    },
    attachments,
    occurredAt: matrixDate(frame.timestamp, context.receivedAt),
    receivedAt: context.receivedAt,
    permission: {
      webSearch: false,
      backgroundNetwork: false,
      tools: false,
      skills:
        attachments.length === 0 && text.startsWith("/")
          ? "explicit_slash"
          : "none",
      attachmentsPresent: attachments.length > 0,
    },
    rawSummary: {
      eventType,
      encrypted: frame.encrypted === true,
      isBotEvent: false,
      isSelfEvent: false,
    },
    replyHandle: {
      publicFields: {
        roomId,
        senderId,
        eventId,
      },
      secretFields: {},
      expiresAt: null,
    },
  };
}

function stripLeadingMention(
  text: string | null,
  botUserId: string | null,
): string | null {
  if (!text || !botUserId) return text;
  const stripped = text.replace(
    new RegExp(
      `^${escapeRegExp(botUserId)}\\s*:?\\s*`,
      "iu",
    ),
    "",
  ).trim();
  return stripped.length > 0 ? stripped : text;
}

function matrixAttachments(
  frame: MatrixInboundFrame,
  content: Record<string, unknown>,
  eventId: string,
  msgtype: string,
): InboundAttachmentDescriptor[] {
  if (msgtype !== "m.image" && msgtype !== "m.file") {
    return [];
  }
  if (msgtype === "m.image" && frame.visionEnabled !== true) {
    return [];
  }
  const homeserver = stringValue(frame.mediaHomeserver);
  const accessToken = stringValue(frame.mediaAccessToken);
  const encryptedFile = asRecord(content.file);
  const mxcUrl = stringValue(content.url)
    ?? stringValue(encryptedFile.url);
  if (
    !homeserver
    || !accessToken
    || !mxcUrl?.startsWith("mxc://")
  ) {
    return [];
  }
  const info = asRecord(content.info);
  const fileName = safeFileName(content.body);
  const mimeType = boundedMetadata(info.mimetype);
  const sizeBytes = nonNegativeInteger(info.size);
  const encryptedFileJson =
    Object.keys(encryptedFile).length > 0
      ? JSON.stringify(encryptedFile)
      : null;
  return [{
    externalAttachmentId: `${eventId}:0`,
    fileName,
    mimeType,
    sizeBytes,
    source: {
      mxcUrl,
      homeserver,
      accessToken,
      ...(encryptedFileJson
        ? { encryptedFile: encryptedFileJson }
        : {}),
    },
  }];
}

function isEdit(content: Record<string, unknown>): boolean {
  const relation = asRecord(content["m.relates_to"]);
  return relation.rel_type === "m.replace";
}

function replyEventId(
  content: Record<string, unknown>,
): string | null {
  const relation = asRecord(content["m.relates_to"]);
  const reply = asRecord(relation["m.in_reply_to"]);
  return matrixId(reply.event_id, "$");
}

function mentionsBot(
  content: Record<string, unknown>,
  botUserId: string | null,
): boolean {
  if (!botUserId) return false;
  const mentions = asRecord(content["m.mentions"]);
  if (
    Array.isArray(mentions.user_ids)
    && mentions.user_ids.includes(botUserId)
  ) {
    return true;
  }
  if (mentions.room === true) return true;
  const body = stringValue(content.body);
  if (body?.includes(botUserId)) return true;
  const formattedBody = stringValue(content.formatted_body);
  if (!formattedBody) return false;
  const encoded = encodeURIComponent(botUserId);
  return formattedBody.includes(
    `https://matrix.to/#/${botUserId}`,
  ) || formattedBody.includes(
    `https://matrix.to/#/${encoded}`,
  );
}

function matrixDate(value: unknown, fallback: Date): Date {
  const timestamp = typeof value === "number" ? value : NaN;
  const parsed = new Date(timestamp);
  return Number.isFinite(parsed.getTime()) ? parsed : fallback;
}

function boundedText(value: unknown): string | null {
  const text = stringValue(value)?.trim();
  return text && text.length <= 1024 * 1024 ? text : null;
}

function boundedMetadata(value: unknown): string | null {
  const normalized = stringValue(value)?.trim();
  return normalized && normalized.length <= 512
    ? normalized
    : null;
}

function safeFileName(value: unknown): string | null {
  const normalized = boundedMetadata(value);
  return normalized
    && !normalized.includes("/")
    && !normalized.includes("\\")
    && normalized !== "."
    && normalized !== ".."
    ? normalized
    : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : null;
}

function matrixId(
  value: unknown,
  prefix: "$" | "!" | "@",
): string | null {
  const normalized = stringValue(value)?.trim();
  return normalized
    && normalized.startsWith(prefix)
    && normalized.length <= 1_024
    ? normalized
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
