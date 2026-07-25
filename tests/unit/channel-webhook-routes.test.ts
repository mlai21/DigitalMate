import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST as postDingTalkWebhook } from "@/app/api/webhooks/dingtalk/route";
import { POST as postFeishuWebhook } from "@/app/api/webhooks/feishu/route";
import { POST as postSlackWebhook } from "@/app/api/webhooks/slack/route";
import { POST as postTelegramWebhook } from "@/app/api/webhooks/telegram/route";

const mocks = vi.hoisted(() => ({
  acceptWebhookEvent: vi.fn(),
  loadWebhookAuthConfig: vi.fn(),
  readEnv: vi.fn(),
}));

vi.mock("@/server/config/env", () => ({
  readEnv: mocks.readEnv,
}));

vi.mock(
  "@/server/channels/adapters/webhook/route-runtime",
  () => ({
    acceptWebhookEvent: mocks.acceptWebhookEvent,
    loadWebhookAuthConfig: mocks.loadWebhookAuthConfig,
  }),
);

describe("channel webhook routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readEnv.mockReturnValue({});
    mocks.loadWebhookAuthConfig.mockResolvedValue(null);
    mocks.acceptWebhookEvent.mockResolvedValue({
      status: 200,
      headers: { "content-type": "application/json" },
      body: "{\"ok\":true}",
    });
  });

  it("rejects Feishu webhook challenges with an invalid verification token", async () => {
    mocks.readEnv.mockReturnValue({
      feishuVerificationToken: "expected-token",
    });

    const response = await postFeishuWebhook(
      jsonRequest("feishu", {
        challenge: "challenge-value",
        header: { token: "wrong-token" },
      }),
    );

    expect(response.status).toBe(401);
    expect(mocks.acceptWebhookEvent).not.toHaveBeenCalled();
  });

  it("rejects DingTalk webhook payloads with an invalid robot code", async () => {
    mocks.readEnv.mockReturnValue({
      dingTalkRobotCode: "ding-robot",
    });

    const response = await postDingTalkWebhook(
      jsonRequest("dingtalk", {
        robotCode: "other-robot",
      }),
    );

    expect(response.status).toBe(401);
    expect(mocks.acceptWebhookEvent).not.toHaveBeenCalled();
  });

  it("rejects Telegram and Slack authentication failures before persistence", async () => {
    mocks.readEnv
      .mockReturnValueOnce({
        telegramWebhookSecret: "expected-token",
      })
      .mockReturnValueOnce({
        slackSigningSecret: "expected-secret",
      });

    const telegram = await postTelegramWebhook(
      jsonRequest("telegram", telegramPayload()),
    );
    const slack = await postSlackWebhook(
      jsonRequest("slack", slackPayload()),
    );

    expect(telegram.status).toBe(401);
    expect(slack.status).toBe(401);
    expect(mocks.acceptWebhookEvent).not.toHaveBeenCalled();
  });

  it("后台加密连接配置优先于旧环境变量验签", async () => {
    mocks.readEnv.mockReturnValue({
      telegramWebhookSecret: "legacy-secret",
    });
    mocks.loadWebhookAuthConfig.mockResolvedValue({
      webhook_secret: "console-secret",
    });

    const legacy = await postTelegramWebhook(
      jsonRequest(
        "telegram",
        telegramPayload(),
        {
          "x-telegram-bot-api-secret-token":
            "legacy-secret",
        },
      ),
    );
    const consoleConfigured = await postTelegramWebhook(
      jsonRequest(
        "telegram",
        telegramPayload(),
        {
          "x-telegram-bot-api-secret-token":
            "console-secret",
        },
      ),
    );

    expect(legacy.status).toBe(401);
    expect(consoleConfigured.status).toBe(200);
    expect(mocks.acceptWebhookEvent).toHaveBeenCalledTimes(1);
  });

  it("returns platform challenges without persisting events", async () => {
    const slack = await postSlackWebhook(
      jsonRequest("slack", {
        type: "url_verification",
        challenge: "slack-challenge",
      }),
    );
    const feishu = await postFeishuWebhook(
      jsonRequest("feishu", {
        challenge: "feishu-challenge",
      }),
    );

    await expect(slack.json()).resolves.toEqual({
      challenge: "slack-challenge",
    });
    await expect(feishu.json()).resolves.toEqual({
      challenge: "feishu-challenge",
    });
    expect(mocks.acceptWebhookEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["telegram", postTelegramWebhook, telegramPayload()],
    ["slack", postSlackWebhook, slackPayload()],
    ["feishu", postFeishuWebhook, feishuPayload()],
    ["dingtalk", postDingTalkWebhook, dingTalkPayload()],
  ] as const)(
    "%s webhook waits for persistence and returns the adapter ACK without running Agent code",
    async (channel, post, payload) => {
      let releasePersistence!: () => void;
      const persistence = new Promise<void>((resolve) => {
        releasePersistence = resolve;
      });
      mocks.acceptWebhookEvent.mockImplementationOnce(
        async () => {
          await persistence;
          return {
            status: 202,
            headers: {
              "content-type": "application/json",
              "x-channel-ack": channel,
            },
            body: "{\"accepted\":true}",
          };
        },
      );

      let settled = false;
      const responsePromise = post(
        jsonRequest(channel, payload),
      ).then((response) => {
        settled = true;
        return response;
      });
      await vi.waitFor(() => {
        expect(mocks.acceptWebhookEvent).toHaveBeenCalledWith({
          channelType: channel,
          payload,
          receivedAt: expect.any(Date),
        });
      });
      expect(settled).toBe(false);

      releasePersistence();
      const response = await responsePromise;

      expect(response.status).toBe(202);
      expect(response.headers.get("x-channel-ack")).toBe(channel);
      await expect(response.json()).resolves.toEqual({
        accepted: true,
      });
      expect(mocks.acceptWebhookEvent).toHaveBeenCalledTimes(1);
    },
  );

  it("does not acquire persistence resources for malformed JSON", async () => {
    const routes = [
      [postTelegramWebhook, "telegram"],
      [postSlackWebhook, "slack"],
      [postFeishuWebhook, "feishu"],
      [postDingTalkWebhook, "dingtalk"],
    ] as const;

    for (const [post, channel] of routes) {
      await expect(
        post(new Request(
          `http://localhost/api/webhooks/${channel}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: "{",
          },
        )),
      ).rejects.toBeInstanceOf(SyntaxError);
    }
    expect(mocks.acceptWebhookEvent).not.toHaveBeenCalled();
  });
});

function jsonRequest(
  channel: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Request {
  return new Request(
    `http://localhost/api/webhooks/${channel}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    },
  );
}

function telegramPayload() {
  return {
    update_id: 10,
    message: {
      message_id: 9,
      date: 1783185600,
      chat: { id: 123, type: "private" },
      from: { id: 456, is_bot: false },
      text: "你好",
    },
  };
}

function slackPayload() {
  return {
    type: "event_callback",
    event: {
      type: "message",
      channel: "D1",
      user: "U1",
      text: "你好",
      ts: "1783185600.000900",
      channel_type: "im",
    },
  };
}

function feishuPayload() {
  return {
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
        chat_type: "p2p",
        message_type: "text",
        content: "{\"text\":\"你好\"}",
      },
      sender: {
        sender_id: { open_id: "ou_1" },
      },
    },
  };
}

function dingTalkPayload() {
  return {
    msgId: "msg-1",
    conversationId: "cid-1",
    conversationType: "1",
    senderStaffId: "staff-1",
    msgtype: "text",
    text: { content: "你好" },
    sessionWebhook:
      "https://oapi.dingtalk.com/robot/send?access_token=secret",
  };
}
