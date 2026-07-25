import type {
  InboundAttachmentDescriptor,
  InboundContext,
  NormalizedChannelEvent,
} from "@/server/channels/runtime/types";

type SlackFile = {
  id?: unknown;
  name?: unknown;
  title?: unknown;
  mimetype?: unknown;
  size?: unknown;
};

type SlackMessageEvent = {
  type?: unknown;
  subtype?: unknown;
  channel?: unknown;
  channel_type?: unknown;
  user?: unknown;
  text?: unknown;
  ts?: unknown;
  event_ts?: unknown;
  thread_ts?: unknown;
  bot_id?: unknown;
  bot_profile?: unknown;
  files?: SlackFile[];
};

type SlackEnvelope = {
  envelope_id?: unknown;
  event_id?: unknown;
  event_time?: unknown;
  team_id?: unknown;
  event?: SlackMessageEvent;
};

export type SlackNormalizeOptions = Readonly<{
  botUserId: string | null;
  botId: string | null;
}>;

export function slackEventId(payload: unknown): string | null {
  const envelope = asRecord(payload) as SlackEnvelope;
  const eventId = primitiveId(envelope.event_id);
  const eventTs = primitiveId(
    envelope.event?.event_ts ?? envelope.event?.ts,
  );
  return eventId && eventTs
    ? `event:${eventId}:${eventTs}`
    : null;
}

export function normalizeSlackInbound(
  payload: unknown,
  context: InboundContext,
  options: SlackNormalizeOptions,
): NormalizedChannelEvent | null {
  const envelope = asRecord(payload) as SlackEnvelope;
  const event = envelope.event;
  if (
    !event
    || event.type !== "message"
    || isIgnoredSubtype(event.subtype)
    || primitiveId(event.bot_id) !== null
    || event.bot_profile !== undefined
  ) {
    return null;
  }

  const senderId = primitiveId(event.user);
  const channel = primitiveId(event.channel);
  const eventTs = primitiveId(event.event_ts ?? event.ts);
  const externalEventId = slackEventId(payload);
  if (
    !senderId
    || !channel
    || !eventTs
    || !externalEventId
    || senderId === options.botUserId
    || primitiveId(event.bot_id) === options.botId
  ) {
    return null;
  }

  const attachments = slackAttachments(event.files);
  const rawText = readText(event.text);
  const text = stripSlackMention(
    rawText,
    options.botUserId,
  ) ?? (attachments.length > 0 ? "[附件]" : null);
  if (!text) return null;

  const direct = event.channel_type === "im";
  const threadTs = primitiveId(event.thread_ts);
  const attachmentPresent = attachments.length > 0;
  return {
    connectionId: context.connectionId,
    agentId: context.agentId,
    channelType: "slack",
    externalEventId,
    externalConversationId: channel,
    externalSenderId: senderId,
    chatType: direct ? "direct" : "group",
    mentioned:
      direct
      || mentionsBot(rawText, options.botUserId),
    text,
    thread: {
      ...(threadTs
        ? {
            externalThreadId: threadTs,
            replyToEventId: threadTs,
          }
        : {}),
    },
    attachments,
    occurredAt: slackTimestamp(
      eventTs,
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
      eventType: "message",
      platformEventId: primitiveId(envelope.event_id),
      platformMessageId: eventTs,
      teamId: primitiveId(envelope.team_id),
      subtype: primitiveId(event.subtype),
      isBotEvent: false,
    },
    replyHandle: {
      publicFields: {
        channel,
        ...(threadTs ? { threadTs } : {}),
      },
      secretFields: {},
      expiresAt: null,
    },
  };
}

function slackAttachments(
  files: SlackFile[] | undefined,
): InboundAttachmentDescriptor[] {
  if (!Array.isArray(files)) return [];
  return files.flatMap((file) => {
    const id = primitiveId(file.id);
    if (!id) return [];
    return [{
      externalAttachmentId: id,
      fileName: readText(file.name) ?? readText(file.title),
      mimeType: readText(file.mimetype),
      sizeBytes: nonNegativeInteger(file.size),
      source: { fileId: id },
    }];
  });
}

function isIgnoredSubtype(value: unknown): boolean {
  const subtype = primitiveId(value);
  return subtype !== null && subtype !== "file_share";
}

function mentionsBot(
  text: string | null,
  botUserId: string | null,
): boolean {
  return Boolean(
    text
    && botUserId
    && text.includes(`<@${botUserId}>`),
  );
}

function stripSlackMention(
  text: string | null,
  botUserId: string | null,
): string | null {
  if (!text || !botUserId) return text;
  return readText(
    text.replace(
      new RegExp(`<@${escapeRegExp(botUserId)}>`, "gu"),
      "",
    ),
  );
}

function slackTimestamp(
  value: string,
  fallback: Date,
): Date {
  const seconds = Number(value);
  const parsed = new Date(seconds * 1_000);
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
