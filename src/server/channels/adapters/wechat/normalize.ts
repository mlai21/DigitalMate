import { createHash } from "node:crypto";
import path from "node:path";

import {
  ATTACHMENT_LIMITS,
  classifyAllowedAttachment,
} from "@/server/attachments/types";
import type {
  InboundAttachmentDescriptor,
  InboundContext,
  NormalizedChannelEvent,
} from "@/server/channels/runtime/types";

import type { WechatConfig } from "./config";

export function normalizeWechatInbound(
  input: unknown,
  context: InboundContext,
  _config?: WechatConfig,
): NormalizedChannelEvent | null {
  void _config;
  const message = record(input);
  if (!message || integer(message.message_type) !== 1) {
    return null;
  }
  const fromUserId = identifier(message.from_user_id);
  const msgId = identifier(message.msg_id);
  const contextToken = token(message.context_token);
  const groupId = identifier(message.group_id);
  if (!fromUserId || (!contextToken && !msgId)) {
    return null;
  }
  const textParts: string[] = [];
  const attachments: InboundAttachmentDescriptor[] = [];
  const items = array(message.item_list);
  for (const [index, value] of items.entries()) {
    const item = record(value);
    if (!item) continue;
    const type = integer(item.type);
    if (type === 1) {
      const text = boundedText(
        string(record(item.text_item)?.text),
      );
      if (text) textParts.push(text);
      continue;
    }
    if (type === 3) {
      const voice = record(item.voice_item);
      const transcript = boundedText(
        string(record(voice?.text_item)?.text)
        || string(voice?.text),
      );
      textParts.push(
        transcript || "[voice: no transcription]",
      );
      continue;
    }
    if (type === 5) {
      textParts.push("[video]");
      continue;
    }
    const descriptor = attachment(
      type,
      item,
      msgId || contextDigest(contextToken),
      index,
    );
    if (descriptor) attachments.push(descriptor);
  }
  if (
    attachments.length > ATTACHMENT_LIMITS.maxCount
  ) {
    return null;
  }
  const text = textParts.join("\n").trim()
    || (attachments.length > 0 ? "[附件]" : "");
  if (!text) return null;
  const eventKey = contextToken
    ? `context:${contextDigest(contextToken)}`
    : `${fromUserId}:${msgId}`;
  const conversationId = groupId || fromUserId;
  return {
    connectionId: context.connectionId,
    agentId: context.agentId,
    channelType: "wechat",
    externalEventId: `wechat:message:${eventKey}`,
    externalConversationId: conversationId,
    externalSenderId: fromUserId,
    chatType: groupId ? "group" : "direct",
    mentioned: true,
    text,
    thread: {},
    attachments,
    occurredAt: messageTime(
      message.create_time_ms ?? message.create_time,
      context.receivedAt,
    ),
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
      platformMessageId: msgId,
      itemCount: items.length,
      chatType: groupId ? "group" : "direct",
      hasContextToken: Boolean(contextToken),
    },
    replyHandle: {
      publicFields: {
        targetId: fromUserId,
        chatType: groupId ? "group" : "direct",
        ...(groupId ? { groupId } : {}),
      },
      secretFields: contextToken
        ? { contextToken }
        : {},
      expiresAt: null,
    },
  };
}

function attachment(
  type: number,
  item: Record<string, unknown>,
  messageId: string,
  index: number,
): InboundAttachmentDescriptor | null {
  const content = type === 2
    ? record(item.image_item)
    : type === 4
      ? record(item.file_item)
      : null;
  if (!content) return null;
  const media = record(content.media);
  const encryptedQueryParam = token(
    media?.encrypt_query_param,
  );
  const aesKey = token(
    type === 2
      ? content.aeskey || media?.aes_key
      : media?.aes_key,
  );
  if (!encryptedQueryParam || !aesKey) return null;
  const fileName = safeFileName(
    type === 2
      ? "image.jpg"
      : string(content.file_name),
  );
  const mimeType = fileName
    ? mimeFromFileName(fileName)
    : null;
  if (
    !fileName
    || !mimeType
    || !classifyAllowedAttachment(fileName, mimeType)
  ) {
    return null;
  }
  return {
    externalAttachmentId: `${messageId}:${index}`,
    fileName,
    mimeType,
    sizeBytes: null,
    source: {
      encryptedQueryParam,
      aesKey,
    },
  };
}

function mimeFromFileName(fileName: string): string | null {
  const extension = path.extname(fileName).toLowerCase();
  return {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".csv": "text/csv",
  }[extension] ?? null;
}

function safeFileName(value: string): string | null {
  const name = path.basename(value.trim());
  return name
    && name.length <= 255
    && !/[\u0000-\u001f\u007f]/u.test(name)
    ? name
    : null;
}

function contextDigest(value: string): string {
  return createHash("sha256")
    .update(value, "utf8")
    .digest("hex");
}

function messageTime(
  value: unknown,
  fallback: Date,
): Date {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  const milliseconds = numeric > 10_000_000_000
    ? numeric
    : numeric * 1_000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function boundedText(value: string): string {
  const normalized = value.trim();
  return normalized.length <= 100_000
    ? normalized
    : normalized.slice(0, 100_000);
}

function identifier(value: unknown): string {
  const normalized = string(value).trim();
  return normalized.length > 0
    && normalized.length <= 512
    && !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : "";
}

function token(value: unknown): string {
  const normalized = string(value).trim();
  return normalized.length > 0
    && normalized.length <= 128 * 1024
    && !normalized.includes("\u0000")
    ? normalized
    : "";
}

function integer(value: unknown): number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    ? value
    : 0;
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function record(
  value: unknown,
): Record<string, unknown> | null {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
