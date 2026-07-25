import { afterEach, describe, expect, it, vi } from "vitest";

import { createDingTalkWebhookAdapter } from "@/server/channels/adapters/webhook/dingtalk";
import { createFeishuWebhookAdapter } from "@/server/channels/adapters/webhook/feishu";
import type {
  ChannelDelivery,
} from "@/server/channels/runtime/types";

const now = new Date("2026-07-26T00:00:00.000Z");

describe("webhook adapter outbound delivery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends Feishu text with in-memory credentials and returns a sanitized result", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        tenant_access_token: "tenant-token",
        expire: 7_200,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        msg: "ok",
        data: { message_id: "om_reply" },
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createFeishuWebhookAdapter();
    const controller = new AbortController();

    const result = await adapter.send(
      delivery(),
      {
        config: adapter.validateConfig({
          enabled: true,
          app_id: "app-id",
          app_secret: "app-secret",
        }),
        signal: controller.signal,
        now: () => now,
      },
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          app_id: "app-id",
          app_secret: "app-secret",
        }),
      }),
    );
    const [, sendOptions] = fetchMock.mock.calls[1];
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
    );
    expect(sendOptions.headers).toMatchObject({
      authorization: "Bearer tenant-token",
      "content-type": "application/json",
    });
    expect(JSON.parse(sendOptions.body)).toEqual({
      receive_id: "oc_1",
      msg_type: "text",
      content: JSON.stringify({ text: "我在。" }),
    });
    expect(result).toEqual({
      externalMessageId: "om_reply",
      sentAt: now,
      rawSummary: { code: 0 },
    });
    expect(JSON.stringify(result)).not.toContain("tenant-token");
  });

  it("uses an unsealed DingTalk reply handle without putting it in the result", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("{}", { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createDingTalkWebhookAdapter();
    const sessionWebhook =
      "https://oapi.dingtalk.com/robot/send?access_token=secret";

    const result = await adapter.send(
      {
        ...delivery(),
        replyHandle: {
          publicFields: { conversationId: "cid-1" },
          secretFields: { sessionWebhook },
          expiresAt: new Date(now.getTime() + 60_000),
        },
      },
      {
        config: adapter.validateConfig({ enabled: true }),
        signal: new AbortController().signal,
        now: () => now,
      },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      sessionWebhook,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          msgtype: "text",
          text: { content: "我在。" },
        }),
      }),
    );
    expect(JSON.stringify(result)).not.toContain("access_token");
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});

function delivery(): ChannelDelivery {
  return {
    id: "40000000-0000-4000-8000-000000000001",
    eventId: "50000000-0000-4000-8000-000000000001",
    connectionId:
      "20000000-0000-4000-8000-000000000001",
    assistantMessageId:
      "60000000-0000-4000-8000-000000000001",
    body: "我在。",
    recipient: {
      externalConversationId: "oc_1",
    },
  };
}
