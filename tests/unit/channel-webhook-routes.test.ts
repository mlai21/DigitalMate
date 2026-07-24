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
  beginUserDataRequest: vi.fn(),
  tryAdmitUserDataRequest: vi.fn(),
  acquireSharedUserDataLease: vi.fn(),
  releaseUserDataLease: vi.fn(),
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
    mocks.beginUserDataRequest.mockImplementation(async (userId: string) => ({ userId, epoch: "1" }));
    mocks.tryAdmitUserDataRequest.mockImplementation(async (userId: string) => ({
      userId,
      epoch: "1",
    }));
    mocks.acquireSharedUserDataLease.mockImplementation(async (fence: { userId: string; epoch: string }) => ({
      ...fence,
      mode: "shared",
      release: mocks.releaseUserDataLease,
    }));
    mocks.releaseUserDataLease.mockResolvedValue(undefined);
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

  it("rejects Telegram and Slack authentication failures before admission", async () => {
    mocks.readEnv
      .mockReturnValueOnce({ telegramWebhookSecret: "expected-token" })
      .mockReturnValueOnce({ slackSigningSecret: "expected-secret" });

    const telegram = await postTelegramWebhook(
      jsonRequest("http://localhost/api/webhooks/telegram", {
        message: {
          message_id: 9,
          date: 1783185600,
          chat: { id: 123, type: "private" },
          from: { id: 456, is_bot: false },
          text: "不应受理",
        },
      }),
    );
    const slack = await postSlackWebhook(
      jsonRequest("http://localhost/api/webhooks/slack", {
        type: "event_callback",
        event: {
          type: "message",
          channel: "D1",
          user: "U1",
          text: "不应受理",
          ts: "1783185600.000900",
          channel_type: "im",
        },
      }),
    );

    expect(telegram.status).toBe(401);
    expect(slack.status).toBe(401);
    expect(mocks.createRepositories).not.toHaveBeenCalled();
    expect(mocks.tryAdmitUserDataRequest).not.toHaveBeenCalled();
  });

  it("does not acquire admission resources for malformed JSON", async () => {
    const routes = [
      [postTelegramWebhook, "telegram"],
      [postSlackWebhook, "slack"],
      [postFeishuWebhook, "feishu"],
      [postDingTalkWebhook, "dingtalk"],
    ] as const;

    for (const [post, name] of routes) {
      await expect(
        post(new Request(`http://localhost/api/webhooks/${name}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        })),
      ).rejects.toBeInstanceOf(SyntaxError);
    }
    expect(mocks.createRepositories).not.toHaveBeenCalled();
    expect(mocks.tryAdmitUserDataRequest).not.toHaveBeenCalled();
  });

  it("captures Telegram admission before ACK and delays processing dependencies", async () => {
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
    expect(mocks.createRepositories).toHaveBeenCalledTimes(1);
    expect(mocks.tryAdmitUserDataRequest).toHaveBeenCalledWith("user-1");
    expect(mocks.getLlmClient).not.toHaveBeenCalled();
    expect(mocks.handleChannelMessage).not.toHaveBeenCalled();

    await vi.runOnlyPendingTimersAsync();

    expect(mocks.createRepositories).toHaveBeenCalledTimes(1);
    expect(mocks.beginUserDataRequest).not.toHaveBeenCalled();
    expect(mocks.acquireSharedUserDataLease).toHaveBeenCalledWith(
      { userId: "user-1", epoch: "1" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.getLlmClient).toHaveBeenCalledWith("main", expect.any(Object), { main: "mock-main", light: "mock-light" });
    expect(mocks.handleChannelMessage).toHaveBeenCalledTimes(1);
  });

  it("captures Slack admission before ACK and delays processing dependencies", async () => {
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
    expect(mocks.createRepositories).toHaveBeenCalledTimes(1);
    expect(mocks.tryAdmitUserDataRequest).toHaveBeenCalledWith("user-1");
    expect(mocks.getLlmClient).not.toHaveBeenCalled();
    expect(mocks.handleChannelMessage).not.toHaveBeenCalled();

    await vi.runOnlyPendingTimersAsync();

    expect(mocks.createRepositories).toHaveBeenCalledTimes(1);
    expect(mocks.getLlmClient).toHaveBeenCalledWith("main", expect.any(Object), { main: "mock-main", light: "mock-light" });
    expect(mocks.handleChannelMessage).toHaveBeenCalledTimes(1);
  });

  it("captures Feishu admission before ACK and delays processing dependencies", async () => {
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
    expect(mocks.createRepositories).toHaveBeenCalledTimes(1);
    expect(mocks.tryAdmitUserDataRequest).toHaveBeenCalledWith("user-1");
    expect(mocks.getLlmClient).not.toHaveBeenCalled();
    expect(mocks.handleChannelMessage).not.toHaveBeenCalled();

    await vi.runOnlyPendingTimersAsync();

    expect(mocks.createRepositories).toHaveBeenCalledTimes(1);
    expect(mocks.getLlmClient).toHaveBeenCalledWith("main", expect.any(Object), { main: "mock-main", light: "mock-light" });
    expect(mocks.handleChannelMessage).toHaveBeenCalledTimes(1);
  });

  it("captures DingTalk admission before ACK and delays processing dependencies", async () => {
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
    expect(mocks.createRepositories).toHaveBeenCalledTimes(1);
    expect(mocks.tryAdmitUserDataRequest).toHaveBeenCalledWith("user-1");
    expect(mocks.getLlmClient).not.toHaveBeenCalled();
    expect(mocks.handleChannelMessage).not.toHaveBeenCalled();

    await vi.runOnlyPendingTimersAsync();

    expect(mocks.createRepositories).toHaveBeenCalledTimes(1);
    expect(mocks.getLlmClient).toHaveBeenCalledWith("main", expect.any(Object), { main: "mock-main", light: "mock-light" });
    expect(mocks.handleChannelMessage).toHaveBeenCalledTimes(1);
  });

  it("ACKs and drops all four normalized events when clear owns admission", async () => {
    vi.useFakeTimers();
    mocks.tryAdmitUserDataRequest.mockResolvedValue(null);

    const responses = await Promise.all([
      postTelegramWebhook(
        jsonRequest("http://localhost/api/webhooks/telegram", {
          message: {
            message_id: 11,
            date: 1783185600,
            chat: { id: 123, type: "private" },
            from: { id: 456, is_bot: false },
            text: "清空中",
          },
        }),
      ),
      postSlackWebhook(
        jsonRequest("http://localhost/api/webhooks/slack", {
          type: "event_callback",
          event: {
            type: "message",
            channel: "D1",
            user: "U1",
            text: "清空中",
            ts: "1783185600.001100",
            channel_type: "im",
          },
        }),
      ),
      postFeishuWebhook(
        jsonRequest("http://localhost/api/webhooks/feishu", {
          schema: "2.0",
          header: {
            event_id: "evt-11",
            create_time: "1783185600000",
            event_type: "im.message.receive_v1",
          },
          event: {
            message: {
              message_id: "om_11",
              chat_id: "oc_11",
              chat_type: "p2p",
              message_type: "text",
              content: "{\"text\":\"清空中\"}",
            },
            sender: { sender_id: { open_id: "ou_11" } },
          },
        }),
      ),
      postDingTalkWebhook(
        jsonRequest("http://localhost/api/webhooks/dingtalk", {
          msgId: "msg-11",
          conversationId: "cid-11",
          conversationType: "1",
          senderStaffId: "staff-11",
          msgtype: "text",
          text: { content: "清空中" },
        }),
      ),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      200,
      200,
      200,
      200,
    ]);
    expect(mocks.tryAdmitUserDataRequest).toHaveBeenCalledTimes(4);
    await vi.runOnlyPendingTimersAsync();
    expect(mocks.handleChannelMessage).not.toHaveBeenCalled();
    expect(mocks.acquireSharedUserDataLease).not.toHaveBeenCalled();
  });

  it("drops a pre-clear admission whose captured fence becomes stale", async () => {
    vi.useFakeTimers();
    mocks.acquireSharedUserDataLease.mockRejectedValueOnce(
      new Error("user_data_epoch_changed"),
    );
    const consoleError = vi.spyOn(console, "error")
      .mockImplementation(() => undefined);

    const response = await postTelegramWebhook(
      jsonRequest("http://localhost/api/webhooks/telegram", {
        message: {
          message_id: 12,
          date: 1783185600,
          chat: { id: 123, type: "private" },
          from: { id: 456, is_bot: false },
          text: "旧 fence 不得执行",
        },
      }),
    );
    await vi.runOnlyPendingTimersAsync();

    expect(response.status).toBe(200);
    expect(mocks.beginUserDataRequest).not.toHaveBeenCalled();
    expect(mocks.acquireSharedUserDataLease).toHaveBeenCalledWith(
      { userId: "user-1", epoch: "1" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.handleChannelMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
      "旧 fence 不得执行",
    );
    consoleError.mockRestore();
  });

  it("keeps the channel shared lease until handler persistence and outbound work settle", async () => {
    vi.useFakeTimers();
    let finishHandling: (() => void) | undefined;
    mocks.handleChannelMessage.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        finishHandling = resolve;
      }),
    );

    await postTelegramWebhook(
      jsonRequest("http://localhost/api/webhooks/telegram", {
        message: {
          message_id: 2,
          date: 1783185600,
          chat: { id: 123, type: "private" },
          from: { id: 456, is_bot: false },
          text: "等整段渠道处理完成",
        },
      }),
    );
    await vi.runOnlyPendingTimersAsync();

    expect(mocks.handleChannelMessage).toHaveBeenCalledTimes(1);
    expect(mocks.releaseUserDataLease).not.toHaveBeenCalled();

    finishHandling?.();
    await vi.waitFor(() => {
      expect(mocks.releaseUserDataLease).toHaveBeenCalledTimes(1);
    });
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
    userDataMutations: {
      beginRequest: mocks.beginUserDataRequest,
      tryAdmitRequest: mocks.tryAdmitUserDataRequest,
      acquireSharedLease: mocks.acquireSharedUserDataLease,
    },
    users: {
      ensureDefault: vi.fn(async () => ({ id: "user-1" })),
    },
    agents: {
      getDefault: vi.fn(async () => ({
        id: "agent-1",
        userId: "user-1",
        status: "active",
      })),
      getActive: vi.fn(async () => ({
        id: "agent-1",
        userId: "user-1",
        status: "active",
        inheritsUserResources: true,
      })),
      listResourceGrants: vi.fn(async () => []),
    },
    settings: {
      get: vi.fn(async () => ({
        modelRouting: { main: "mock-main", light: "mock-light" },
      })),
    },
  };
}
