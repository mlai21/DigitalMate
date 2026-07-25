import path from "node:path";

import type {
  InboundAttachmentDescriptor,
  InboundContext,
  NormalizedChannelEvent,
} from "@/server/channels/runtime/types";

import type { WeComConfig } from "./config";

type WeComFrame = Readonly<{
  cmd?: unknown;
  headers?: unknown;
  body?: unknown;
}>;

export function normalizeWeComInbound(
  payload: unknown,
  context: InboundContext,
  config: WeComConfig,
): NormalizedChannelEvent | null {
  const frame = asRecord(payload) as WeComFrame;
  if (frame.cmd !== "aibot_msg_callback") return null;
  const headers = asRecord(frame.headers);
  const body = asRecord(frame.body);
  const messageId = boundedId(body.msgid);
  const botId = boundedId(body.aibotid);
  const senderId = boundedId(asRecord(body.from).userid);
  const requestId = boundedId(headers.req_id);
  const chatType = body.chattype === "group"
    ? "group"
    : body.chattype === "single"
      ? "direct"
      : null;
  if (
    !messageId
    || !senderId
    || !requestId
    || !chatType
    || (botId && botId !== config.bot_id)
  ) {
    return null;
  }
  const groupChatId = chatType === "group"
    ? boundedId(body.chatid)
    : null;
  if (chatType === "group" && !groupChatId) return null;

  const messageType = boundedId(body.msgtype)?.toLowerCase() ?? "";
  const attachments = attachmentDescriptors(
    body,
    messageId,
    messageType,
  );
  const text = messageText(body, messageType)
    ?? (attachments.length > 0 ? "[附件]" : null);
  if (!text) return null;

  const chatId = groupChatId ?? senderId;
  const conversationId = chatType === "group"
    && !config.share_session_in_group
    ? `${chatId}:${senderId}`
    : chatId;
  return {
    connectionId: context.connectionId,
    agentId: context.agentId,
    channelType: "wecom",
    externalEventId: `wecom:message:${messageId}`,
    externalConversationId: conversationId,
    externalSenderId: senderId,
    chatType,
    mentioned: true,
    text,
    thread: {},
    attachments,
    occurredAt: weComDate(body.create_time, context.receivedAt),
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
      eventType: "aibot_msg_callback",
      messageType,
      platformMessageId: messageId,
      isBotEvent: false,
    },
    replyHandle: {
      publicFields: {
        chatId,
        senderId,
        messageId,
      },
      secretFields: {
        requestId,
      },
      expiresAt: new Date(
        context.receivedAt.getTime() + 10 * 60 * 1_000,
      ),
    },
  };
}

export function normalizeWeComWelcome(
  payload: unknown,
  context: InboundContext,
  botId: string,
  shareSessionInGroup: boolean,
): Readonly<{
  requestId: string;
  event: NormalizedChannelEvent;
}> | null {
  const frame = asRecord(payload);
  if (frame.cmd !== "aibot_event_callback") return null;
  const body = asRecord(frame.body);
  const messageId = boundedId(body.msgid);
  const senderId = boundedId(asRecord(body.from).userid);
  const requestId = boundedId(asRecord(frame.headers).req_id);
  if (
    boundedId(body.aibotid) !== botId
    || !messageId
    || !senderId
    || !requestId
    || body.msgtype !== "event"
    || asRecord(body.event).eventtype !== "enter_chat"
  ) {
    return null;
  }
  const group = body.chattype === "group";
  const chatId = group
    ? boundedId(body.chatid)
    : senderId;
  if (!chatId) return null;
  const conversationId = group && !shareSessionInGroup
    ? `${chatId}:${senderId}`
    : chatId;
  return {
    requestId,
    event: {
      connectionId: context.connectionId,
      agentId: context.agentId,
      channelType: "wecom",
      externalEventId: `wecom:event:${messageId}`,
      externalConversationId: conversationId,
      externalSenderId: senderId,
      chatType: group ? "group" : "direct",
      mentioned: true,
      text: "[进入会话]",
      thread: {},
      attachments: [],
      occurredAt: weComDate(
        body.create_time,
        context.receivedAt,
      ),
      receivedAt: context.receivedAt,
      permission: {
        webSearch: false,
        backgroundNetwork: false,
        tools: false,
        skills: "none",
        attachmentsPresent: false,
      },
      rawSummary: {
        eventType: "enter_chat",
        platformMessageId: messageId,
        isBotEvent: false,
      },
    },
  };
}

function messageText(
  body: Record<string, unknown>,
  type: string,
): string | null {
  if (type === "text") {
    return boundedText(asRecord(body.text).content);
  }
  if (type === "voice") {
    return boundedText(asRecord(body.voice).content)
      ?? "[语音未识别]";
  }
  if (type === "mixed") {
    const items = asRecord(body.mixed).msg_item;
    if (!Array.isArray(items)) return null;
    const text = items
      .filter((item) => asRecord(item).msgtype === "text")
      .map((item) =>
        boundedText(
          asRecord(asRecord(item).text).content,
        )
      )
      .filter((item): item is string => item !== null)
      .join("\n")
      .trim();
    return text || null;
  }
  return null;
}

function attachmentDescriptors(
  body: Record<string, unknown>,
  messageId: string,
  type: string,
): InboundAttachmentDescriptor[] {
  const candidates: Array<{
    kind: "image" | "file";
    data: Record<string, unknown>;
  }> = [];
  if (type === "image" || type === "file") {
    candidates.push({
      kind: type,
      data: asRecord(body[type]),
    });
  } else if (type === "mixed") {
    const items = asRecord(body.mixed).msg_item;
    if (Array.isArray(items)) {
      for (const item of items) {
        const record = asRecord(item);
        if (
          record.msgtype === "image"
          || record.msgtype === "file"
        ) {
          candidates.push({
            kind: record.msgtype,
            data: asRecord(record[record.msgtype]),
          });
        }
      }
    }
  }

  const descriptors: InboundAttachmentDescriptor[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const url = safeMediaUrl(candidate.data.url);
    const aesKey = boundedSecret(candidate.data.aeskey);
    if (!url || !aesKey) continue;
    const image = candidate.kind === "image";
    const fileName = safeFileName(candidate.data.filename)
      ?? (image ? "wecom-image.jpg" : null);
    descriptors.push({
      externalAttachmentId: `${messageId}:${index}`,
      fileName,
      mimeType: boundedMetadata(
        candidate.data.content_type
        ?? candidate.data.mimetype,
      ) ?? (image ? "image/jpeg" : inferMimeType(fileName)),
      sizeBytes: nonNegativeInteger(candidate.data.size),
      source: {
        url,
        aesKey,
      },
    });
  }
  return descriptors;
}

function safeMediaUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 16_384) {
    return null;
  }
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.port
      || !(
        host === "work.weixin.qq.com"
        || host.endsWith(".work.weixin.qq.com")
        || host === "wecom.qq.com"
        || host.endsWith(".wecom.qq.com")
        || host === "wework.qpic.cn"
        || host.endsWith(".wework.qpic.cn")
      )
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function inferMimeType(fileName: string | null): string | null {
  switch (path.extname(fileName ?? "").toLowerCase()) {
    case ".txt":
      return "text/plain";
    case ".md":
      return "text/markdown";
    case ".json":
      return "application/json";
    case ".csv":
      return "text/csv";
    case ".pdf":
      return "application/pdf";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    default:
      return null;
  }
}

function weComDate(value: unknown, fallback: Date): Date {
  const numeric = typeof value === "number" ? value : NaN;
  const milliseconds = numeric > 0 && numeric < 10_000_000_000
    ? numeric * 1_000
    : numeric;
  const parsed = new Date(milliseconds);
  return Number.isFinite(parsed.getTime()) ? parsed : fallback;
}

function boundedText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= 1024 * 1024 ? text : null;
}

function boundedId(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const normalized = String(value).trim();
  return normalized
    && normalized.length <= 1_024
    && !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : null;
}

function boundedSecret(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 12_000
    ? normalized
    : null;
}

function boundedMetadata(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
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

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
