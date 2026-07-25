import { describe, expect, it } from "vitest";

import { createDingTalkWebhookAdapter } from "@/server/channels/adapters/webhook/dingtalk";
import { createFeishuWebhookAdapter } from "@/server/channels/adapters/webhook/feishu";
import {
  createSlackWebhookAdapter,
  slackTimestampToDate,
} from "@/server/channels/adapters/webhook/slack";
import { createTelegramWebhookAdapter } from "@/server/channels/adapters/webhook/telegram";
import type {
  ChannelAdapter,
} from "@/server/channels/types";

const context = {
  connectionId: "20000000-0000-4000-8000-000000000001",
  agentId: "10000000-0000-4000-8000-000000000011",
  receivedAt: new Date("2026-07-26T00:00:01.000Z"),
};

describe("webhook channel adapters", () => {
  it.each([
    [
      "telegram",
      createTelegramWebhookAdapter(),
      {
        update_id: 11,
        message: {
          message_id: 7,
          date: 1783185600,
          chat: { id: 123, type: "private" },
          from: { id: 456, is_bot: false },
          text: "你好",
        },
      },
      {
        externalEventId: "update:11",
        externalConversationId: "123",
        externalSenderId: "456",
        chatType: "direct",
        text: "你好",
      },
    ],
    [
      "slack",
      createSlackWebhookAdapter(),
      {
        type: "event_callback",
        event_id: "Ev1",
        team_id: "T1",
        event: {
          type: "message",
          channel: "C1",
          user: "U1",
          text: "周末去哪爬山？",
          ts: "1783185600.123900",
          channel_type: "channel",
        },
      },
      {
        externalEventId: "Ev1",
        externalConversationId: "C1",
        externalSenderId: "U1",
        chatType: "group",
        text: "周末去哪爬山？",
      },
    ],
    [
      "feishu",
      createFeishuWebhookAdapter(),
      {
        schema: "2.0",
        header: {
          event_id: "evt-1",
          create_time: "1783185600000",
          event_type: "im.message.receive_v1",
        },
        event: {
          message: {
            message_id: "om_1",
            chat_id: "oc_1",
            chat_type: "group",
            message_type: "text",
            content: "{\"text\":\"周末去哪爬山？\"}",
          },
          sender: {
            sender_id: { open_id: "ou_1" },
          },
        },
      },
      {
        externalEventId: "evt-1",
        externalConversationId: "oc_1",
        externalSenderId: "ou_1",
        chatType: "group",
        text: "周末去哪爬山？",
      },
    ],
    [
      "dingtalk",
      createDingTalkWebhookAdapter(),
      {
        msgId: "msg-1",
        conversationId: "cid-1",
        conversationType: "2",
        senderStaffId: "staff-1",
        msgtype: "text",
        text: { content: "周末去哪爬山？" },
        sessionWebhook:
          "https://oapi.dingtalk.com/robot/send?access_token=secret",
      },
      {
        externalEventId: "msg-1",
        externalConversationId: "cid-1",
        externalSenderId: "staff-1",
        chatType: "group",
        text: "周末去哪爬山？",
      },
    ],
  ] as const)(
    "normalizes %s into the shared event contract",
    async (channel, adapter, payload, expected) => {
      const event = await adapter.normalizeInbound(
        payload,
        context,
      );

      expect(event).toMatchObject({
        connectionId: context.connectionId,
        agentId: context.agentId,
        channelType: channel,
        ...expected,
        permission: {
          webSearch: false,
          backgroundNetwork: false,
          tools: false,
          skills: "none",
          attachmentsPresent: false,
        },
      });
      expect(event?.attachments).toEqual([]);
      expect(Object.keys(event?.rawSummary ?? {}).sort()).toEqual([
        "eventType",
        ...(channel === "dingtalk"
          ? ["hasReplyHandle"]
          : []),
        "isBotEvent",
        "platformMessageId",
      ].sort());
    },
  );

  it("keeps DingTalk sessionWebhook only in the secret reply handle", async () => {
    const secretUrl =
      "https://oapi.dingtalk.com/robot/send?access_token=secret";
    const event = await createDingTalkWebhookAdapter()
      .normalizeInbound(
        {
          msgId: "msg-1",
          conversationId: "cid-1",
          conversationType: "1",
          senderStaffId: "staff-1",
          msgtype: "text",
          text: { content: "你好" },
          sessionWebhook: secretUrl,
        },
        context,
      );

    expect(event?.replyHandle?.secretFields).toEqual({
      sessionWebhook: secretUrl,
    });
    expect(JSON.stringify(event?.rawSummary)).not.toContain(
      "access_token",
    );
    expect(JSON.stringify(event?.rawSummary)).not.toContain(
      "secret",
    );
  });

  it("ignores bot or non-text platform noise", async () => {
    await expect(createTelegramWebhookAdapter().normalizeInbound(
      {
        message: {
          message_id: 1,
          chat: { id: 1, type: "private" },
          from: { id: 2, is_bot: true },
          text: "echo",
        },
      },
      context,
    )).resolves.toBeNull();
    await expect(createSlackWebhookAdapter().normalizeInbound(
      {
        type: "event_callback",
        event: {
          type: "message",
          channel: "C1",
          bot_id: "B1",
          text: "echo",
          ts: "1783185600.000200",
        },
      },
      context,
    )).resolves.toBeNull();
  });

  it("preserves Slack sub-second event ordering", () => {
    expect(slackTimestampToDate(
      "1783185600.123900",
      context.receivedAt,
    ).toISOString()).toBe("2026-07-04T17:20:00.123Z");
  });

  it("has a lifecycle and ACK without Agent-facing methods", async () => {
    const adapter: ChannelAdapter<Record<string, unknown>> =
      createTelegramWebhookAdapter();
    const controller = new AbortController();
    await adapter.start({
      connectionId: context.connectionId,
      agentId: context.agentId,
      config: adapter.validateConfig({ enabled: true }),
      signal: controller.signal,
      now: () => context.receivedAt,
    });

    await expect(adapter.health()).resolves.toMatchObject({
      status: "healthy",
      reconnectAttempts: 0,
    });
    await expect(adapter.acknowledge({}, {
      kind: "accepted",
      eventId: "event-1",
    })).resolves.toMatchObject({ status: 200 });
    expect(Object.keys(adapter)).not.toContain("runAgent");
    await adapter.stop("shutdown");
    await expect(adapter.health()).resolves.toMatchObject({
      status: "stopped",
    });
  });
});
