import type {
  InboundAttachmentDescriptor,
  InboundContext,
  NormalizedChannelEvent,
} from "@/server/channels/runtime/types";

type TelegramFile = {
  file_id?: unknown;
  file_unique_id?: unknown;
  file_name?: unknown;
  mime_type?: unknown;
  file_size?: unknown;
};

type TelegramPhoto = TelegramFile & {
  width?: unknown;
  height?: unknown;
};

type TelegramMessage = {
  message_id?: unknown;
  message_thread_id?: unknown;
  date?: unknown;
  chat?: {
    id?: unknown;
    type?: unknown;
  };
  from?: {
    id?: unknown;
    is_bot?: unknown;
  };
  text?: unknown;
  caption?: unknown;
  entities?: Array<{ type?: unknown }>;
  caption_entities?: Array<{ type?: unknown }>;
  reply_to_message?: { message_id?: unknown };
  document?: TelegramFile;
  photo?: TelegramPhoto[];
};

type TelegramUpdate = {
  update_id?: unknown;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
};

export function telegramEventId(
  payload: unknown,
): string | null {
  const update = asRecord(payload) as TelegramUpdate;
  const updateId = primitiveId(update.update_id);
  if (updateId) return `update:${updateId}`;
  const message = update.message ?? update.edited_message;
  const chatId = primitiveId(message?.chat?.id);
  const messageId = primitiveId(message?.message_id);
  return chatId && messageId
    ? `message:${chatId}:${messageId}`
    : null;
}

export function normalizeTelegramInbound(
  payload: unknown,
  context: InboundContext,
): NormalizedChannelEvent | null {
  const update = asRecord(payload) as TelegramUpdate;
  const message = update.message ?? update.edited_message;
  if (!message || message.from?.is_bot === true) return null;

  const attachments = telegramAttachments(message);
  const text = readText(message.text)
    ?? readText(message.caption)
    ?? (attachments.length > 0 ? "[附件]" : null);
  const chatId = primitiveId(message.chat?.id);
  const senderId = primitiveId(message.from?.id);
  const messageId = primitiveId(message.message_id);
  const externalEventId = telegramEventId(payload);
  if (
    !text
    || !chatId
    || !senderId
    || !messageId
    || !externalEventId
  ) {
    return null;
  }

  const direct = message.chat?.type === "private";
  const threadId = primitiveId(message.message_thread_id);
  const replyTo = primitiveId(
    message.reply_to_message?.message_id,
  );
  const attachmentPresent = attachments.length > 0;
  return {
    connectionId: context.connectionId,
    agentId: context.agentId,
    channelType: "telegram",
    externalEventId,
    externalConversationId: chatId,
    externalSenderId: senderId,
    chatType: direct ? "direct" : "group",
    mentioned: direct || hasMention(message),
    text,
    thread: {
      ...(threadId ? { externalThreadId: threadId } : {}),
      ...(replyTo ? { replyToEventId: replyTo } : {}),
    },
    attachments,
    occurredAt: safeTelegramDate(
      message.date,
      context.receivedAt,
    ),
    receivedAt: context.receivedAt,
    permission: {
      webSearch: false,
      backgroundNetwork: false,
      tools: false,
      skills: !attachmentPresent && text.trimStart().startsWith("/")
        ? "explicit_slash"
        : "none",
      attachmentsPresent: attachmentPresent,
    },
    rawSummary: {
      eventType: update.edited_message
        ? "edited_message"
        : "message",
      platformMessageId: messageId,
      updateId: primitiveId(update.update_id),
      isBotEvent: false,
    },
  };
}

function telegramAttachments(
  message: TelegramMessage,
): InboundAttachmentDescriptor[] {
  const output: InboundAttachmentDescriptor[] = [];
  if (message.document) {
    const descriptor = fileDescriptor(message.document, {
      fallbackName: "telegram-file",
      fallbackMime: null,
    });
    if (descriptor) output.push(descriptor);
  }

  const photo = largestPhoto(message.photo);
  if (photo) {
    const descriptor = fileDescriptor(photo, {
      fallbackName: "telegram-photo.jpg",
      fallbackMime: "image/jpeg",
    });
    if (descriptor) output.push(descriptor);
  }
  return output;
}

function fileDescriptor(
  file: TelegramFile,
  fallback: Readonly<{
    fallbackName: string;
    fallbackMime: string | null;
  }>,
): InboundAttachmentDescriptor | null {
  const fileId = primitiveId(file.file_id);
  const uniqueId = primitiveId(file.file_unique_id);
  if (!fileId || !uniqueId) return null;
  return {
    externalAttachmentId: uniqueId,
    fileName: readText(file.file_name) ?? fallback.fallbackName,
    mimeType: readText(file.mime_type) ?? fallback.fallbackMime,
    sizeBytes: nonNegativeInteger(file.file_size),
    source: { fileId },
  };
}

function largestPhoto(
  photos: TelegramPhoto[] | undefined,
): TelegramPhoto | null {
  if (!Array.isArray(photos) || photos.length === 0) return null;
  return [...photos].sort((left, right) =>
    photoArea(right) - photoArea(left)
  )[0] ?? null;
}

function photoArea(photo: TelegramPhoto): number {
  return (nonNegativeInteger(photo.width) ?? 0)
    * (nonNegativeInteger(photo.height) ?? 0);
}

function hasMention(message: TelegramMessage): boolean {
  return [
    ...(message.entities ?? []),
    ...(message.caption_entities ?? []),
  ].some((entity) =>
    entity.type === "mention"
    || entity.type === "text_mention"
  );
}

function safeTelegramDate(
  seconds: unknown,
  fallback: Date,
): Date {
  const numeric = typeof seconds === "number" ? seconds : NaN;
  const date = new Date(numeric * 1_000);
  return Number.isFinite(date.getTime()) ? date : fallback;
}

function readText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 1024 * 1024
    ? normalized
    : null;
}

function primitiveId(value: unknown): string | null {
  if (
    typeof value !== "string"
    && typeof value !== "number"
  ) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized.length > 0 && normalized.length <= 1_024
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
