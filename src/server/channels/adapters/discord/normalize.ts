import type {
  InboundAttachmentDescriptor,
  InboundContext,
  NormalizedChannelEvent,
} from "@/server/channels/runtime/types";

type DiscordAuthor = {
  id?: unknown;
  username?: unknown;
  bot?: unknown;
};

type DiscordAttachment = {
  id?: unknown;
  filename?: unknown;
  content_type?: unknown;
  size?: unknown;
  url?: unknown;
};

type DiscordMessage = {
  id?: unknown;
  content?: unknown;
  channel_id?: unknown;
  guild_id?: unknown;
  timestamp?: unknown;
  author?: DiscordAuthor;
  mentions?: Array<{ id?: unknown }>;
  mentioned_bot_role_ids?: unknown;
  mentions_bot?: unknown;
  mention_everyone?: unknown;
  attachments?: DiscordAttachment[];
  channel?: {
    id?: unknown;
    type?: unknown;
    parent_id?: unknown;
  };
  message_reference?: {
    message_id?: unknown;
    channel_id?: unknown;
    guild_id?: unknown;
  };
};

export type DiscordNormalizeOptions = Readonly<{
  botUserId: string | null;
  acceptBotMessages: boolean;
}>;

export function discordEventId(
  payload: unknown,
): string | null {
  const message = asRecord(payload) as DiscordMessage;
  const messageId = primitiveId(message.id);
  return messageId ? `message:${messageId}` : null;
}

export function normalizeDiscordInbound(
  payload: unknown,
  context: InboundContext,
  options: DiscordNormalizeOptions,
): NormalizedChannelEvent | null {
  const message = asRecord(payload) as DiscordMessage;
  const messageId = primitiveId(message.id);
  const channelId = primitiveId(message.channel_id);
  const senderId = primitiveId(message.author?.id);
  const externalEventId = discordEventId(payload);
  if (
    !messageId
    || !channelId
    || !senderId
    || !externalEventId
  ) {
    return null;
  }

  const isSelf = options.botUserId !== null
    && senderId === options.botUserId;
  const isBot = message.author?.bot === true;
  if (
    isSelf
    || (isBot && !options.acceptBotMessages)
  ) {
    return null;
  }

  const attachments = discordAttachments(message.attachments);
  const rawText = readText(message.content);
  const text = stripBotMentions(
    rawText,
    options.botUserId,
    stringIds(message.mentioned_bot_role_ids),
  ) ?? (attachments.length > 0 ? "[附件]" : null);
  if (!text) return null;

  const direct = primitiveId(message.guild_id) === null;
  const threadId = isThread(message.channel)
    ? channelId
    : null;
  const replyTo = primitiveId(
    message.message_reference?.message_id,
  );
  const attachmentPresent = attachments.length > 0;
  return {
    connectionId: context.connectionId,
    agentId: context.agentId,
    channelType: "discord",
    externalEventId,
    externalConversationId: channelId,
    externalSenderId: senderId,
    chatType: direct ? "direct" : "group",
    mentioned:
      direct
      || message.mention_everyone === true
      || message.mentions_bot === true
      || stringIds(message.mentioned_bot_role_ids).length > 0
      || mentionsUser(message.mentions, options.botUserId),
    text,
    thread: {
      ...(threadId ? { externalThreadId: threadId } : {}),
      ...(replyTo ? { replyToEventId: replyTo } : {}),
    },
    attachments,
    occurredAt: safeDiscordDate(
      message.timestamp,
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
      eventType: "message_create",
      platformMessageId: messageId,
      guildId: primitiveId(message.guild_id),
      parentChannelId: primitiveId(message.channel?.parent_id),
      isBotEvent: isBot,
    },
    replyHandle: {
      publicFields: {
        channelId,
        replyToMessageId: messageId,
      },
      secretFields: {},
      expiresAt: null,
    },
  };
}

function discordAttachments(
  values: DiscordAttachment[] | undefined,
): InboundAttachmentDescriptor[] {
  if (!Array.isArray(values)) return [];
  return values.flatMap((attachment) => {
    const id = primitiveId(attachment.id);
    const url = safeAttachmentUrl(attachment.url);
    if (!id || !url) return [];
    return [{
      externalAttachmentId: id,
      fileName: readText(attachment.filename),
      mimeType: readText(attachment.content_type),
      sizeBytes: nonNegativeInteger(attachment.size),
      source: { url },
    }];
  });
}

function safeAttachmentUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 8_192) {
    return null;
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.username.length > 0
      || url.password.length > 0
      || ![
        "cdn.discordapp.com",
        "media.discordapp.net",
      ].includes(url.hostname.toLowerCase())
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function stripBotMentions(
  text: string | null,
  botUserId: string | null,
  roleIds: readonly string[],
): string | null {
  if (!text) return text;
  let output = text;
  if (botUserId) {
    output = output.replace(
      new RegExp(`<@!?${escapeRegExp(botUserId)}>`, "gu"),
      "",
    );
  }
  for (const roleId of roleIds) {
    output = output.replace(
      new RegExp(`<@&${escapeRegExp(roleId)}>`, "gu"),
      "",
    );
  }
  return readText(output);
}

function mentionsUser(
  mentions: Array<{ id?: unknown }> | undefined,
  botUserId: string | null,
): boolean {
  return botUserId !== null
    && Array.isArray(mentions)
    && mentions.some((mention) =>
      primitiveId(mention.id) === botUserId
    );
}

function isThread(
  channel: DiscordMessage["channel"],
): boolean {
  return channel?.type === "thread"
    || channel?.type === 10
    || channel?.type === 11
    || channel?.type === 12;
}

function safeDiscordDate(
  value: unknown,
  fallback: Date,
): Date {
  if (typeof value !== "string") return fallback;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : fallback;
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

function stringIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const id = primitiveId(item);
        return id ? [id] : [];
      })
    : [];
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
