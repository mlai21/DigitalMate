import type {
  InboundContext,
} from "@/server/channels/runtime/types";

import {
  createWebhookAdapter,
  normalizedEvent,
  readString,
  requireJsonResponse,
  safeDate,
} from "./common";

type TelegramUpdate = {
  update_id?: number;
  message?: {
    message_id?: number;
    message_thread_id?: number;
    date?: number;
    chat?: { id?: number | string; type?: string };
    from?: { id?: number | string; is_bot?: boolean };
    text?: string;
    entities?: Array<{ type?: string }>;
    reply_to_message?: { message_id?: number };
  };
};

export function createTelegramWebhookAdapter() {
  return createWebhookAdapter({
    type: "telegram",
    normalize: normalizeTelegramInbound,
    async send(delivery, context) {
      context.signal.throwIfAborted();
      const token = readString(context.config.bot_token, 12_000);
      if (!token) throw new Error("telegram_credential_missing");
      const configuredBase = readString(
        context.config.base_url,
        4_096,
      );
      const baseUrl = (
        configuredBase || "https://api.telegram.org"
      ).replace(/\/+$/, "");
      const response = await fetch(
        `${baseUrl}/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            chat_id:
              delivery.recipient.externalConversationId,
            text: delivery.body,
            ...(delivery.recipient.externalThreadId
              ? {
                  message_thread_id:
                    delivery.recipient.externalThreadId,
                }
              : {}),
          }),
          signal: context.signal,
        },
      );
      const payload = await requireJsonResponse(
        response,
        "telegram",
      );
      if (payload.ok !== true) {
        throw new Error("telegram_send_rejected");
      }
      const result = payload.result;
      const messageId = (
        result !== null
        && typeof result === "object"
        && "message_id" in result
      )
        ? String(result.message_id)
        : null;
      if (!messageId) {
        throw new Error("telegram_send_response_invalid");
      }
      return {
        externalMessageId: messageId,
        sentAt: context.now(),
        rawSummary: { ok: true },
      };
    },
  });
}

function normalizeTelegramInbound(
  payload: unknown,
  context: InboundContext,
) {
  const update = asRecord(payload) as TelegramUpdate;
  const message = update.message;
  const text = readString(message?.text, 1024 * 1024);
  if (!message || !text || message.from?.is_bot === true) {
    return null;
  }
  const chatId = primitiveId(message.chat?.id);
  const senderId = primitiveId(message.from?.id);
  const messageId = primitiveId(message.message_id);
  if (!chatId || !senderId || !messageId) return null;
  const direct = message.chat?.type === "private";
  const updateId = primitiveId(update.update_id);
  const threadId = primitiveId(message.message_thread_id);
  const replyTo = primitiveId(
    message.reply_to_message?.message_id,
  );
  return normalizedEvent({
    context,
    channelType: "telegram",
    externalEventId:
      updateId
        ? `update:${updateId}`
        : `message:${chatId}:${messageId}`,
    externalConversationId: chatId,
    externalSenderId: senderId,
    chatType: direct ? "direct" : "group",
    mentioned: direct || Boolean(
      message.entities?.some((entity) =>
        entity.type === "mention"
        || entity.type === "text_mention"
      ),
    ),
    text,
    occurredAt: safeDate(
      Number(message.date) * 1_000,
      context.receivedAt,
    ),
    thread: {
      ...(threadId ? { externalThreadId: threadId } : {}),
      ...(replyTo ? { replyToEventId: replyTo } : {}),
    },
    rawSummary: {
      eventType: "message",
      platformMessageId: messageId,
      isBotEvent: false,
    },
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function primitiveId(value: unknown): string | null {
  return (
    typeof value === "string"
    || typeof value === "number"
  )
    ? readString(String(value), 1_024)
    : null;
}
