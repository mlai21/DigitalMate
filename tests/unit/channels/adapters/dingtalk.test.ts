import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createDingTalkAdapter,
} from "@/server/channels/adapters/dingtalk";
import {
  createDingTalkAttachmentFetcher,
  createDingTalkSdkClient,
  createDingTalkTokenCache,
  DingTalkTransportError,
  mapDingTalkResponse,
  type DingTalkClientPort,
} from "@/server/channels/adapters/dingtalk/transport";
import {
  ChannelAdapterRegistry,
  registerDingTalkChannelAdapter,
} from "@/server/channels/runtime/registry";
import {
  CHANNEL_REACTIONS,
} from "@/server/channels/runtime/types";
import {
  assertStableExternalEventId,
  defineChannelContract,
} from "@/server/channels/testing/contract";
import {
  createFakeHttpClient,
} from "@/server/channels/testing/fixtures";

const NOW = new Date("2026-07-26T08:00:00.000Z");
const CONTEXT = {
  connectionId: "connection-dingtalk",
  userId: "user-1",
  agentId: "agent-1",
  receivedAt: NOW,
};
const CONFIG = {
  enabled: true,
  admin_from: ["staff-1"],
  client_id: "ding-client-id",
  client_secret: "ding-client-secret",
  message_type: "markdown",
  cron_message_type: "markdown",
  card_template_id: "",
  card_template_key: "content",
  robot_code: "robot-1",
  media_dir: null,
  card_auto_layout: false,
  at_sender_on_reply: true,
  streaming_enabled: false,
  endpoint: "",
};
const CARD_CONFIG = {
  ...CONFIG,
  message_type: "card",
  card_template_id: "template-1",
  streaming_enabled: true,
};

defineChannelContract({
  type: "dingtalk",
  assertConfig() {
    const adapter = createDingTalkAdapter({
      clientFactory: () => createFakeDingTalkClient(),
      autoListen: false,
    });
    expect(adapter.validateConfig(CONFIG)).toMatchObject({
      client_id: CONFIG.client_id,
      message_type: "markdown",
      endpoint: "https://api.dingtalk.com",
    });
    expect(() =>
      adapter.validateConfig({ ...CONFIG, client_secret: "" })
    ).toThrow("dingtalk_client_secret_required");
    expect(() =>
      adapter.validateConfig({
        ...CARD_CONFIG,
        card_template_id: "",
      })
    ).toThrow("dingtalk_card_template_id_required");
  },
  async assertLifecycle() {
    const client = createFakeDingTalkClient();
    const adapter = testAdapter(client);
    const context = runtimeContext(adapter);
    await Promise.all([adapter.start(context), adapter.start(context)]);
    await adapter.stop("reconfigure");
    await adapter.stop("reconfigure");
    expect(client.starts).toBe(1);
    expect(client.stops).toBe(1);
    expect(await adapter.health()).toMatchObject({ status: "stopped" });
    expect(JSON.stringify(await adapter.health()))
      .not.toContain(CONFIG.client_secret);
  },
  async assertInbound() {
    const client = createFakeDingTalkClient();
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter));
    const direct = await adapter.normalizeInbound(
      await fixture("message-direct-text.json"),
      CONTEXT,
    );
    const group = await adapter.normalizeInbound(
      await fixture("message-group-file.json"),
      CONTEXT,
    );
    expect(direct).toMatchObject({
      externalEventId: "message:msg-1001",
      externalConversationId: "cid-direct-1",
      externalSenderId: "staff-1",
      chatType: "direct",
      mentioned: true,
      text: "你好",
      permission: {
        manageGlobalAssets: true,
      },
      replyHandle: {
        publicFields: {
          conversationId: "cid-direct-1",
          conversationType: "direct",
          senderStaffId: "staff-1",
          robotCode: "robot-1",
          messageId: "msg-1001",
        },
        secretFields: {
          sessionWebhook: expect.stringContaining(
            "sendBySession",
          ),
        },
      },
    });
    expect(group).toMatchObject({
      externalEventId: "message:msg-1002",
      externalConversationId: "cid-group-1",
      externalSenderId: "staff-2",
      chatType: "group",
      mentioned: true,
      text: "[附件]",
      attachments: [{
        externalAttachmentId: "download-code-1",
        fileName: "notes.txt",
        source: {
          downloadCode: "download-code-1",
          robotCode: "robot-1",
        },
      }],
    });
    expect(group?.permission).toMatchObject({
      webSearch: false,
      tools: false,
      attachmentsPresent: true,
      manageGlobalAssets: false,
    });
    expect(JSON.stringify(group?.rawSummary))
      .not.toContain("secret-session");

    // Anything the user pastes with formatting arrives as richText, not text.
    // Dropping it made long messages look like the bot ignored them.
    const rich = await adapter.normalizeInbound(
      await fixture("message-direct-richtext.json"),
      CONTEXT,
    );
    expect(rich).toMatchObject({
      externalEventId: "message:msg-1003",
      chatType: "direct",
      text: "还有一个特别高频的场景，就是比较价格\n1. 先从价格入手对标模型\n2. 再看缓存命中的影响",
      attachments: [{
        externalAttachmentId: "download-code-rich-1",
        mimeType: "image/jpeg",
        source: {
          downloadCode: "download-code-rich-1",
          robotCode: "robot-1",
        },
      }],
    });
    await adapter.stop("shutdown");
  },
  async assertStableIds() {
    const client = createFakeDingTalkClient();
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter));
    const payload = await fixture("message-direct-text.json");
    await expect(
      assertStableExternalEventId(() =>
        adapter.normalizeInbound(payload, CONTEXT)
      ),
    ).resolves.toBe("message:msg-1001");
    await adapter.stop("shutdown");
  },
  async assertOutbound() {
    const client = createFakeDingTalkClient();
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter));
    const result = await adapter.send(outboundDelivery(), {
      config: adapter.validateConfig(CONFIG),
      signal: new AbortController().signal,
      now: () => NOW,
    });
    expect(result.externalMessageId).toBe("session-message-1");
    expect(client.sessionMessages).toEqual([{
      sessionWebhook: expect.stringContaining("sendBySession"),
      payload: {
        msgtype: "markdown",
        markdown: {
          title: "完整回复",
          text: "@staff-2\n完整回复",
        },
        at: { atUserIds: ["staff-2"] },
      },
    }]);
    const active = await adapter.send(proactiveDelivery(), {
      config: adapter.validateConfig(CONFIG),
      signal: new AbortController().signal,
      now: () => NOW,
    });
    expect(active.externalMessageId).toBe("openapi-message-1");
    expect(client.openApiMessages).toEqual([
      expect.objectContaining({
      conversationId: "cid-group-1",
      chatType: "group",
      senderStaffId: "staff-2",
      robotCode: "robot-1",
      text: "主动消息",
      format: "markdown",
      }),
    ]);
    await adapter.stop("shutdown");
  },
  async assertHealth() {
    const client = createFakeDingTalkClient({
      startError: new DingTalkTransportError({
        code: "permission_denied",
        detail: "dingtalk_outbound_ip_not_allowed",
        retryable: false,
      }),
    });
    const adapter = testAdapter(client);
    await expect(
      adapter.start(runtimeContext(adapter)),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(await adapter.health()).toMatchObject({
      status: "degraded",
      error: {
        code: "permission_denied",
        detail: "dingtalk_outbound_ip_not_allowed",
      },
    });
  },
  async assertShutdown() {
    const client = createFakeDingTalkClient();
    const adapter = testAdapter(client);
    const controller = new AbortController();
    await adapter.start(runtimeContext(adapter, controller.signal));
    controller.abort();
    await vi.waitFor(async () => {
      expect(client.stops).toBe(1);
      expect(await adapter.health()).toMatchObject({
        status: "stopped",
      });
    });
  },
});

describe("DingTalk Stream and AI Card", () => {
  it("registers the adapter and ACKs only after durable ingress", async () => {
    const client = createFakeDingTalkClient();
    const order: string[] = [];
    const adapter = createDingTalkAdapter({
      clientFactory: () => client,
      scope: { userId: "user-1", agentId: "agent-1" },
      acceptInbound: async (_payload, _context, _scope, acknowledge) => {
        order.push("persisted");
        await acknowledge();
        order.push("acknowledged");
        return { kind: "accepted", eventId: "event-1" };
      },
      now: () => NOW,
    });
    await adapter.start(runtimeContext(adapter));
    await client.emit(await fixture("message-direct-text.json"), order);
    expect(order).toEqual([
      "persisted",
      "protocol_ack",
      "acknowledged",
    ]);

    const registry = new ChannelAdapterRegistry();
    registerDingTalkChannelAdapter(registry);
    expect(registry.registeredTypes()).toEqual(["dingtalk"]);
    await adapter.stop("shutdown");
  });

  it("caches tokens, maps rate limits, and identifies outbound IP blocks", async () => {
    const load = vi.fn(async () => ({
      token: "access-token",
      expiresInSeconds: 7_200,
    }));
    const cache = createDingTalkTokenCache({
      load,
      now: () => NOW,
    });
    await Promise.all([cache.get(), cache.get()]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(() => mapDingTalkResponse({
      status: 429,
      headers: { "retry-after": "3" },
      body: {},
    })).toThrowError(expect.objectContaining({
      code: "rate_limited",
      retryAfterMs: 3_000,
    }));
    expect(() => mapDingTalkResponse({
      status: 403,
      body: {
        code: "Forbidden.AccessDenied.IpNotInWhiteList",
        message: CONFIG.client_secret,
      },
    })).toThrowError(expect.objectContaining({
      code: "permission_denied",
      detail: "dingtalk_outbound_ip_not_allowed",
    }));
  });

  it("marks the incoming message while the reply is being prepared", async () => {
    const client = createFakeDingTalkClient();
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter));

    await adapter.reaction!({
      platformMessageId: "msg-1001",
      externalConversationId: "cid-direct-1",
      reaction: "pending",
      active: true,
    });
    await adapter.reaction!({
      platformMessageId: "msg-1001",
      externalConversationId: "cid-direct-1",
      reaction: "pending",
      active: false,
    });

    expect(client.reactions).toEqual([
      {
        messageId: "msg-1001",
        conversationId: "cid-direct-1",
        robotCode: "robot-1",
        text: "🤔思考中",
        active: true,
      },
      {
        messageId: "msg-1001",
        conversationId: "cid-direct-1",
        robotCode: "robot-1",
        text: "🤔思考中",
        active: false,
      },
    ]);
    await adapter.stop("shutdown");
  });

  it("renders each reaction as its own short label", async () => {
    const client = createFakeDingTalkClient();
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter));

    for (const reaction of CHANNEL_REACTIONS) {
      await adapter.reaction!({
        platformMessageId: "msg-1001",
        externalConversationId: "cid-direct-1",
        reaction,
        active: true,
      });
    }

    const labels = client.reactions.map((entry) => entry.text);
    expect(labels).toEqual([
      "🤔思考中",
      "收到",
      "好问题",
      "赞同",
      "已完成",
    ]);
    // DingTalk truncates text emotions beyond four characters.
    for (const label of labels) {
      expect([...label].length).toBeLessThanOrEqual(4);
    }
    await adapter.stop("shutdown");
  });

  it("falls back to the client id when no robot code is configured", async () => {
    const client = createFakeDingTalkClient();
    const adapter = testAdapter(client);
    await adapter.start(
      runtimeContext(adapter, undefined, { ...CONFIG, robot_code: "  " }),
    );

    await adapter.reaction!({
      platformMessageId: "msg-1001",
      externalConversationId: "cid-direct-1",
      reaction: "pending",
      active: true,
    });

    expect(client.reactions).toMatchObject([
      { robotCode: CONFIG.client_id },
    ]);
    await adapter.stop("shutdown");
  });

  it("skips the reaction for events that carry no platform message", async () => {
    const client = createFakeDingTalkClient();
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter));

    await adapter.reaction!({
      platformMessageId: "",
      externalConversationId: "cid-direct-1",
      reaction: "pending",
      active: true,
    });

    expect(client.reactions).toEqual([]);
    await adapter.stop("shutdown");
  });

  it("creates and finalizes one AI Card across delivery instances", async () => {
    const client = createFakeDingTalkClient();
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter, undefined, CARD_CONFIG));
    const delivery = outboundDelivery();
    const first = await adapter.streaming!(delivery, {
      sequence: 1,
      final: false,
      previousResult: null,
    });
    await adapter.streaming!(delivery, {
      sequence: 2,
      final: true,
      previousResult: first,
    });
    expect(first.rawSummary).toMatchObject({
      cardInstanceId: "card-instance-1",
    });
    expect(client.cards).toEqual([
      expect.objectContaining({
      conversationId: "cid-group-1",
      chatType: "group",
      senderStaffId: "staff-2",
      robotCode: "robot-1",
      templateId: "template-1",
      templateKey: "content",
      text: "完整回复",
      autoLayout: false,
      atSender: true,
      }),
    ]);
    expect(client.cardUpdates).toEqual([
      expect.objectContaining({
      cardInstanceId: "card-instance-1",
      templateKey: "content",
      text: "完整回复",
      final: true,
      }),
    ]);
    await adapter.stop("shutdown");
  });

  it("falls back to OpenAPI only after a definitive session rejection", async () => {
    const rejected = createFakeDingTalkClient({
      sessionError: new DingTalkTransportError({
        code: "response_invalid",
        detail: "dingtalk_session_webhook_rejected",
        retryable: false,
      }),
    });
    const retryable = createFakeDingTalkClient({
      sessionError: new DingTalkTransportError({
        code: "network_unreachable",
        retryable: true,
      }),
    });
    const rejectedAdapter = testAdapter(rejected);
    await rejectedAdapter.start(runtimeContext(rejectedAdapter));
    await expect(rejectedAdapter.send(outboundDelivery(), {
      config: rejectedAdapter.validateConfig(CONFIG),
      signal: new AbortController().signal,
      now: () => NOW,
    })).resolves.toMatchObject({
      externalMessageId: "openapi-message-1",
    });
    expect(rejected.openApiMessages).toHaveLength(1);
    await rejectedAdapter.stop("shutdown");

    const retryableAdapter = testAdapter(retryable);
    await retryableAdapter.start(runtimeContext(retryableAdapter));
    await expect(retryableAdapter.send(outboundDelivery(), {
      config: retryableAdapter.validateConfig(CONFIG),
      signal: new AbortController().signal,
      now: () => NOW,
    })).rejects.toMatchObject({
      code: "network_unreachable",
    });
    expect(retryable.openApiMessages).toHaveLength(0);
    await retryableAdapter.stop("shutdown");
  });

  it("downloads a private file using downloadCode without logging tokens", async () => {
    const http = createFakeHttpClient();
    http.enqueue({
      status: 200,
      body: {
        accessToken: "ding-private-token-value",
        expireIn: 7_200,
      },
    });
    http.enqueue({
      status: 200,
      body: {
        downloadUrl:
          "https://static.dingtalk.com/media/notes.txt",
      },
    });
    http.enqueue({
      status: 200,
      body: new TextEncoder().encode("hello"),
    });
    const adapter = createDingTalkAdapter({
      clientFactory: () => createFakeDingTalkClient(),
      autoListen: false,
    });
    const fetcher = createDingTalkAttachmentFetcher(
      adapter.validateConfig(CONFIG),
      http,
    );
    const descriptor = {
      externalAttachmentId: "download-code-1",
      fileName: "notes.txt",
      mimeType: null,
      sizeBytes: null,
      source: {
        downloadCode: "download-code-1",
        robotCode: "robot-1",
      },
    };
    await expect(fetcher.inspect(descriptor)).resolves.toEqual({
      fileName: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of await fetcher.download(descriptor)) {
      chunks.push(chunk);
    }
    expect(new TextDecoder().decode(chunks[0])).toBe("hello");
    expect(http.requests).toHaveLength(3);
    const serialized = JSON.stringify(http.requests);
    expect(serialized).not.toContain(CONFIG.client_secret);
    expect(serialized).not.toContain("ding-private-token-value");
  });

  it("attaches and withdraws the pending reaction on the sender's message", async () => {
    const http = createFakeHttpClient();
    http.enqueue({
      status: 200,
      body: { accessToken: "ding-private-token-value", expireIn: 7_200 },
    });
    http.enqueue({ status: 200, body: { success: true } });
    http.enqueue({ status: 200, body: { success: true } });
    const adapter = createDingTalkAdapter({
      clientFactory: () => createFakeDingTalkClient(),
      autoListen: false,
    });
    const client = createDingTalkSdkClient(
      adapter.validateConfig(CONFIG),
      { http },
    );
    const target = {
      messageId: "msg-1001",
      conversationId: "cid-direct-1",
      robotCode: "robot-1",
    };

    await client.react({ ...target, text: "🤔思考中", active: true });
    await client.react({ ...target, text: "收到", active: false });

    const [, attach, recall] = http.requests;
    expect(attach).toMatchObject({
      method: "POST",
      url: "https://api.dingtalk.com/v1.0/robot/emotion/reply",
      body: {
        robotCode: "robot-1",
        openMsgId: "msg-1001",
        openConversationId: "cid-direct-1",
        emotionType: 2,
        emotionName: "🤔思考中",
        textEmotion: {
          emotionId: "2659900",
          emotionName: "🤔思考中",
          text: "🤔思考中",
          backgroundId: "im_bg_1",
        },
      },
    });
    expect(recall).toMatchObject({
      method: "POST",
      url: "https://api.dingtalk.com/v1.0/robot/emotion/recall",
      body: {
        openMsgId: "msg-1001",
        emotionName: "收到",
        textEmotion: { text: "收到" },
      },
    });
  });

  it("uses the documented Card, OpenAPI, and sessionWebhook request shapes", async () => {
    const http = createFakeHttpClient();
    http.enqueue({
      status: 200,
      body: {
        accessToken: "ding-private-token-value",
        expireIn: 7_200,
      },
    });
    http.enqueue({ status: 200, body: { success: true } });
    http.enqueue({
      status: 200,
      body: {
        result: {
          deliverResults: [{ success: true }],
        },
      },
    });
    http.enqueue({ status: 200, body: { success: true } });
    http.enqueue({
      status: 200,
      body: { processQueryKey: "query-1" },
    });
    http.enqueue({
      status: 200,
      body: { errcode: 0, errmsg: "ok" },
    });
    const adapter = createDingTalkAdapter({
      clientFactory: () => createFakeDingTalkClient(),
      autoListen: false,
    });
    const config = adapter.validateConfig(CARD_CONFIG);
    const client = createDingTalkSdkClient(config, { http });
    const card = await client.createCard({
      conversationId: "cid-group-1",
      chatType: "group",
      senderStaffId: "staff-2",
      robotCode: "robot-1",
      templateId: "template-1",
      templateKey: "content",
      text: "第一段",
      autoLayout: true,
      atSender: true,
    });
    await client.updateCard({
      cardInstanceId: card.cardInstanceId,
      templateKey: "content",
      text: "完整回复",
      final: true,
    });
    await expect(client.sendOpenApi({
      conversationId: "cid-group-1",
      chatType: "group",
      senderStaffId: "staff-2",
      robotCode: "robot-1",
      text: "主动消息",
      format: "markdown",
    })).resolves.toEqual({ messageId: "query-1" });
    await expect(client.sendSessionWebhook({
      sessionWebhook:
        "https://oapi.dingtalk.com/robot/sendBySession?session=private",
      payload: {
        msgtype: "text",
        text: { content: "回复" },
      },
    })).resolves.toMatchObject({
      messageId: expect.stringMatching(/^session:/),
    });

    expect(http.requests.map((request) => request.method)).toEqual([
      "POST",
      "POST",
      "POST",
      "PUT",
      "POST",
      "POST",
    ]);
    expect(http.requests[1]).toMatchObject({
      url: "https://api.dingtalk.com/v1.0/card/instances",
      body: {
        cardTemplateId: "template-1",
        outTrackId: expect.stringMatching(/^card_/),
        cardData: {
          cardParamMap: {
            content: "第一段",
            config: "{\"autoLayout\":true}",
          },
        },
        cardAtUserIds: ["staff-2"],
      },
    });
    expect(http.requests[2]).toMatchObject({
      url: expect.stringContaining("/card/instances/deliver"),
      body: {
        openSpaceId: "dtv1.card//IM_GROUP.cid-group-1",
        imGroupOpenDeliverModel: { robotCode: "robot-1" },
      },
    });
    expect(http.requests[3]).toMatchObject({
      url: expect.stringContaining("/card/streaming"),
      body: {
        outTrackId: card.cardInstanceId,
        key: "content",
        content: "完整回复",
        isFinalize: true,
      },
    });
    expect(http.requests[4]).toMatchObject({
      url: expect.stringContaining("/robot/groupMessages/send"),
      body: {
        robotCode: "robot-1",
        openConversationId: "cid-group-1",
        msgKey: "sampleMarkdown",
      },
    });
    expect(http.requests[5]).toMatchObject({
      url: expect.stringContaining("sendBySession"),
      body: {
        msgtype: "text",
        text: { content: "回复" },
      },
    });
    const serialized = JSON.stringify(http.requests);
    expect(serialized).not.toContain("ding-private-token-value");
    expect(serialized).not.toContain(CONFIG.client_secret);
    await client.stop();
  });
});

function testAdapter(client: FakeDingTalkClient) {
  return createDingTalkAdapter({
    clientFactory: () => client,
    autoListen: false,
    now: () => NOW,
  });
}

function runtimeContext(
  adapter: ReturnType<typeof createDingTalkAdapter>,
  signal = new AbortController().signal,
  config = CONFIG,
) {
  return {
    connectionId: CONTEXT.connectionId,
    agentId: CONTEXT.agentId,
    config: adapter.validateConfig(config),
    signal,
    now: () => NOW,
  };
}

function outboundDelivery() {
  return {
    id: "delivery-1",
    eventId: "event-1",
    connectionId: CONTEXT.connectionId,
    assistantMessageId: "assistant-1",
    body: "完整回复",
    recipient: {
      externalConversationId: "cid-group-1",
      externalUserId: "staff-2",
      chatType: "group" as const,
    },
    replyHandle: {
      publicFields: {
        conversationId: "cid-group-1",
        conversationType: "group",
        senderStaffId: "staff-2",
        robotCode: "robot-1",
        messageId: "msg-1002",
      },
      secretFields: {
        sessionWebhook:
          "https://oapi.dingtalk.com/robot/sendBySession?session=secret",
      },
      expiresAt: new Date("2026-07-26T09:00:00.000Z"),
    },
  };
}

function proactiveDelivery() {
  return {
    id: "delivery-2",
    eventId: null,
    connectionId: CONTEXT.connectionId,
    assistantMessageId: "assistant-2",
    body: "主动消息",
    recipient: {
      externalConversationId: "cid-group-1",
      externalUserId: "staff-2",
      chatType: "group" as const,
    },
  };
}

type FakeDingTalkClient = DingTalkClientPort & {
  starts: number;
  stops: number;
  sessionMessages: unknown[];
  openApiMessages: unknown[];
  cards: unknown[];
  cardUpdates: unknown[];
  reactions: Array<Parameters<DingTalkClientPort["react"]>[0]>;
  emit(payload: unknown, order?: string[]): Promise<void>;
};

function createFakeDingTalkClient(options: Readonly<{
  startError?: Error;
  sessionError?: Error;
  reactionError?: Error;
}> = {}): FakeDingTalkClient {
  let handler: Parameters<DingTalkClientPort["start"]>[0]["onEvent"]
    | null = null;
  return {
    starts: 0,
    stops: 0,
    sessionMessages: [],
    openApiMessages: [],
    cards: [],
    cardUpdates: [],
    reactions: [],
    async start(input) {
      this.starts += 1;
      if (options.startError) throw options.startError;
      handler = input.onEvent;
    },
    async stop() {
      this.stops += 1;
    },
    async sendSessionWebhook(input) {
      if (options.sessionError) throw options.sessionError;
      this.sessionMessages.push({
        sessionWebhook: input.sessionWebhook,
        payload: input.payload,
      });
      return { messageId: "session-message-1" };
    },
    async sendOpenApi(input) {
      this.openApiMessages.push(input);
      return { messageId: "openapi-message-1" };
    },
    async createCard(input) {
      this.cards.push(input);
      return { cardInstanceId: "card-instance-1" };
    },
    async updateCard(input) {
      this.cardUpdates.push(input);
    },
    async react(input) {
      if (options.reactionError) throw options.reactionError;
      this.reactions.push(input);
    },
    async emit(payload, order = []) {
      if (!handler) throw new Error("fake_dingtalk_not_started");
      let acknowledged = false;
      await handler(payload, async () => {
        if (acknowledged) return;
        acknowledged = true;
        order.push("protocol_ack");
      });
    },
  };
}

async function fixture(name: string): Promise<Record<string, unknown>> {
  const value = JSON.parse(
    await readFile(
      path.join(
        process.cwd(),
        "tests/fixtures/channels/dingtalk",
        name,
      ),
      "utf8",
    ),
  ) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("dingtalk_fixture_invalid");
  }
  return value as Record<string, unknown>;
}
