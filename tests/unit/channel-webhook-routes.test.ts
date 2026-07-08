import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as postDingTalkWebhook } from "@/app/api/webhooks/dingtalk/route";
import { POST as postFeishuWebhook } from "@/app/api/webhooks/feishu/route";
import { POST as postSlackWebhook } from "@/app/api/webhooks/slack/route";
import { POST as postTelegramWebhook } from "@/app/api/webhooks/telegram/route";

const mocks = vi.hoisted(() => ({
  createRepositories: vi.fn(),
  getLlmClient: vi.fn(),
  handleChannelMessage: vi.fn(),
  readEnv: vi.fn(),
  sendChannelMessage: vi.fn(),
}));

vi.mock("@/server/config/env", () => ({
  readEnv: mocks.readEnv,
}));

vi.mock("@/server/db/repositories", () => ({
  createRepositories: mocks.createRepositories,
}));

vi.mock("@/server/llm/router", () => ({
  getLlmClient: mocks.getLlmClient,
}));

vi.mock("@/server/channels/handler", () => ({
  handleChannelMessage: mocks.handleChannelMessage,
}));

vi.mock("@/server/channels/outbound", () => ({
  sendChannelMessage: mocks.sendChannelMessage,
}));

describe("channel webhook routes", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mocks.readEnv.mockReturnValue({});
    mocks.createRepositories.mockReturnValue(fakeRepositories());
    mocks.getLlmClient.mockReturnValue({ client: {}, model: "mock-main" });
    mocks.handleChannelMessage.mockResolvedValue(undefined);
  });

  it("rejects Feishu webhook challenges with an invalid verification token", async () => {
    mocks.readEnv.mockReturnValue({ feishuVerificationToken: "expected-token" });

    const response = await postFeishuWebhook(
      jsonRequest("http://localhost/api/webhooks/feishu", {
        challenge: "challenge-value",
        header: { token: "wrong-token" },
      }),
    );

    expect(response.status).toBe(401);
    expect(mocks.createRepositories).not.toHaveBeenCalled();
  });

  it("rejects DingTalk webhook payloads with an invalid robot code", async () => {
    mocks.readEnv.mockReturnValue({ dingTalkRobotCode: "ding-robot" });

    const response = await postDingTalkWebhook(
      jsonRequest("http://localhost/api/webhooks/dingtalk", {
        robotCode: "other-robot",
      }),
    );

    expect(response.status).toBe(401);
    expect(mocks.createRepositories).not.toHaveBeenCalled();
  });

  it("acks Telegram webhooks before initializing channel processing dependencies", async () => {
    vi.useFakeTimers();

    const response = await postTelegramWebhook(
      jsonRequest("http://localhost/api/webhooks/telegram", {
        message: {
          message_id: 1,
          date: 1783185600,
          chat: { id: 123, type: "private" },
          from: { id: 456, is_bot: false },
          text: "你好",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.createRepositories).not.toHaveBeenCalled();
    expect(mocks.getLlmClient).not.toHaveBeenCalled();
    expect(mocks.handleChannelMessage).not.toHaveBeenCalled();

    await vi.runOnlyPendingTimersAsync();

    expect(mocks.createRepositories).toHaveBeenCalledTimes(1);
    expect(mocks.getLlmClient).toHaveBeenCalledWith("main", expect.any(Object), { main: "mock-main", light: "mock-light" });
    expect(mocks.handleChannelMessage).toHaveBeenCalledTimes(1);
  });

  it("acks Slack webhooks before initializing channel processing dependencies", async () => {
    vi.useFakeTimers();

    const response = await postSlackWebhook(
      jsonRequest("http://localhost/api/webhooks/slack", {
        type: "event_callback",
        event: {
          type: "message",
          channel: "D1",
          user: "U1",
          text: "你好",
          ts: "1783185600.000100",
          channel_type: "im",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.createRepositories).not.toHaveBeenCalled();
    expect(mocks.getLlmClient).not.toHaveBeenCalled();
    expect(mocks.handleChannelMessage).not.toHaveBeenCalled();

    await vi.runOnlyPendingTimersAsync();

    expect(mocks.createRepositories).toHaveBeenCalledTimes(1);
    expect(mocks.getLlmClient).toHaveBeenCalledWith("main", expect.any(Object), { main: "mock-main", light: "mock-light" });
    expect(mocks.handleChannelMessage).toHaveBeenCalledTimes(1);
  });

  it("acks Feishu webhooks before initializing channel processing dependencies", async () => {
    vi.useFakeTimers();

    const response = await postFeishuWebhook(
      jsonRequest("http://localhost/api/webhooks/feishu", {
        schema: "2.0",
        header: { event_id: "evt-1", create_time: "1783185600000", event_type: "im.message.receive_v1" },
        event: {
          message: {
            message_id: "om_1",
            chat_id: "oc_1",
            chat_type: "p2p",
            message_type: "text",
            content: "{\"text\":\"你好\"}",
          },
          sender: { sender_id: { open_id: "ou_1" } },
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.createRepositories).not.toHaveBeenCalled();
    expect(mocks.getLlmClient).not.toHaveBeenCalled();
    expect(mocks.handleChannelMessage).not.toHaveBeenCalled();

    await vi.runOnlyPendingTimersAsync();

    expect(mocks.createRepositories).toHaveBeenCalledTimes(1);
    expect(mocks.getLlmClient).toHaveBeenCalledWith("main", expect.any(Object), { main: "mock-main", light: "mock-light" });
    expect(mocks.handleChannelMessage).toHaveBeenCalledTimes(1);
  });

  it("acks DingTalk webhooks before initializing channel processing dependencies", async () => {
    vi.useFakeTimers();

    const response = await postDingTalkWebhook(
      jsonRequest("http://localhost/api/webhooks/dingtalk", {
        msgId: "msg-1",
        conversationId: "cid-1",
        conversationType: "1",
        senderStaffId: "staff-1",
        msgtype: "text",
        text: { content: "你好" },
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.createRepositories).not.toHaveBeenCalled();
    expect(mocks.getLlmClient).not.toHaveBeenCalled();
    expect(mocks.handleChannelMessage).not.toHaveBeenCalled();

    await vi.runOnlyPendingTimersAsync();

    expect(mocks.createRepositories).toHaveBeenCalledTimes(1);
    expect(mocks.getLlmClient).toHaveBeenCalledWith("main", expect.any(Object), { main: "mock-main", light: "mock-light" });
    expect(mocks.handleChannelMessage).toHaveBeenCalledTimes(1);
  });
});

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function fakeRepositories() {
  return {
    users: {
      ensureDefault: vi.fn(async () => ({ id: "user-1" })),
    },
    settings: {
      get: vi.fn(async () => ({
        modelRouting: { main: "mock-main", light: "mock-light" },
      })),
    },
  };
}
