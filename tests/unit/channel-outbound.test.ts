import { afterEach, describe, expect, it, vi } from "vitest";
import { sendChannelMessage } from "@/server/channels/outbound";
import { readEnv } from "@/server/config/env";
import type { NormalizedChannelMessage } from "@/server/channels/types";

const feishuMessage: NormalizedChannelMessage = {
  channel: "feishu",
  externalConversationId: "oc_1",
  externalMessageId: "om_1",
  senderId: "ou_1",
  chatType: "direct",
  text: "你好",
  occurredAt: new Date("2026-07-05T10:00:00+08:00"),
  raw: {},
};

describe("sendChannelMessage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends Feishu text messages with a tenant access token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, msg: "ok" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendChannelMessage(readEnv({ FEISHU_APP_ID: "app-id", FEISHU_APP_SECRET: "app-secret" }), feishuMessage, "我在。");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ app_id: "app-id", app_secret: "app-secret" }),
      }),
    );

    const [, sendOptions] = fetchMock.mock.calls[1];
    expect(fetchMock.mock.calls[1][0]).toBe("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id");
    expect(sendOptions.headers).toMatchObject({
      authorization: "Bearer tenant-token",
      "content-type": "application/json",
    });
    expect(JSON.parse(sendOptions.body)).toEqual({
      receive_id: "oc_1",
      msg_type: "text",
      content: JSON.stringify({ text: "我在。" }),
    });
  });
});
