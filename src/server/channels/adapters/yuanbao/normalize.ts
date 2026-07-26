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

import type {
  YuanbaoInboundMessage,
  YuanbaoMessageElement,
} from "./codec";
import type { YuanbaoConfig } from "./config";
import { safeYuanbaoMediaUrl } from "./media";

const YUANBAO_AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".m4a",
  ".ogg",
  ".opus",
  ".silk",
  ".amr",
  ".aac",
  ".flac",
]);

export function normalizeYuanbaoInbound(
  input: unknown,
  context: InboundContext,
  config: YuanbaoConfig,
  botId = "",
): NormalizedChannelEvent | null {
  const inbound = asInbound(input);
  if (!inbound) return null;
  if (
    !config.accept_bot_messages
    && isBotMessage(inbound)
  ) {
    return null;
  }
  const externalMessageId = boundedIdentifier(
    inbound.msgId || inbound.msgKey,
  );
  const senderId = boundedIdentifier(
    inbound.fromAccount,
  );
  if (!externalMessageId || !senderId) return null;

  const group =
    inbound.callbackCommand.startsWith("Group.");
  const groupCode = boundedIdentifier(inbound.groupCode);
  if (group && !groupCode) return null;
  const conversationId = group ? groupCode! : senderId;
  const textParts: string[] = [];
  const attachments: InboundAttachmentDescriptor[] = [];
  let mentioned = !group;

  for (const element of inbound.msgBody) {
    if (element.msgType === "TIMCustomElem") {
      mentioned = mentioned
        || isBotMention(element.msgContent, botId);
      continue;
    }
    if (element.msgType === "TIMTextElem") {
      const text = boundedText(
        string(element.msgContent.text),
      );
      if (text) {
        const withoutMention = botId
          ? text.replaceAll(`@${botId}`, "").trim()
          : text;
        if (withoutMention) textParts.push(withoutMention);
      }
      continue;
    }
    const descriptor = attachmentDescriptor(
      element,
      externalMessageId,
      attachments.length,
    );
    if (descriptor) attachments.push(descriptor);
  }
  if (
    attachments.length > ATTACHMENT_LIMITS.maxCount
    || attachments.reduce(
      (total, attachment) =>
        total + (attachment.sizeBytes ?? 0),
      0,
    ) > ATTACHMENT_LIMITS.maxMessageBytes
  ) {
    return null;
  }

  const quotePrefix = quotedPrefix(
    inbound.cloudCustomData.quote,
  );
  if (quotePrefix) {
    if (textParts.length > 0) {
      textParts[0] = `${quotePrefix}\n${textParts[0]}`;
    } else {
      textParts.push(quotePrefix);
    }
  }
  const text = textParts.join("\n").trim()
    || (attachments.length > 0 ? "[附件]" : "");
  if (!text) return null;
  const occurredAt = eventTime(
    inbound.msgTime,
    context.receivedAt,
  );
  const targetId = group ? groupCode! : senderId;

  return {
    connectionId: context.connectionId,
    agentId: context.agentId,
    channelType: "yuanbao",
    externalEventId:
      `yuanbao:message:${externalMessageId}`,
    externalConversationId: conversationId,
    externalSenderId: senderId,
    chatType: group ? "group" : "direct",
    mentioned,
    text,
    thread: {},
    attachments,
    occurredAt,
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
      callbackCommand: inbound.callbackCommand,
      platformMessageId: externalMessageId,
      msgSeq: inbound.msgSeq,
      chatType: group ? "group" : "direct",
      isBotEvent: isBotMessage(inbound),
    },
    replyHandle: {
      publicFields: {
        chatType: group ? "group" : "direct",
        targetId,
        senderId,
        ...(groupCode ? { groupCode } : {}),
      },
      secretFields: {},
      expiresAt: null,
    },
  };
}

function attachmentDescriptor(
  element: YuanbaoMessageElement,
  messageId: string,
  index: number,
): InboundAttachmentDescriptor | null {
  if (element.msgType === "TIMImageElem") {
    const candidates =
      array(
        element.msgContent.image_info_array
        ?? element.msgContent.imageInfoArray,
      );
    const nestedUrl = candidates
      .map(asRecord)
      .map((item) => string(item.url))
      .find(Boolean);
    const url = safeYuanbaoMediaUrl(
      nestedUrl || string(element.msgContent.url),
    );
    if (!url) return null;
    const fileName = safeFileName(
      fileNameFromUrl(url, "image.jpg"),
    );
    const mimeType = imageMime(fileName);
    if (
      !fileName
      || !mimeType
      || !classifyAllowedAttachment(
        fileName,
        mimeType,
      )
    ) {
      return null;
    }
    return {
      externalAttachmentId: `${messageId}:${index}`,
      fileName,
      mimeType,
      sizeBytes: nestedSize(candidates),
      source: {
        resourceUrl: url,
      },
    };
  }
  if (element.msgType !== "TIMFileElem") return null;
  const url = safeYuanbaoMediaUrl(
    string(element.msgContent.url),
  );
  const fileName = safeFileName(
    string(
      element.msgContent.file_name
      ?? element.msgContent.fileName,
    ),
  );
  const mimeType = fileName
    ? fileMime(fileName)
    : null;
  if (
    !url
    || !fileName
    || !mimeType
    || !classifyAllowedAttachment(fileName, mimeType)
  ) {
    return null;
  }
  return {
    externalAttachmentId: `${messageId}:${index}`,
    fileName,
    mimeType,
    sizeBytes: safeSize(
      element.msgContent.file_size
      ?? element.msgContent.fileSize,
    ),
    source: {
      resourceUrl: url,
    },
  };
}

function isBotMention(
  content: Readonly<Record<string, unknown>>,
  botId: string,
): boolean {
  if (!botId) return false;
  const data = parseJsonRecord(content.data);
  return integer(data.elem_type ?? data.elemType) === 1002
    && string(data.user_id ?? data.userId) === botId;
}

function isBotMessage(
  inbound: YuanbaoInboundMessage,
): boolean {
  if (inbound.fromAccount.startsWith("bot_")) {
    return true;
  }
  return inbound.msgBody.some((element) => {
    if (element.msgType !== "TIMTextElem") return false;
    const data = parseJsonRecord(
      element.msgContent.data,
    );
    return integer(
      data.elem_type ?? data.elemType,
    ) === 1013;
  });
}

function quotedPrefix(value: unknown): string | null {
  const quote = asRecord(value);
  if (Object.keys(quote).length === 0) return null;
  const type = integer(quote.type);
  const description = boundedText(string(quote.desc));
  const label = type === 2
    ? "image"
    : type === 3
      ? (
          description
          && YUANBAO_AUDIO_EXTENSIONS.has(
            path.extname(description).toLowerCase(),
          )
            ? "audio"
            : "file"
        )
      : "message";
  return description
    ? `[quoted ${label}: ${description}]`
    : `[quoted ${label}]`;
}

function asInbound(
  value: unknown,
): YuanbaoInboundMessage | null {
  const input = asRecord(value);
  const inbound = asRecord(
    Object.hasOwn(input, "inbound")
      ? input.inbound
      : value,
  );
  const rawBody = array(inbound.msgBody);
  const callbackCommand = string(
    inbound.callbackCommand,
  );
  if (!callbackCommand || rawBody.length > 64) return null;
  return {
    callbackCommand,
    fromAccount: string(inbound.fromAccount),
    toAccount: string(inbound.toAccount),
    senderNickname: string(inbound.senderNickname),
    groupCode: string(inbound.groupCode),
    groupName: string(inbound.groupName),
    msgSeq: integer(inbound.msgSeq),
    msgTime: integer(inbound.msgTime),
    msgKey: string(inbound.msgKey),
    msgId: string(inbound.msgId),
    msgBody: rawBody.map((item) => {
      const element = asRecord(item);
      return {
        msgType: string(element.msgType),
        msgContent: asRecord(element.msgContent),
      };
    }),
    cloudCustomData: asRecord(
      inbound.cloudCustomData,
    ),
    botOwnerId: string(inbound.botOwnerId),
    clawMsgType: integer(inbound.clawMsgType),
  };
}

function safeYuanbaoHost(hostname: string): boolean {
  return [
    "qq.com",
    "qcloud.com",
    "myqcloud.com",
    "tencent.com",
  ].some((suffix) =>
    hostname === suffix || hostname.endsWith(`.${suffix}`)
  );
}

function safeFileName(value: string): string | null {
  const normalized = path
    .basename(value.replaceAll("\\", "/"))
    .trim();
  return normalized
    && normalized.length <= 255
    && !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : null;
}

function fileNameFromUrl(
  value: string,
  fallback: string,
): string {
  try {
    const parsed = new URL(value);
    if (!safeYuanbaoHost(parsed.hostname)) return fallback;
    return decodeURIComponent(
      path.basename(parsed.pathname),
    ) || fallback;
  } catch {
    return fallback;
  }
}

function imageMime(fileName: string | null): string | null {
  if (!fileName) return null;
  const extension = path.extname(fileName).toLowerCase();
  return extension === ".png"
    ? "image/png"
    : extension === ".webp"
      ? "image/webp"
      : [".jpg", ".jpeg"].includes(extension)
        ? "image/jpeg"
        : null;
}

function fileMime(fileName: string): string | null {
  const extension = path.extname(fileName).toLowerCase();
  return extension === ".pdf"
    ? "application/pdf"
    : extension === ".txt"
      ? "text/plain"
      : extension === ".md"
        ? "text/markdown"
        : extension === ".json"
          ? "application/json"
          : extension === ".csv"
            ? "text/csv"
            : imageMime(fileName);
}

function nestedSize(values: unknown[]): number | null {
  for (const value of values) {
    const item = asRecord(value);
    const size = safeSize(item.size);
    if (size !== null) return size;
  }
  return null;
}

function safeSize(value: unknown): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && value <= ATTACHMENT_LIMITS.maxFileBytes
    ? value
    : null;
}

function eventTime(
  seconds: number,
  fallback: Date,
): Date {
  if (
    !Number.isSafeInteger(seconds)
    || seconds <= 0
  ) {
    return fallback;
  }
  const value = new Date(seconds * 1_000);
  return Number.isFinite(value.getTime())
    ? value
    : fallback;
}

function parseJsonRecord(
  value: unknown,
): Record<string, unknown> {
  if (typeof value !== "string" || !value) return {};
  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return {};
  }
}

function asRecord(
  value: unknown,
): Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function integer(value: unknown): number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    ? value
    : 0;
}

function boundedIdentifier(value: string): string | null {
  const normalized = value.trim();
  return normalized
    && normalized.length <= 512
    && !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : null;
}

function boundedText(value: string): string {
  const normalized = value.trim();
  return normalized.length <= 1024 * 1024
    ? normalized
    : "";
}
