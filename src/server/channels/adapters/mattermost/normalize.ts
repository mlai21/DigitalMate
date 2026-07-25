import type {
  InboundAttachmentDescriptor,
  InboundContext,
  NormalizedChannelEvent,
} from "@/server/channels/runtime/types";

type MattermostPost = {
  id?: unknown;
  channel_id?: unknown;
  user_id?: unknown;
  message?: unknown;
  create_at?: unknown;
  root_id?: unknown;
  file_ids?: unknown;
};

type MattermostEvent = {
  event?: unknown;
  seq?: unknown;
  data?: {
    channel_type?: unknown;
    post?: unknown;
  };
  broadcast?: {
    channel_id?: unknown;
    user_id?: unknown;
    team_id?: unknown;
  };
};

export type MattermostNormalizeOptions = Readonly<{
  botUserId: string | null;
  botUsername: string | null;
  threadFollowWithoutMention: boolean;
  followedThreadIds: ReadonlySet<string>;
}>;

export function mattermostEventId(
  payload: unknown,
): string | null {
  const event = asRecord(payload) as MattermostEvent;
  const post = parsePost(event.data?.post);
  const postId = primitiveId(post?.id);
  return postId ? `post:${postId}` : null;
}

export function mattermostSequence(
  payload: unknown,
): number | null {
  const sequence = (asRecord(payload) as MattermostEvent).seq;
  return typeof sequence === "number"
    && Number.isSafeInteger(sequence)
    && sequence >= 0
    ? sequence
    : null;
}

export function normalizeMattermostInbound(
  payload: unknown,
  context: InboundContext,
  options: MattermostNormalizeOptions,
): NormalizedChannelEvent | null {
  const event = asRecord(payload) as MattermostEvent;
  if (event.event !== "posted") return null;
  const post = parsePost(event.data?.post);
  if (!post) return null;

  const postId = primitiveId(post.id);
  const channelId = primitiveId(post.channel_id)
    ?? primitiveId(event.broadcast?.channel_id);
  const senderId = primitiveId(post.user_id)
    ?? primitiveId(event.broadcast?.user_id);
  const externalEventId = mattermostEventId(payload);
  if (
    !postId
    || !channelId
    || !senderId
    || !externalEventId
    || senderId === options.botUserId
  ) {
    return null;
  }

  const attachments = mattermostAttachments(post.file_ids);
  const rawText = readText(post.message);
  const text = stripMattermostMention(
    rawText,
    options.botUsername,
  ) ?? (attachments.length > 0 ? "[附件]" : null);
  if (!text) return null;

  const direct = event.data?.channel_type === "D";
  const rootId = primitiveId(post.root_id);
  const followedThread = Boolean(
    rootId
    && options.threadFollowWithoutMention
    && options.followedThreadIds.has(rootId),
  );
  const attachmentPresent = attachments.length > 0;
  return {
    connectionId: context.connectionId,
    agentId: context.agentId,
    channelType: "mattermost",
    externalEventId,
    externalConversationId: channelId,
    externalSenderId: senderId,
    chatType: direct ? "direct" : "group",
    mentioned:
      direct
      || mentionsUsername(rawText, options.botUsername)
      || followedThread,
    text,
    thread: {
      ...(rootId
        ? {
            externalThreadId: rootId,
            replyToEventId: rootId,
          }
        : {}),
    },
    attachments,
    occurredAt: mattermostDate(
      post.create_at,
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
      eventType: "posted",
      platformPostId: postId,
      teamId: primitiveId(event.broadcast?.team_id),
      sequence: mattermostSequence(payload),
      isBotEvent: false,
    },
    replyHandle: {
      publicFields: {
        channelId,
        ...(rootId ? { rootId } : {}),
      },
      secretFields: {},
      expiresAt: null,
    },
  };
}

function parsePost(value: unknown): MattermostPost | null {
  if (typeof value !== "string" || value.length > 2 * 1024 * 1024) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return asRecord(parsed) as MattermostPost;
  } catch {
    return null;
  }
}

function mattermostAttachments(
  value: unknown,
): InboundAttachmentDescriptor[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const fileId = primitiveId(item);
    return fileId
      ? [{
          externalAttachmentId: fileId,
          fileName: null,
          mimeType: null,
          sizeBytes: null,
          source: { fileId },
        }]
      : [];
  });
}

function mentionsUsername(
  text: string | null,
  username: string | null,
): boolean {
  return Boolean(
    text
    && username
    && new RegExp(
      `(^|\\s)@${escapeRegExp(username)}(?=\\s|$|[.,!?，。！？])`,
      "iu",
    ).test(text),
  );
}

function stripMattermostMention(
  text: string | null,
  username: string | null,
): string | null {
  if (!text || !username) return text;
  return readText(
    text.replace(
      new RegExp(
        `(^|\\s)@${escapeRegExp(username)}(?=\\s|$|[.,!?，。！？])`,
        "giu",
      ),
      "$1",
    ),
  );
}

function mattermostDate(
  value: unknown,
  fallback: Date,
): Date {
  const timestamp = typeof value === "number" ? value : NaN;
  const parsed = new Date(timestamp);
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
