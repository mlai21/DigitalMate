import type { NormalizedChannelMessage } from "@/server/channels/types";

type TelegramUpdate = {
  update_id?: number;
  message?: {
    message_id?: number;
    date?: number;
    chat?: { id?: number | string; type?: string; title?: string };
    from?: { id?: number | string; is_bot?: boolean; first_name?: string; username?: string };
    text?: string;
  };
};

type SlackEventEnvelope = {
  type?: string;
  team_id?: string;
  challenge?: string;
  event?: {
    type?: string;
    channel?: string;
    user?: string;
    bot_id?: string;
    text?: string;
    ts?: string;
    channel_type?: string;
  };
};

type FeishuEventEnvelope = {
  schema?: string;
  challenge?: string;
  header?: { event_id?: string; create_time?: string; event_type?: string };
  event?: {
    message?: {
      message_id?: string;
      chat_id?: string;
      chat_type?: string;
      message_type?: string;
      content?: string;
    };
    sender?: { sender_id?: { open_id?: string; union_id?: string; user_id?: string } };
  };
};

type DingTalkEvent = {
  msgId?: string;
  conversationId?: string;
  conversationType?: string | number;
  senderStaffId?: string;
  senderId?: string;
  msgtype?: string;
  text?: { content?: string };
  sessionWebhook?: string;
};

export function normalizeTelegramUpdate(update: TelegramUpdate): NormalizedChannelMessage | null {
  const message = update.message;
  if (!message?.text || message.from?.is_bot) return null;
  const chatId = message.chat?.id;
  const senderId = message.from?.id;
  const messageId = message.message_id;
  if (chatId === undefined || senderId === undefined || messageId === undefined) return null;

  const chatType = message.chat?.type === "private" ? "direct" : "group";
  return {
    channel: "telegram",
    externalMessageId: String(messageId),
    externalConversationId: String(chatId),
    senderId: String(senderId),
    chatType,
    text: message.text,
    occurredAt: new Date((message.date ?? Math.floor(Date.now() / 1000)) * 1000),
    raw: update,
  };
}

export function normalizeSlackEvent(envelope: SlackEventEnvelope): NormalizedChannelMessage | null {
  if (envelope.type !== "event_callback") return null;
  const event = envelope.event;
  if (event?.type !== "message" || event.bot_id || !event.text) return null;
  if (!event.channel || !event.user || !event.ts) return null;

  const chatType = event.channel_type === "im" ? "direct" : "group";
  return {
    channel: "slack",
    externalMessageId: event.ts,
    externalConversationId: event.channel,
    senderId: event.user,
    chatType,
    text: event.text,
    occurredAt: slackTsToDate(event.ts),
    raw: envelope,
  };
}

export function slackTsToDate(ts: string): Date {
  const seconds = Number(ts.split(".")[0] ?? "0");
  return new Date(seconds * 1000);
}

export function normalizeFeishuEvent(envelope: FeishuEventEnvelope): NormalizedChannelMessage | null {
  if (envelope.header?.event_type !== "im.message.receive_v1") return null;
  const message = envelope.event?.message;
  if (!message || message.message_type !== "text") return null;
  const senderId = envelope.event?.sender?.sender_id?.open_id ?? envelope.event?.sender?.sender_id?.union_id ?? envelope.event?.sender?.sender_id?.user_id;
  if (!message.message_id || !message.chat_id || !senderId) return null;
  const text = parseFeishuText(message.content);
  if (!text) return null;
  return {
    channel: "feishu",
    externalMessageId: message.message_id,
    externalConversationId: message.chat_id,
    senderId,
    chatType: message.chat_type === "p2p" ? "direct" : "group",
    text,
    occurredAt: new Date(Number(envelope.header?.create_time ?? Date.now())),
    raw: envelope,
  };
}

export function normalizeDingTalkEvent(payload: DingTalkEvent): NormalizedChannelMessage | null {
  if (payload.msgtype !== "text" || !payload.text?.content) return null;
  if (!payload.msgId || !payload.conversationId) return null;
  return {
    channel: "dingtalk",
    externalMessageId: payload.msgId,
    externalConversationId: payload.conversationId,
    senderId: payload.senderStaffId ?? payload.senderId ?? "unknown",
    chatType: String(payload.conversationType) === "1" ? "direct" : "group",
    text: payload.text.content.trim(),
    occurredAt: new Date(),
    raw: payload,
  };
}

function parseFeishuText(content: string | undefined): string {
  if (!content) return "";
  try {
    const parsed = JSON.parse(content) as { text?: string };
    return parsed.text?.trim() ?? "";
  } catch {
    return content.trim();
  }
}
