import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createWeComAdapter,
} from "@/server/channels/adapters/wecom";
import {
  createWeComAttachmentFetcher,
  uploadWeComMedia,
} from "@/server/channels/adapters/wecom/media";
import {
  mapWeComError,
  type WeComClientPort,
} from "@/server/channels/adapters/wecom/transport";
import {
  ChannelAdapterRegistry,
  registerWeComChannelAdapter,
} from "@/server/channels/runtime/registry";
import {
  assertStableExternalEventId,
  defineChannelContract,
} from "@/server/channels/testing/contract";

const NOW = new Date("2026-07-26T00:00:00.000Z");
const CONTEXT = {
  connectionId: "connection-wecom",
  userId: "user-1",
  agentId: "agent-1",
  receivedAt: NOW,
};
const CONFIG = {
  enabled: true,
  bot_id: "bot-digitalmate",
  secret: "wecom-secret",
  media_dir: null,
  welcome_text: "欢迎回来",
  share_session_in_group: true,
  max_reconnect_attempts: -1,
  streaming_enabled: true,
} as const;

defineChannelContract({
  type: "wecom",

  assertConfig() {
    const adapter = testAdapter(createFakeWeComClient());
    expect(adapter.validateConfig(CONFIG)).toMatchObject({
      ...CONFIG,
      filter_thinking: true,
      filter_tool_messages: true,
    });
    expect(() =>
      adapter.validateConfig({ ...CONFIG, bot_id: "" })
    ).toThrow("wecom_bot_id_required");
    expect(() =>
      adapter.validateConfig({ ...CONFIG, secret: "" })
    ).toThrow("wecom_secret_required");
    expect(JSON.stringify(adapter.manifest))
      .not.toContain(CONFIG.secret);
    expect(adapter.manifest.prerequisites).toContain(
      "企业微信智能机器人接入资格",
    );
  },

  async assertLifecycle() {
    const client = createFakeWeComClient();
    const adapter = testAdapter(client);
    const context = runtimeContext(adapter);

    await Promise.all([
      adapter.start(context),
      adapter.start(context),
    ]);
    expect(client.starts).toBe(1);
    expect(client.receivedConfig).toMatchObject({
      max_reconnect_attempts: -1,
    });
    expect(await adapter.health()).toMatchObject({
      status: "healthy",
    });

    await adapter.stop("reconfigure");
    await adapter.stop("reconfigure");
    expect(client.stops).toBe(1);
  },

  async assertInbound() {
    const adapter = testAdapter(createFakeWeComClient());
    const direct = await adapter.normalizeInbound(
      await fixture("message-direct-text.json"),
      CONTEXT,
    );
    const group = await adapter.normalizeInbound(
      await fixture("message-group-file.json"),
      CONTEXT,
    );

    expect(direct).toMatchObject({
      externalEventId: "wecom:message:msg-7001",
      externalConversationId: "user-alice",
      externalSenderId: "user-alice",
      chatType: "direct",
      mentioned: true,
      text: "你好，DigitalMate",
      attachments: [],
      replyHandle: {
        publicFields: {
          chatId: "user-alice",
          senderId: "user-alice",
          messageId: "msg-7001",
        },
        secretFields: {
          requestId: "req-direct-7001",
        },
      },
    });
    expect(group).toMatchObject({
      externalEventId: "wecom:message:msg-7002",
      externalConversationId: "group-product",
      externalSenderId: "user-bob",
      chatType: "group",
      mentioned: true,
      text: "[附件]",
      attachments: [{
        externalAttachmentId: "msg-7002:0",
        fileName: null,
        mimeType: null,
        sizeBytes: null,
        source: {
          url: expect.stringContaining("wework.qpic.cn"),
          aesKey: "fixture-aes-key",
        },
      }],
    });
    expect(group?.permission).toMatchObject({
      webSearch: false,
      tools: false,
      attachmentsPresent: true,
    });
    const isolated = await testAdapter(
      createFakeWeComClient(),
      { ...CONFIG, share_session_in_group: false },
    ).normalizeInbound(
      await fixture("message-group-file.json"),
      CONTEXT,
    );
    expect(isolated?.externalConversationId)
      .toBe("group-product:user-bob");
  },

  async assertStableIds() {
    const adapter = testAdapter(createFakeWeComClient());
    const payload = await fixture("message-direct-text.json");
    await expect(
      assertStableExternalEventId(() =>
        adapter.normalizeInbound(payload, CONTEXT)
      ),
    ).resolves.toBe("wecom:message:msg-7001");
  },

  async assertOutbound() {
    const client = createFakeWeComClient();
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter));
    const delivery = outboundDelivery();
    const first = await adapter.streaming!(delivery, {
      sequence: 1,
      final: false,
      previousResult: null,
    });
    const final = await adapter.streaming!(
      { ...delivery, body: "完整回复" },
      {
        sequence: 2,
        final: true,
        previousResult: first,
      },
    );

    expect(first.externalMessageId)
      .toBe(final.externalMessageId);
    expect(client.streamReplies).toEqual([
      expect.objectContaining({
        requestId: "req-direct-7001",
        content: "第一段",
        finish: false,
        nonBlocking: true,
      }),
      expect.objectContaining({
        requestId: "req-direct-7001",
        content: "完整回复",
        finish: true,
        nonBlocking: false,
      }),
    ]);

    const proactive = await adapter.send(
      proactiveDelivery(),
      {
        config: adapter.validateConfig(CONFIG),
        signal: new AbortController().signal,
        now: () => NOW,
      },
    );
    expect(proactive.externalMessageId)
      .toBe("wecom-send:group-product");
    expect(client.proactiveMessages).toEqual([{
      chatId: "group-product",
      content: "主动消息",
    }]);
    await adapter.stop("shutdown");
  },

  async assertHealth() {
    const client = createFakeWeComClient({
      startError: mapWeComError({
        name: "WeComEligibilityError",
        code: "WECOM_BOT_NOT_ELIGIBLE",
        message: CONFIG.secret,
      }),
    });
    const adapter = testAdapter(client);
    await expect(
      adapter.start(runtimeContext(adapter)),
    ).rejects.toMatchObject({
      code: "runtime_prerequisite_missing",
      detail: "wecom_bot_eligibility_required",
    });
    const health = await adapter.health();
    expect(health).toMatchObject({
      status: "degraded",
      reconnectAttempts: 1,
      error: {
        code: "runtime_prerequisite_missing",
        detail: "wecom_bot_eligibility_required",
      },
    });
    expect(JSON.stringify(health)).not.toContain(CONFIG.secret);
  },

  async assertShutdown() {
    const client = createFakeWeComClient();
    const adapter = testAdapter(client);
    const controller = new AbortController();
    await adapter.start(
      runtimeContext(adapter, controller.signal),
    );
    controller.abort();
    await vi.waitFor(async () => {
      expect(client.stops).toBe(1);
      expect(await adapter.health()).toMatchObject({
        status: "stopped",
      });
    });
  },
});

describe("WeCom AIBot protocol boundaries", () => {
  it("registers the production adapter", () => {
    const registry = new ChannelAdapterRegistry();
    registerWeComChannelAdapter(registry);

    expect(registry.registeredTypes()).toEqual(["wecom"]);
    expect(
      registry.create("wecom", { now: () => NOW }).manifest.type,
    ).toBe("wecom");
  });

  it("commits ingress before returning from the SDK callback", async () => {
    const client = createFakeWeComClient();
    const order: string[] = [];
    let attachmentFetcher:
      | ReturnType<typeof createWeComAttachmentFetcher>
      | undefined;
    const adapter = createWeComAdapter({
      clientFactory: () => client,
      scope: {
        userId: CONTEXT.userId,
        agentId: CONTEXT.agentId,
      },
      acceptInbound: async (
        _payload,
        _context,
        _scope,
        fetcher,
      ) => {
        attachmentFetcher = fetcher;
        order.push("durable_ingress");
        return {
          kind: "accepted" as const,
          eventId: "event-wecom-1",
        };
      },
      now: () => NOW,
    });
    await adapter.start(runtimeContext(adapter));

    await client.emitMessage(
      await fixture("message-direct-text.json"),
      order,
    );
    expect(order).toEqual([
      "durable_ingress",
      "sdk_callback_resolved",
    ]);
    expect(attachmentFetcher).toBeDefined();
    await adapter.stop("shutdown");
  });

  it("sends configured welcome text for enter_chat", async () => {
    const client = createFakeWeComClient();
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter));

    await client.emitWelcome(
      await fixture("event-enter-chat.json"),
    );
    expect(client.welcomeReplies).toEqual([{
      requestId: "req-welcome-7003",
      content: CONFIG.welcome_text,
    }]);
    await adapter.stop("shutdown");
  });

  it("persists and deduplicates enter_chat before sending welcome text", async () => {
    const client = createFakeWeComClient();
    const acceptWelcome = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const adapter = createWeComAdapter({
      clientFactory: () => client,
      scope: {
        userId: CONTEXT.userId,
        agentId: CONTEXT.agentId,
      },
      acceptInbound: async () => ({
        kind: "accepted",
        eventId: "event-wecom-1",
      }),
      acceptWelcome,
      now: () => NOW,
    });
    await adapter.start(runtimeContext(adapter));
    const event = await fixture("event-enter-chat.json");

    await client.emitWelcome(event);
    await client.emitWelcome(event);

    expect(acceptWelcome).toHaveBeenCalledTimes(2);
    expect(client.welcomeReplies).toEqual([{
      requestId: "req-welcome-7003",
      content: CONFIG.welcome_text,
    }]);
    await adapter.stop("shutdown");
  });

  it("maps eligibility, credential, and reconnect failures without reflecting secrets", async () => {
    const errors = await fixture("errors.json") as Array<{
      name: string;
      code: string;
      expectedCode: string;
      expectedDetail: string;
      retryable: boolean;
    }>;
    for (const entry of errors) {
      const error = mapWeComError({
        name: entry.name,
        code: entry.code,
        message: CONFIG.secret,
      });
      expect(error).toMatchObject({
        code: entry.expectedCode,
        detail: entry.expectedDetail,
        retryable: entry.retryable,
        message: entry.expectedCode,
      });
    }
  });

  it("tracks disconnect and returns to healthy after SDK re-authentication", async () => {
    const client = createFakeWeComClient();
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter));

    client.emitDisconnected(CONFIG.secret);
    expect(await adapter.health()).toMatchObject({
      status: "degraded",
      error: {
        code: "network_unreachable",
        detail: "wecom_disconnected",
      },
    });
    expect(JSON.stringify(await adapter.health()))
      .not.toContain(CONFIG.secret);

    client.emitReconnecting(2);
    expect(await adapter.health()).toMatchObject({
      status: "connecting",
      reconnectAttempts: 2,
    });
    client.emitAuthenticated();
    expect(await adapter.health()).toMatchObject({
      status: "healthy",
      reconnectAttempts: 0,
    });
    await adapter.stop("shutdown");
  });

  it("downloads only validated HTTPS media and uploads through the SDK chunk API", async () => {
    const client = createFakeWeComClient();
    const descriptor = (
      await testAdapter(client).normalizeInbound(
        await fixture("message-group-file.json"),
        CONTEXT,
      )
    )?.attachments[0];
    expect(descriptor).toBeDefined();
    const fetcher = createWeComAttachmentFetcher(client);
    const metadata = await fetcher.inspect(descriptor!);
    const chunks: Uint8Array[] = [];
    for await (const chunk of await fetcher.download(descriptor!)) {
      chunks.push(chunk);
    }
    expect(metadata).toEqual({
      fileName: "需求.txt",
      mimeType: "text/plain",
      sizeBytes: 13,
    });
    expect(Buffer.concat(chunks)).toEqual(
      Buffer.from("wecom fixture"),
    );
    expect(client.downloads).toEqual([{
      url: expect.stringContaining("wework.qpic.cn"),
      aesKey: "fixture-aes-key",
    }]);

    const uploaded = await uploadWeComMedia(client, {
      bytes: Buffer.alloc(600 * 1024, 7),
      fileName: "large.bin",
      mediaType: "file",
    });
    expect(uploaded).toEqual({ mediaId: "media-1" });
    expect(client.uploads[0]).toMatchObject({
      fileName: "large.bin",
      mediaType: "file",
      byteLength: 600 * 1024,
    });
  });

  it("keeps the image hint when the download header only reports a generic filename", async () => {
    const client = createFakeWeComClient({
      downloadResult: {
        bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        fileName: "download.bin",
      },
    });
    const fetcher = createWeComAttachmentFetcher(client);
    await expect(fetcher.inspect({
      externalAttachmentId: "image-1",
      fileName: "wecom-image.jpg",
      mimeType: "image/jpeg",
      sizeBytes: null,
      source: {
        url: "https://wework.qpic.cn/wwpic/aibot/image-1",
        aesKey: "image-aes-key",
      },
    })).resolves.toEqual({
      fileName: "wecom-image.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 4,
    });
  });
});

type FakeClient = WeComClientPort & {
  starts: number;
  stops: number;
  receivedConfig: Record<string, unknown> | null;
  streamReplies: Array<Record<string, unknown>>;
  proactiveMessages: Array<Record<string, unknown>>;
  welcomeReplies: Array<Record<string, unknown>>;
  downloads: Array<Record<string, unknown>>;
  uploads: Array<Record<string, unknown>>;
  emitMessage(
    payload: unknown,
    order?: string[],
  ): Promise<void>;
  emitWelcome(payload: unknown): Promise<void>;
  emitDisconnected(reason: string): void;
  emitReconnecting(attempt: number): void;
  emitAuthenticated(): void;
};

function createFakeWeComClient(
  options: Readonly<{
    startError?: Error;
    downloadResult?: Readonly<{
      bytes: Uint8Array;
      fileName?: string;
    }>;
  }> = {},
): FakeClient {
  let callbacks:
    | Parameters<WeComClientPort["start"]>[0]
    | null = null;
  const client: FakeClient = {
    starts: 0,
    stops: 0,
    receivedConfig: null,
    streamReplies: [],
    proactiveMessages: [],
    welcomeReplies: [],
    downloads: [],
    uploads: [],
    async start(input) {
      client.starts += 1;
      callbacks = input;
      client.receivedConfig = input.config;
      if (options.startError) throw options.startError;
      input.onAuthenticated();
    },
    async stop() {
      client.stops += 1;
      callbacks = null;
    },
    async replyStream(input) {
      client.streamReplies.push({ ...input });
      return {
        messageId: `wecom-stream:${input.streamId}`,
        skipped: false,
      };
    },
    async sendMarkdown(input) {
      client.proactiveMessages.push({ ...input });
      return { messageId: `wecom-send:${input.chatId}` };
    },
    async replyWelcome(input) {
      client.welcomeReplies.push({ ...input });
    },
    async downloadFile(input) {
      client.downloads.push({ ...input });
      return options.downloadResult ?? {
        bytes: Buffer.from("wecom fixture"),
        fileName: "需求.txt",
      };
    },
    async uploadMedia(input) {
      client.uploads.push({
        fileName: input.fileName,
        mediaType: input.mediaType,
        byteLength: input.bytes.byteLength,
      });
      return { mediaId: "media-1" };
    },
    async emitMessage(payload, order = []) {
      await callbacks?.onMessage(payload);
      order.push("sdk_callback_resolved");
    },
    async emitWelcome(payload) {
      await callbacks?.onWelcome(payload);
    },
    emitDisconnected(reason) {
      callbacks?.onDisconnected(reason);
    },
    emitReconnecting(attempt) {
      callbacks?.onReconnecting(attempt);
    },
    emitAuthenticated() {
      callbacks?.onAuthenticated();
    },
  };
  return client;
}

function testAdapter(
  client: FakeClient,
  config: unknown = CONFIG,
) {
  const adapter = createWeComAdapter({
    clientFactory: () => client,
    autoListen: false,
    now: () => NOW,
  });
  adapter.validateConfig(config);
  return adapter;
}

function runtimeContext(
  adapter: ReturnType<typeof createWeComAdapter>,
  signal = new AbortController().signal,
) {
  return {
    connectionId: CONTEXT.connectionId,
    agentId: CONTEXT.agentId,
    config: adapter.validateConfig(CONFIG),
    signal,
    now: () => NOW,
  };
}

function outboundDelivery() {
  return {
    id: "delivery-wecom-1",
    eventId: "event-wecom-1",
    connectionId: CONTEXT.connectionId,
    assistantMessageId: "assistant-message-wecom-1",
    body: "第一段",
    recipient: {
      externalConversationId: "user-alice",
      externalUserId: "user-alice",
      chatType: "direct" as const,
    },
    replyHandle: {
      publicFields: {
        chatId: "user-alice",
        senderId: "user-alice",
        messageId: "msg-7001",
      },
      secretFields: {
        requestId: "req-direct-7001",
      },
      expiresAt: new Date(NOW.getTime() + 10 * 60 * 1_000),
    },
  };
}

function proactiveDelivery() {
  return {
    id: "delivery-wecom-proactive-1",
    eventId: null,
    connectionId: CONTEXT.connectionId,
    assistantMessageId: "assistant-message-wecom-proactive-1",
    body: "主动消息",
    recipient: {
      externalConversationId: "group-product",
      chatType: "group" as const,
    },
  };
}

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(
      path.join(
        process.cwd(),
        "tests",
        "fixtures",
        "channels",
        "wecom",
        name,
      ),
      "utf8",
    ),
  ) as unknown;
}
