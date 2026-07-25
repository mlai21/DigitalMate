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

type SlackEnvelope = {
  type?: string;
  event_id?: string;
  team_id?: string;
  event?: {
    type?: string;
    channel?: string;
    user?: string;
    bot_id?: string;
    subtype?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
    channel_type?: string;
  };
};

export function createSlackWebhookAdapter() {
  return createWebhookAdapter({
    type: "slack",
    normalize: normalizeSlackInbound,
    async send(delivery, context) {
      context.signal.throwIfAborted();
      const token = readString(context.config.bot_token, 12_000);
      if (!token) throw new Error("slack_credential_missing");
      const response = await fetch(
        "https://slack.com/api/chat.postMessage",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            channel:
              delivery.recipient.externalConversationId,
            text: delivery.body,
            ...(delivery.recipient.externalThreadId
              ? { thread_ts: delivery.recipient.externalThreadId }
              : {}),
          }),
          signal: context.signal,
        },
      );
      const payload = await requireJsonResponse(response, "slack");
      if (payload.ok !== true) {
        throw new Error("slack_send_rejected");
      }
      const messageId = readString(payload.ts, 1_024);
      if (!messageId) {
        throw new Error("slack_send_response_invalid");
      }
      return {
        externalMessageId: messageId,
        sentAt: context.now(),
        rawSummary: { ok: true },
      };
    },
  });
}

export function slackTimestampToDate(
  timestamp: string,
  fallback: Date,
): Date {
  const [secondsText, fraction = ""] = timestamp.split(".");
  const seconds = Number(secondsText);
  const milliseconds = Number(
    fraction.slice(0, 3).padEnd(3, "0"),
  );
  return safeDate(
    seconds * 1_000 + milliseconds,
    fallback,
  );
}

function normalizeSlackInbound(
  payload: unknown,
  context: InboundContext,
) {
  const envelope = asRecord(payload) as SlackEnvelope;
  const event = envelope.event;
  const text = readString(event?.text, 1024 * 1024);
  if (
    envelope.type !== "event_callback"
    || event?.type !== "message"
    || event.bot_id
    || event.subtype === "bot_message"
    || !text
  ) {
    return null;
  }
  const conversationId = readString(event.channel, 1_024);
  const senderId = readString(event.user, 1_024);
  const messageId = readString(event.ts, 1_024);
  if (!conversationId || !senderId || !messageId) return null;
  const direct = event.channel_type === "im";
  const threadId = readString(event.thread_ts, 1_024);
  return normalizedEvent({
    context,
    channelType: "slack",
    externalEventId:
      readString(envelope.event_id, 1_024)
      ?? `${envelope.team_id ?? "team"}:${messageId}`,
    externalConversationId: conversationId,
    externalSenderId: senderId,
    chatType: direct ? "direct" : "group",
    mentioned: direct || /<@[A-Z0-9]+>/i.test(text),
    text,
    occurredAt: slackTimestampToDate(
      messageId,
      context.receivedAt,
    ),
    thread: threadId
      ? { externalThreadId: threadId }
      : {},
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
