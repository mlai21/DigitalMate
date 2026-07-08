import { describe, expect, it } from "vitest";
import {
  normalizeDingTalkEvent,
  normalizeFeishuEvent,
  normalizeSlackEvent,
  normalizeTelegramUpdate,
} from "@/server/channels/normalize";

describe("normalizeTelegramUpdate", () => {
  it("normalizes Telegram private and group messages", () => {
    const direct = normalizeTelegramUpdate({
      update_id: 11,
      message: {
        message_id: 7,
        date: 1783185600,
        chat: { id: 123, type: "private" },
        from: { id: 456, is_bot: false, first_name: "Tang" },
        text: "你好",
      },
    });

    expect(direct).toMatchObject({
      channel: "telegram",
      externalMessageId: "7",
      externalConversationId: "123",
      senderId: "456",
      chatType: "direct",
      text: "你好",
    });

    const group = normalizeTelegramUpdate({
      update_id: 12,
      message: {
        message_id: 8,
        date: 1783185601,
        chat: { id: -100, type: "supergroup", title: "周末计划" },
        from: { id: 456, is_bot: false, first_name: "Tang" },
        text: "周末去哪爬山？",
      },
    });

    expect(group?.chatType).toBe("group");
  });
});

describe("normalizeSlackEvent", () => {
  it("normalizes Slack message events and ignores bot messages", () => {
    const message = normalizeSlackEvent({
      type: "event_callback",
      team_id: "T1",
      event: {
        type: "message",
        channel: "C1",
        user: "U1",
        text: "周末去哪爬山？",
        ts: "1783185600.000100",
        channel_type: "channel",
      },
    });

    expect(message).toMatchObject({
      channel: "slack",
      externalMessageId: "1783185600.000100",
      externalConversationId: "C1",
      senderId: "U1",
      chatType: "group",
      text: "周末去哪爬山？",
    });

    expect(
      normalizeSlackEvent({
        type: "event_callback",
        event: {
          type: "message",
          channel: "C1",
          bot_id: "B1",
          text: "bot echo",
          ts: "1783185600.000200",
        },
      }),
    ).toBeNull();
  });
});

describe("normalizeFeishuEvent", () => {
  it("normalizes received text message callbacks", () => {
    const message = normalizeFeishuEvent({
      schema: "2.0",
      header: { event_id: "evt-1", create_time: "1783185600000", event_type: "im.message.receive_v1" },
      event: {
        message: {
          message_id: "om_1",
          chat_id: "oc_1",
          chat_type: "group",
          message_type: "text",
          content: "{\"text\":\"周末去哪爬山？\"}",
        },
        sender: { sender_id: { open_id: "ou_1" } },
      },
    });

    expect(message).toMatchObject({
      channel: "feishu",
      externalMessageId: "om_1",
      externalConversationId: "oc_1",
      senderId: "ou_1",
      chatType: "group",
      text: "周末去哪爬山？",
    });
  });
});

describe("normalizeDingTalkEvent", () => {
  it("normalizes robot text callbacks with session webhook metadata", () => {
    const message = normalizeDingTalkEvent({
      msgId: "msg-1",
      conversationId: "cid-1",
      conversationType: "2",
      senderStaffId: "staff-1",
      msgtype: "text",
      text: { content: "周末去哪爬山？" },
      sessionWebhook: "https://oapi.dingtalk.com/robot/send?access_token=x",
    });

    expect(message).toMatchObject({
      channel: "dingtalk",
      externalMessageId: "msg-1",
      externalConversationId: "cid-1",
      senderId: "staff-1",
      chatType: "group",
      text: "周末去哪爬山？",
    });
  });
});
