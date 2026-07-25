import type {
  InboundContext,
} from "@/server/channels/runtime/types";

import {
  createWebhookAdapter,
  normalizedEvent,
  readString,
  safeDate,
} from "./common";

type DingTalkPayload = {
  msgId?: string;
  conversationId?: string;
  conversationType?: string | number;
  senderStaffId?: string;
  senderId?: string;
  msgtype?: string;
  text?: { content?: string };
  sessionWebhook?: string;
  createAt?: number;
  isInAtList?: boolean;
  atUsers?: unknown[];
};

export function createDingTalkWebhookAdapter() {
  return createWebhookAdapter({
    type: "dingtalk",
    normalize: normalizeDingTalkInbound,
    async send(delivery, context) {
      context.signal.throwIfAborted();
      const sessionWebhook = readString(
        delivery.replyHandle?.secretFields.sessionWebhook,
        16_384,
      );
      if (!sessionWebhook || !isAllowedSessionWebhook(sessionWebhook)) {
        throw new Error("dingtalk_reply_handle_missing");
      }
      if (
        delivery.replyHandle?.expiresAt
        && delivery.replyHandle.expiresAt <= context.now()
      ) {
        throw new Error("dingtalk_reply_handle_expired");
      }
      const response = await fetch(sessionWebhook, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          msgtype: "text",
          text: { content: delivery.body },
        }),
        signal: context.signal,
      });
      if (!response.ok) {
        throw new Error(
          `dingtalk_send_http_${response.status}`,
        );
      }
      return {
        externalMessageId:
          `${delivery.id}:${context.now().getTime()}`,
        sentAt: context.now(),
        rawSummary: { status: response.status },
      };
    },
  });
}

function normalizeDingTalkInbound(
  payload: unknown,
  context: InboundContext,
) {
  const event = asRecord(payload) as DingTalkPayload;
  const messageId = readString(event.msgId, 1_024);
  const conversationId = readString(
    event.conversationId,
    1_024,
  );
  const text = readString(event.text?.content, 1024 * 1024);
  if (
    event.msgtype !== "text"
    || !messageId
    || !conversationId
    || !text
  ) {
    return null;
  }
  const senderId =
    readString(event.senderStaffId, 1_024)
    ?? readString(event.senderId, 1_024)
    ?? "unknown";
  const direct = String(event.conversationType) === "1";
  const sessionWebhook = readString(
    event.sessionWebhook,
    16_384,
  );
  const replyHandle = sessionWebhook
    && isAllowedSessionWebhook(sessionWebhook)
    ? {
        publicFields: { conversationId },
        secretFields: { sessionWebhook },
        expiresAt: new Date(
          context.receivedAt.getTime() + 60 * 60_000,
        ),
      }
    : undefined;
  return normalizedEvent({
    context,
    channelType: "dingtalk",
    externalEventId: messageId,
    externalConversationId: conversationId,
    externalSenderId: senderId,
    chatType: direct ? "direct" : "group",
    mentioned:
      direct
      || event.isInAtList === true
      || Boolean(event.atUsers?.length),
    text,
    occurredAt: safeDate(
      Number(event.createAt),
      context.receivedAt,
    ),
    rawSummary: {
      eventType: "text",
      platformMessageId: messageId,
      isBotEvent: false,
      hasReplyHandle: replyHandle !== undefined,
    },
    ...(replyHandle ? { replyHandle } : {}),
  });
}

function isAllowedSessionWebhook(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:"
      && (
        url.hostname === "dingtalk.com"
        || url.hostname.endsWith(".dingtalk.com")
      )
    );
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
