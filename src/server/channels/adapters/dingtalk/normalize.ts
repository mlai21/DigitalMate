import type {
  InboundAttachmentDescriptor,
  InboundContext,
  NormalizedChannelEvent,
} from "@/server/channels/runtime/types";

import type { DingTalkConfig } from "./config";

export function normalizeDingTalkInbound(
  payload: unknown,
  context: InboundContext,
  config: DingTalkConfig,
): NormalizedChannelEvent | null {
  const envelope = asRecord(payload);
  const event = parseEvent(envelope);
  const messageId = readId(event.msgId);
  const conversationId = readId(event.conversationId);
  const senderStaffId = readId(event.senderStaffId);
  const senderId = senderStaffId ?? readId(event.senderId);
  if (!messageId || !conversationId || !senderId) return null;
  const payloadRobotCode = readId(event.robotCode);
  if (
    config.robot_code
    && payloadRobotCode
    && payloadRobotCode !== config.robot_code
  ) {
    return null;
  }

  const type = readId(event.msgtype)?.toLowerCase() ?? "";
  const content = asRecord(event.content);
  const attachments = attachmentDescriptors(
    type,
    content,
    payloadRobotCode ?? config.robot_code,
  );
  const text = readMessageText(event, type)
    ?? (attachments.length > 0 ? "[附件]" : null);
  if (!text) return null;

  const direct = String(event.conversationType) !== "2";
  const sessionWebhook = safeSessionWebhook(event.sessionWebhook);
  const expiresAt = sessionWebhook
    ? replyExpiry(
        event.sessionWebhookExpiredTime,
        context.receivedAt,
      )
    : null;
  const attachmentPresent = attachments.length > 0;
  const robotCode = payloadRobotCode ?? config.robot_code;
  const adminFrom = Array.isArray(config.admin_from)
    ? config.admin_from.filter((value): value is string =>
        typeof value === "string"
      )
    : [];
  return {
    connectionId: context.connectionId,
    agentId: context.agentId,
    channelType: "dingtalk",
    externalEventId: `message:${messageId}`,
    externalConversationId: conversationId,
    externalSenderId: senderId,
    chatType: direct ? "direct" : "group",
    mentioned:
      direct
      || event.isInAtList === true
      || (
        Array.isArray(event.atUsers)
        && event.atUsers.length > 0
      ),
    text,
    thread: {},
    attachments,
    occurredAt: safeDate(event.createAt, context.receivedAt),
    receivedAt: context.receivedAt,
    permission: {
      webSearch: false,
      backgroundNetwork: false,
      tools: false,
      skills: !attachmentPresent && text.startsWith("/")
        ? "explicit_slash"
        : "none",
      attachmentsPresent: attachmentPresent,
      manageGlobalAssets: direct && adminFrom.includes(senderId),
    },
    rawSummary: {
      eventType: type,
      platformMessageId: messageId,
      isBotEvent: false,
      hasReplyHandle: Boolean(sessionWebhook),
    },
    ...(sessionWebhook
      ? {
          replyHandle: {
            publicFields: {
              conversationId,
              conversationType: direct ? "direct" : "group",
              senderStaffId: senderStaffId ?? senderId,
              ...(robotCode ? { robotCode } : {}),
              messageId,
            },
            secretFields: { sessionWebhook },
            expiresAt,
          },
        }
      : {}),
  };
}

function parseEvent(
  envelope: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof envelope.data !== "string") return envelope;
  if (envelope.data.length > 2 * 1024 * 1024) return {};
  try {
    return asRecord(JSON.parse(envelope.data) as unknown);
  } catch {
    return {};
  }
}

function readMessageText(
  event: Record<string, unknown>,
  type: string,
): string | null {
  if (type === "text") {
    return readText(asRecord(event.text).content);
  }
  if (type === "markdown" || type === "ai_card") {
    const markdown = asRecord(event.markdown);
    return readText(markdown.text ?? markdown.content)
      ?? readText(asRecord(event.content).text);
  }
  // DingTalk sends anything the user pasted with formatting — numbered lists,
  // text around an inline image — as richText, not text. Without this branch the
  // whole event normalized to null and the message was dropped before it ever
  // reached an agent turn, which reads to the user as being ignored.
  if (type === "richtext") {
    return readText(richTextSegments(event)
      .map((segment) => typeof segment.text === "string" ? segment.text : "")
      .filter((text) => text.trim())
      // Segments are split around non-text elements, so a newline restores the
      // break the user saw instead of gluing paragraphs together.
      .join("\n"));
  }
  return null;
}

/** Shape per DingTalk docs: `{ content: { richText: [{ text }, { downloadCode, type }] } }`. */
function richTextSegments(
  event: Record<string, unknown>,
): Record<string, unknown>[] {
  const segments = asRecord(event.content).richText;
  return Array.isArray(segments) ? segments.map(asRecord) : [];
}

/** Bounds the work one inbound message can queue up. */
const RICH_TEXT_IMAGE_LIMIT = 9;

function attachmentDescriptors(
  type: string,
  content: Record<string, unknown>,
  robotCode: string,
): InboundAttachmentDescriptor[] {
  if (type === "richtext") {
    if (!robotCode) return [];
    const images: InboundAttachmentDescriptor[] = [];
    const segments = Array.isArray(content.richText)
      ? content.richText.map(asRecord)
      : [];
    for (const segment of segments) {
      if (images.length >= RICH_TEXT_IMAGE_LIMIT) break;
      const segmentType = readId(segment.type)?.toLowerCase();
      if (segmentType !== "picture" && segmentType !== "image") continue;
      const downloadCode = readId(segment.downloadCode ?? segment.download_code);
      if (!downloadCode) continue;
      images.push({
        externalAttachmentId: downloadCode,
        fileName: readText(segment.fileName ?? segment.file_name)
          ?? "dingtalk-image.jpg",
        mimeType: "image/jpeg",
        sizeBytes: null,
        source: { downloadCode, robotCode },
      });
    }
    return images;
  }
  if (!["picture", "image", "file"].includes(type)) return [];
  const downloadCode = readId(
    content.downloadCode ?? content.download_code,
  );
  if (!downloadCode || !robotCode) return [];
  const image = type === "picture" || type === "image";
  return [{
    externalAttachmentId: downloadCode,
    fileName: readText(
      content.fileName
      ?? content.file_name
      ?? content.filename
      ?? content.name,
    ) ?? (image ? "dingtalk-image.jpg" : null),
    mimeType: image ? "image/jpeg" : null,
    sizeBytes: null,
    source: {
      downloadCode,
      robotCode,
    },
  }];
}

function safeSessionWebhook(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 16_384) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && (
        host === "dingtalk.com"
        || host.endsWith(".dingtalk.com")
      )
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function replyExpiry(value: unknown, now: Date): Date {
  const numeric = Number(value);
  const platform = new Date(numeric);
  const maximum = now.getTime() + 24 * 60 * 60 * 1_000;
  if (
    Number.isFinite(platform.getTime())
    && platform.getTime() > now.getTime()
    && platform.getTime() <= maximum
  ) {
    return platform;
  }
  return new Date(now.getTime() + 60 * 60 * 1_000);
}

function safeDate(value: unknown, fallback: Date): Date {
  const date = new Date(Number(value));
  return Number.isFinite(date.getTime()) ? date : fallback;
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
