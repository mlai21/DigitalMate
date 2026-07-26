import type {
  InboundAttachmentDescriptor,
  InboundContext,
  NormalizedChannelEvent,
} from "@/server/channels/runtime/types";
import {
  ATTACHMENT_LIMITS,
} from "@/server/attachments/types";

import { asRecord } from "./protocol";

type OneBotSegment = Readonly<{
  type: string;
  data: Readonly<Record<string, unknown>>;
}>;

export function normalizeOneBotInbound(
  payload: unknown,
  context: InboundContext,
  options: Readonly<{ shareSessionInGroup: boolean }>,
): NormalizedChannelEvent | null {
  const event = asRecord(payload);
  if (event.post_type !== "message") return null;
  const messageType = event.message_type;
  if (messageType !== "private" && messageType !== "group") {
    return null;
  }
  const messageId = identifier(event.message_id);
  const userId = identifier(event.user_id);
  const selfId = identifier(event.self_id);
  const groupId = identifier(event.group_id);
  if (
    !messageId
    || !userId
    || !selfId
    || userId === selfId
    || (messageType === "group" && !groupId)
  ) {
    return null;
  }

  const segments = parseSegments(event.message);
  if (!segments) return null;
  const parsed = contentFromSegments(segments, messageId, selfId);
  if (
    parsed.attachments.length > ATTACHMENT_LIMITS.maxCount
    || parsed.attachments.some((attachment) =>
      attachment.sizeBytes !== null
      && attachment.sizeBytes > ATTACHMENT_LIMITS.maxFileBytes
    )
    || parsed.attachments.reduce(
      (total, attachment) =>
        total + (attachment.sizeBytes ?? 0),
      0,
    ) > ATTACHMENT_LIMITS.maxMessageBytes
  ) {
    return null;
  }
  const text = parsed.text
    || (parsed.attachments.length > 0 ? "[附件]" : "");
  if (!text) return null;

  const direct = messageType === "private";
  const externalConversationId = direct
    ? `private:${userId}`
    : options.shareSessionInGroup
      ? `group:${groupId}`
      : `group:${groupId}:user:${userId}`;
  return {
    connectionId: context.connectionId,
    agentId: context.agentId,
    channelType: "onebot",
    externalEventId: `onebot:message:${messageId}`,
    externalConversationId,
    externalSenderId: userId,
    chatType: direct ? "direct" : "group",
    mentioned: direct || parsed.mentioned,
    text,
    thread: {},
    attachments: parsed.attachments,
    occurredAt: oneBotDate(event.time, context.receivedAt),
    receivedAt: context.receivedAt,
    permission: {
      webSearch: false,
      backgroundNetwork: false,
      tools: false,
      skills:
        parsed.attachments.length === 0 && text.startsWith("/")
          ? "explicit_slash"
          : "none",
      attachmentsPresent: parsed.attachments.length > 0,
    },
    rawSummary: {
      postType: "message",
      messageType,
      subType: boundedString(event.sub_type) ?? "",
      segmentCount: segments.length,
      ignoredMediaCount: parsed.ignoredMediaCount,
      selfEvent: false,
    },
    replyHandle: {
      publicFields: {
        messageType,
        userId,
        messageId,
        ...(groupId ? { groupId } : {}),
      },
      secretFields: {},
      expiresAt: null,
    },
  };
}

function contentFromSegments(
  segments: readonly OneBotSegment[],
  messageId: string,
  selfId: string,
) {
  const textParts: string[] = [];
  const attachments: InboundAttachmentDescriptor[] = [];
  let mentioned = false;
  let ignoredMediaCount = 0;

  segments.forEach((segment, index) => {
    if (segment.type === "text") {
      const value = boundedText(segment.data.text);
      if (value) textParts.push(value);
      return;
    }
    if (segment.type === "at") {
      mentioned ||= identifier(segment.data.qq) === selfId;
      return;
    }
    if (segment.type === "image" || segment.type === "file") {
      const descriptor = attachmentDescriptor(
        segment,
        messageId,
        index,
      );
      if (descriptor) attachments.push(descriptor);
      return;
    }
    if (
      segment.type === "record"
      || segment.type === "audio"
      || segment.type === "video"
    ) {
      ignoredMediaCount += 1;
    }
  });
  return {
    text: textParts.join("").trim(),
    attachments,
    mentioned,
    ignoredMediaCount,
  };
}

function attachmentDescriptor(
  segment: OneBotSegment,
  messageId: string,
  index: number,
): InboundAttachmentDescriptor | null {
  const fileId = boundedString(
    segment.data.file ?? segment.data.file_id ?? segment.data.id,
  );
  if (!fileId) return null;
  const fileName = safeFileName(
    segment.data.name ?? segment.data.file_name,
  ) ?? (
    segment.type === "image"
      ? safeFileName(fileId)
      : null
  );
  const mimeType = boundedString(
    segment.data.mime ?? segment.data.mime_type,
  );
  const size = Number(segment.data.size);
  const url = safeHttpsUrl(segment.data.url);
  return {
    externalAttachmentId: `onebot:${messageId}:${index}`,
    fileName,
    mimeType,
    sizeBytes:
      Number.isSafeInteger(size) && size >= 0 ? size : null,
    source: {
      kind: segment.type,
      fileId,
      ...(url ? { url } : {}),
    },
  };
}

function parseSegments(value: unknown): OneBotSegment[] | null {
  if (Array.isArray(value)) {
    if (value.length > 1_024) return null;
    return value.flatMap((entry) => {
      const segment = asRecord(entry);
      const type = boundedString(segment.type);
      return type
        ? [{ type, data: asRecord(segment.data) }]
        : [];
    });
  }
  if (typeof value !== "string" || value.length > 1024 * 1024) {
    return [];
  }
  const segments: OneBotSegment[] = [];
  const cq = /\[CQ:([a-zA-Z0-9_-]+)((?:,[^\]]*)?)\]/gu;
  let cursor = 0;
  for (const match of value.matchAll(cq)) {
    const position = match.index ?? cursor;
    if (position > cursor) {
      segments.push({
        type: "text",
        data: { text: decodeCq(value.slice(cursor, position)) },
      });
    }
    const data: Record<string, string> = {};
    for (const pair of (match[2] ?? "").replace(/^,/u, "").split(",")) {
      if (!pair) continue;
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      data[pair.slice(0, separator)] = decodeCq(
        pair.slice(separator + 1),
      );
    }
    segments.push({
      type: match[1].toLowerCase(),
      data,
    });
    if (segments.length > 1_024) return null;
    cursor = position + match[0].length;
  }
  if (cursor < value.length) {
    segments.push({
      type: "text",
      data: { text: decodeCq(value.slice(cursor)) },
    });
  }
  return segments.length <= 1_024 ? segments : null;
}

function decodeCq(value: string): string {
  let decoded = value
    .replaceAll("&#44;", ",")
    .replaceAll("&#91;", "[")
    .replaceAll("&#93;", "]")
    .replaceAll("&amp;", "&");
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // CQ payloads are not required to use percent encoding.
  }
  return decoded;
}

function oneBotDate(value: unknown, fallback: Date): Date {
  const seconds = Number(value);
  const parsed = new Date(seconds * 1_000);
  return Number.isFinite(seconds)
    && Number.isFinite(parsed.getTime())
    ? parsed
    : fallback;
}

function identifier(value: unknown): string | null {
  const normalized = (
    typeof value === "string" || typeof value === "number"
  )
    ? String(value).trim()
    : "";
  return normalized.length > 0
    && normalized.length <= 256
    && /^[A-Za-z0-9_.:-]+$/u.test(normalized)
    ? normalized
    : null;
}

function boundedText(value: unknown): string | null {
  const normalized = boundedString(value);
  return normalized && normalized.length <= 1024 * 1024
    ? normalized
    : null;
}

function boundedString(value: unknown): string | null {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 4_096
    ? value
    : null;
}

function safeFileName(value: unknown): string | null {
  const normalized = boundedString(value);
  return normalized
    && !normalized.includes("/")
    && !normalized.includes("\\")
    && normalized !== "."
    && normalized !== ".."
    ? normalized
    : null;
}

function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.username === ""
      && url.password === ""
      && url.port === ""
      && isTrustedOneBotMediaHost(url.hostname)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function isTrustedOneBotMediaHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "qpic.cn"
    || normalized.endsWith(".qpic.cn")
    || normalized === "qq.com"
    || normalized.endsWith(".qq.com")
    || normalized === "qq.com.cn"
    || normalized.endsWith(".qq.com.cn");
}
