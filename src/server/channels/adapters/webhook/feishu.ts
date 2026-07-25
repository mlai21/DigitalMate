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

type FeishuEnvelope = {
  schema?: string;
  header?: {
    event_id?: string;
    create_time?: string;
    event_type?: string;
  };
  event?: {
    message?: {
      message_id?: string;
      root_id?: string;
      parent_id?: string;
      chat_id?: string;
      chat_type?: string;
      message_type?: string;
      content?: string;
      mentions?: unknown[];
    };
    sender?: {
      sender_id?: {
        open_id?: string;
        union_id?: string;
        user_id?: string;
      };
    };
  };
};

export function createFeishuWebhookAdapter() {
  return createWebhookAdapter({
    type: "feishu",
    normalize: normalizeFeishuInbound,
    async send(delivery, context) {
      context.signal.throwIfAborted();
      const appId = readString(context.config.app_id, 4_096);
      const appSecret = readString(
        context.config.app_secret,
        12_000,
      );
      if (!appId || !appSecret) {
        throw new Error("feishu_credential_missing");
      }
      const domain = context.config.domain === "lark"
        ? "https://open.larksuite.com"
        : "https://open.feishu.cn";
      const tokenResponse = await fetch(
        `${domain}/open-apis/auth/v3/tenant_access_token/internal`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            app_id: appId,
            app_secret: appSecret,
          }),
          signal: context.signal,
        },
      );
      const tokenPayload = await requireJsonResponse(
        tokenResponse,
        "feishu_token",
      );
      const accessToken = readString(
        tokenPayload.tenant_access_token,
        12_000,
      );
      if (tokenPayload.code !== 0 || !accessToken) {
        throw new Error("feishu_token_rejected");
      }
      const response = await fetch(
        `${domain}/open-apis/im/v1/messages?receive_id_type=chat_id`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            receive_id:
              delivery.recipient.externalConversationId,
            msg_type: "text",
            content: JSON.stringify({
              text: delivery.body,
            }),
          }),
          signal: context.signal,
        },
      );
      const payload = await requireJsonResponse(
        response,
        "feishu",
      );
      if (payload.code !== 0) {
        throw new Error("feishu_send_rejected");
      }
      const data = payload.data;
      const messageId = (
        data !== null
        && typeof data === "object"
        && "message_id" in data
      )
        ? readString(data.message_id, 1_024)
        : null;
      if (!messageId) {
        throw new Error("feishu_send_response_invalid");
      }
      return {
        externalMessageId: messageId,
        sentAt: context.now(),
        rawSummary: { code: 0 },
      };
    },
  });
}

function normalizeFeishuInbound(
  payload: unknown,
  context: InboundContext,
) {
  const envelope = asRecord(payload) as FeishuEnvelope;
  const message = envelope.event?.message;
  if (
    envelope.header?.event_type !== "im.message.receive_v1"
    || message?.message_type !== "text"
  ) {
    return null;
  }
  const messageId = readString(message.message_id, 1_024);
  const conversationId = readString(message.chat_id, 1_024);
  const sender = envelope.event?.sender?.sender_id;
  const senderId =
    readString(sender?.open_id, 1_024)
    ?? readString(sender?.union_id, 1_024)
    ?? readString(sender?.user_id, 1_024);
  const text = parseFeishuText(message.content);
  if (!messageId || !conversationId || !senderId || !text) {
    return null;
  }
  const direct = message.chat_type === "p2p";
  const rootId = readString(message.root_id, 1_024);
  const parentId = readString(message.parent_id, 1_024);
  return normalizedEvent({
    context,
    channelType: "feishu",
    externalEventId:
      readString(envelope.header?.event_id, 1_024)
      ?? messageId,
    externalConversationId: conversationId,
    externalSenderId: senderId,
    chatType: direct ? "direct" : "group",
    mentioned: direct || Boolean(message.mentions?.length),
    text,
    occurredAt: safeDate(
      Number(envelope.header?.create_time),
      context.receivedAt,
    ),
    thread: {
      ...(rootId ? { externalThreadId: rootId } : {}),
      ...(parentId ? { replyToEventId: parentId } : {}),
    },
    rawSummary: {
      eventType: "im.message.receive_v1",
      platformMessageId: messageId,
      isBotEvent: false,
    },
  });
}

function parseFeishuText(content: unknown): string | null {
  if (typeof content !== "string") return null;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (
      parsed !== null
      && typeof parsed === "object"
      && "text" in parsed
    ) {
      return readString(parsed.text, 1024 * 1024);
    }
  } catch {
    return readString(content, 1024 * 1024);
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
