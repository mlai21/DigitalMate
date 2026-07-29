import type {
  InboundAttachmentDescriptor,
  InboundContext,
  NormalizedChannelEvent,
} from "@/server/channels/runtime/types";

type FeishuOptions = Readonly<{
  botOpenId: string | null;
  shareSessionInGroup: boolean;
}>;

export function normalizeFeishuInbound(
  payload: unknown,
  context: InboundContext,
  options: FeishuOptions,
): NormalizedChannelEvent | null {
  const root = asRecord(payload);
  const header = asRecord(root.header);
  const event = asRecord(root.event ?? root);
  const sender = asRecord(event.sender);
  const senderId = primitiveId(
    asRecord(sender.sender_id).open_id,
  );
  const message = asRecord(event.message);
  const eventId = primitiveId(header.event_id ?? root.event_id);
  const messageId = primitiveId(message.message_id);
  const chatId = primitiveId(message.chat_id);
  if (!eventId || !messageId || !chatId || !senderId) return null;
  if (senderId === options.botOpenId) return null;

  const type = primitiveId(message.message_type);
  const content = parseContent(message.content);
  const attachments = mediaDescriptors(type, content, messageId);
  const text = messageText(type, content)
    ?? (attachments.length > 0 ? "[附件]" : null);
  if (!text) return null;
  const direct = message.chat_type === "p2p";
  const mentions = Array.isArray(message.mentions)
    ? message.mentions.map(asRecord)
    : [];
  const mentioned = direct || mentions.some((mention) =>
    primitiveId(asRecord(mention.id).open_id)
      === options.botOpenId
  );
  const conversationId =
    !direct && !options.shareSessionInGroup
      ? `${chatId}:${senderId}`
      : chatId;
  const rootId = primitiveId(message.root_id ?? message.thread_id);
  const attachmentPresent = attachments.length > 0;
  return {
    connectionId: context.connectionId,
    agentId: context.agentId,
    channelType: "feishu",
    externalEventId: `event:${eventId}`,
    externalConversationId: conversationId,
    externalSenderId: senderId,
    chatType: direct ? "direct" : "group",
    mentioned,
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
    occurredAt: safeDate(
      message.create_time ?? header.create_time,
      context.receivedAt,
    ),
    receivedAt: context.receivedAt,
    permission: {
      webSearch: false,
      backgroundNetwork: false,
      tools: false,
      skills: !attachmentPresent && text.startsWith("/")
        ? "explicit_slash"
        : "none",
      attachmentsPresent: attachmentPresent,
    },
    rawSummary: {
      eventType: "im.message.receive_v1",
      platformMessageId: messageId,
      messageType: type,
      isBotEvent: false,
    },
    replyHandle: {
      publicFields: { chatId, messageId },
      secretFields: {},
      expiresAt: null,
    },
  };
}

function messageText(
  type: string | null,
  content: Record<string, unknown>,
): string | null {
  if (type === "text") return readText(content.text);
  // Formatted content — pasted lists, links, text around an inline image —
  // arrives as `post`, not `text`. Without this the body normalized to empty and
  // the whole message was discarded before it reached an agent turn, which reads
  // to the user as the bot ignoring them.
  if (type === "post") return readPostText(content);
  return null;
}

/**
 * `content_v2` keeps the author's markdown (lists, quotes) that `content`
 * flattens into plain text runs, so it wins when the platform sends both.
 */
function readPostText(content: Record<string, unknown>): string | null {
  const lines = postParagraphs(
    Array.isArray(content.content_v2) ? content.content_v2 : content.content,
  )
    .map((paragraph) => paragraph.map(postElementText).join(""))
    .filter((line) => line.trim());
  const title = readText(content.title);
  return readText([...(title ? [title] : []), ...lines].join("\n"));
}

function postElementText(element: Record<string, unknown>): string {
  const tag = primitiveId(element.tag);
  if (tag === "text" || tag === "md" || tag === "code_block") {
    return typeof element.text === "string" ? element.text : "";
  }
  if (tag === "a") {
    const label = typeof element.text === "string" ? element.text : "";
    const href = typeof element.href === "string" ? element.href : "";
    return href ? `[${label || href}](${href})` : label;
  }
  if (tag === "at") {
    // The inbound `user_id` is an opaque open_id or a `@_user_N` placeholder;
    // only a resolved display name carries meaning in the body.
    const name = readText(element.user_name);
    return name ? `@${name}` : "";
  }
  return "";
}

function postParagraphs(value: unknown): Record<string, unknown>[][] {
  return Array.isArray(value)
    ? value
        .filter((paragraph): paragraph is unknown[] => Array.isArray(paragraph))
        .map((paragraph) => paragraph.map(asRecord))
    : [];
}

/** Bounds the work one inbound message can queue up. */
const POST_IMAGE_LIMIT = 9;

function postImageDescriptors(
  content: Record<string, unknown>,
  messageId: string,
): InboundAttachmentDescriptor[] {
  const images = new Map<string, InboundAttachmentDescriptor>();
  // Scanned across both renderings because the platform may carry the img tag in
  // only one of them, and the same image_key legitimately repeats.
  for (const source of [content.content, content.content_v2]) {
    for (const paragraph of postParagraphs(source)) {
      for (const element of paragraph) {
        if (images.size >= POST_IMAGE_LIMIT) return [...images.values()];
        if (primitiveId(element.tag) !== "img") continue;
        const key = primitiveId(element.image_key);
        if (!key || images.has(key)) continue;
        images.set(key, {
          externalAttachmentId: key,
          fileName: "feishu-image.jpg",
          mimeType: "image/jpeg",
          sizeBytes: null,
          source: {
            messageId,
            imageKey: key,
            resourceType: "image",
          },
        });
      }
    }
  }
  return [...images.values()];
}

function mediaDescriptors(
  type: string | null,
  content: Record<string, unknown>,
  messageId: string,
): InboundAttachmentDescriptor[] {
  if (type === "post") return postImageDescriptors(content, messageId);
  if (type !== "file" && type !== "image") return [];
  const key = primitiveId(
    type === "image" ? content.image_key : content.file_key,
  );
  if (!key) return [];
  return [{
    externalAttachmentId: key,
    fileName: readText(content.file_name)
      ?? (type === "image" ? "feishu-image.jpg" : null),
    mimeType: type === "image" ? "image/jpeg" : null,
    sizeBytes: null,
    source: {
      messageId,
      [type === "image" ? "imageKey" : "fileKey"]: key,
      resourceType: type,
    },
  }];
}

function parseContent(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.length > 2 * 1024 * 1024) {
    return {};
  }
  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return {};
  }
}

function safeDate(value: unknown, fallback: Date): Date {
  const numeric = Number(value);
  const date = new Date(numeric);
  return Number.isFinite(date.getTime()) ? date : fallback;
}

function readText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= 1024 * 1024 ? text : null;
}

function primitiveId(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const id = String(value).trim();
  return id && id.length <= 1_024 ? id : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
