import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createFeishuAdapter,
} from "@/server/channels/adapters/feishu";
import {
  createFeishuAttachmentFetcher,
  createFeishuSdkClient,
  createTenantTokenCache,
  FeishuTransportError,
  feishuBaseUrl,
  mapFeishuResponse,
  type FeishuClientPort,
} from "@/server/channels/adapters/feishu/transport";
import {
  ChannelAdapterRegistry,
  registerFeishuChannelAdapter,
} from "@/server/channels/runtime/registry";
import {
  assertStableExternalEventId,
  defineChannelContract,
} from "@/server/channels/testing/contract";
import {
  createFakeHttpClient,
} from "@/server/channels/testing/fixtures";

const NOW = new Date("2026-07-26T00:00:00.000Z");
const CONTEXT = {
  connectionId: "connection-feishu",
  userId: "user-1",
  agentId: "agent-1",
  receivedAt: NOW,
};
const CONFIG = {
  enabled: true,
  app_id: "cli_0123456789abcdef",
  app_secret: "feishu-secret",
  encrypt_key: "encrypt-key",
  verification_token: "verification-token",
  domain: "feishu",
  streaming_enabled: true,
  share_session_in_group: false,
};

defineChannelContract({
  type: "feishu",
  assertConfig() {
    const adapter = createFeishuAdapter({
      clientFactory: () => createFakeFeishuClient(),
      autoListen: false,
    });
    expect(adapter.validateConfig(CONFIG)).toMatchObject({
      app_id: "cli_0123456789abcdef",
      domain: "feishu",
      streaming_enabled: true,
    });
    expect(() =>
      adapter.validateConfig({ ...CONFIG, app_secret: "" })
    ).toThrow("feishu_app_secret_required");
    expect(() =>
      adapter.validateConfig({ ...CONFIG, app_id: "cli_invalid" })
    ).toThrow("feishu_app_id_invalid");
  },
  async assertLifecycle() {
    const client = createFakeFeishuClient();
    const adapter = testAdapter(client);
    const context = runtimeContext(adapter);
    await Promise.all([adapter.start(context), adapter.start(context)]);
    await adapter.stop("reconfigure");
    await adapter.stop("reconfigure");
    expect(client.starts).toBe(1);
    expect(client.stops).toBe(1);
    expect(await adapter.health()).toMatchObject({ status: "stopped" });
    expect(JSON.stringify(await adapter.health()))
      .not.toContain(CONFIG.app_secret);
  },
  async assertInbound() {
    const client = createFakeFeishuClient();
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter));
    const direct = await adapter.normalizeInbound(
      await fixture("message-p2p.json"),
      CONTEXT,
    );
    const group = await adapter.normalizeInbound(
      await fixture("message-group-file.json"),
      CONTEXT,
    );
    expect(direct).toMatchObject({
      externalEventId: "event:9f8e7d",
      externalConversationId: "oc_chat_1",
      externalSenderId: "ou_user_1",
      chatType: "direct",
      mentioned: true,
      text: "你好",
    });
    expect(group).toMatchObject({
      externalEventId: "event:9f8e7e",
      externalConversationId: "oc_chat_2:ou_user_2",
      externalSenderId: "ou_user_2",
      chatType: "group",
      mentioned: true,
      attachments: [{
        externalAttachmentId: "file_v2_key",
        fileName: "notes.txt",
        source: {
          messageId: "om_message_2",
          fileKey: "file_v2_key",
          resourceType: "file",
        },
      }],
    });
    expect(group?.permission).toMatchObject({
      webSearch: false,
      tools: false,
      attachmentsPresent: true,
    });

    // Formatted content arrives as `post`, not `text`. Dropping it made pasted
    // lists and image-with-caption messages look like the bot ignored them.
    const post = await adapter.normalizeInbound(
      await fixture("message-p2p-post.json"),
      CONTEXT,
    );
    expect(post).toMatchObject({
      externalEventId: "event:9f8e7d-post",
      chatType: "direct",
      text: "比较价格\n1. 先从价格入手[官方文档](https://help.aliyun.com/)\n@小唐\n2. 再看缓存命中",
      attachments: [{
        externalAttachmentId: "img_post_1",
        mimeType: "image/jpeg",
        source: {
          messageId: "om_message_3",
          imageKey: "img_post_1",
          resourceType: "image",
        },
      }],
    });
    await adapter.stop("shutdown");
  },
  async assertStableIds() {
    const client = createFakeFeishuClient();
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter));
    const payload = await fixture("message-p2p.json");
    await expect(
      assertStableExternalEventId(() =>
        adapter.normalizeInbound(payload, CONTEXT)
      ),
    ).resolves.toBe("event:9f8e7d");
    await adapter.stop("shutdown");
  },
  async assertOutbound() {
    const client = createFakeFeishuClient();
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter));
    const delivery = outboundDelivery();
    const first = await adapter.send(delivery, {
      config: adapter.validateConfig(CONFIG),
      signal: new AbortController().signal,
      now: () => NOW,
    });
    const streamed = await adapter.streaming?.(delivery, {
      sequence: 2,
      final: true,
      previousResult: first,
    });
    expect(first.externalMessageId).toBe("om_sent_1");
    expect(first.rawSummary).toMatchObject({
      cardId: "card-1",
    });
    expect(streamed?.externalMessageId).toBe("om_sent_1");
    expect(client.sent).toEqual([{
      chatId: "oc_chat_2",
      replyToMessageId: "om_message_2",
      text: "完整回复",
      streaming: true,
    }]);
    expect(client.updated).toEqual([{
      messageId: "om_sent_1",
      cardId: "card-1",
      text: "完整回复",
      sequence: 2,
      final: true,
    }]);
    expect(adapter.typing).toBeUndefined();
    await adapter.stop("shutdown");
  },
  async assertHealth() {
    const client = createFakeFeishuClient({
      startError: new FeishuTransportError({
        code: "credential_invalid",
        retryable: false,
      }),
    });
    const adapter = testAdapter(client);
    await expect(
      adapter.start(runtimeContext(adapter)),
    ).rejects.toMatchObject({ code: "credential_invalid" });
    expect(await adapter.health()).toMatchObject({
      status: "degraded",
      error: { code: "credential_invalid" },
    });
  },
  async assertShutdown() {
    const client = createFakeFeishuClient();
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

describe("Feishu WebSocket and OpenAPI", () => {
  it("registers the adapter and maps both domains", () => {
    const registry = new ChannelAdapterRegistry();
    registerFeishuChannelAdapter(registry);
    expect(registry.registeredTypes()).toEqual(["feishu"]);
    expect(feishuBaseUrl("feishu")).toBe(
      "https://open.feishu.cn/open-apis",
    );
    expect(feishuBaseUrl("lark")).toBe(
      "https://open.larksuite.com/open-apis",
    );
  });

  it("shares a group conversation only when configured", async () => {
    const client = createFakeFeishuClient();
    const isolated = testAdapter(client);
    await isolated.start(runtimeContext(isolated));
    const payload = await fixture("message-group-file.json");
    await expect(
      isolated.normalizeInbound(payload, CONTEXT),
    ).resolves.toMatchObject({
      externalConversationId: "oc_chat_2:ou_user_2",
    });

    const shared = createFeishuAdapter({
      clientFactory: () => createFakeFeishuClient(),
      autoListen: false,
    });
    const sharedConfig = shared.validateConfig({
      ...CONFIG,
      share_session_in_group: true,
    });
    await shared.start({
      ...runtimeContext(shared),
      config: sharedConfig,
    });
    await expect(
      shared.normalizeInbound(payload, CONTEXT),
    ).resolves.toMatchObject({
      externalConversationId: "oc_chat_2",
    });
    await isolated.stop("shutdown");
    await shared.stop("shutdown");
  });

  it("refreshes tenant tokens once and five minutes before expiry", async () => {
    const load = vi.fn(async () => ({
      token: "tenant-token",
      expiresInSeconds: 3_600,
    }));
    const cache = createTenantTokenCache({
      load,
      now: () => NOW,
    });
    const [first, second] = await Promise.all([
      cache.get(),
      cache.get(),
    ]);
    expect(first).toBe("tenant-token");
    expect(second).toBe("tenant-token");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("maps non-zero OpenAPI codes without exposing response content", () => {
    expect(() => mapFeishuResponse({
      status: 200,
      body: { code: 99991663, msg: CONFIG.app_secret },
    })).toThrowError(
      expect.objectContaining({
        code: "credential_invalid",
        retryable: false,
      }),
    );
    expect(() => mapFeishuResponse({
      status: 429,
      headers: { "retry-after": "2.5" },
      body: { code: 99991400 },
    })).toThrowError(
      expect.objectContaining({
        code: "rate_limited",
        retryable: true,
        retryAfterMs: 2_500,
      }),
    );
  });

  it("downloads media through an encrypted locator without exposing credentials", async () => {
    const http = createFakeHttpClient();
    http.enqueue({
      status: 200,
      body: {
        code: 0,
        tenant_access_token: "tenant-token",
        expire: 7_200,
      },
    });
    http.enqueue({
      status: 200,
      body: new TextEncoder().encode("hello"),
    });
    const fetcher = createFeishuAttachmentFetcher(
      createFeishuAdapter({
        clientFactory: () => createFakeFeishuClient(),
        autoListen: false,
      }).validateConfig(CONFIG),
      http,
    );
    const descriptor = {
      externalAttachmentId: "file_v2_key",
      fileName: "notes.txt",
      mimeType: null,
      sizeBytes: null,
      source: {
        messageId: "om_message_2",
        fileKey: "file_v2_key",
        resourceType: "file",
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
    expect(http.requests).toHaveLength(2);
    expect(http.requests[1]).toMatchObject({
      method: "GET",
      responseType: "bytes",
      headers: { authorization: "[REDACTED]" },
    });
    const serialized = JSON.stringify(http.requests);
    expect(serialized).not.toContain(CONFIG.app_secret);
    expect(serialized).not.toContain("tenant-token");
  });

  it("creates, updates, and finalizes one CardKit instance in sequence", async () => {
    const http = createFakeHttpClient();
    http.enqueue({
      status: 200,
      body: {
        code: 0,
        tenant_access_token: "tenant-token",
        expire: 7_200,
      },
    });
    http.enqueue({
      status: 200,
      body: { code: 0, data: { card_id: "card-1" } },
    });
    http.enqueue({
      status: 200,
      body: { code: 0, data: { message_id: "om-card-1" } },
    });
    http.enqueue({ status: 200, body: { code: 0 } });
    http.enqueue({ status: 200, body: { code: 0 } });
    const config = createFeishuAdapter({
      clientFactory: () => createFakeFeishuClient(),
      autoListen: false,
    }).validateConfig(CONFIG);
    const client = createFeishuSdkClient(config, { http });

    await expect(client.send({
      chatId: "oc_chat_2",
      replyToMessageId: "om_message_2",
      text: "第一段",
      streaming: true,
    })).resolves.toEqual({
      messageId: "om-card-1",
      cardId: "card-1",
    });
    await client.updateCard({
      messageId: "om-card-1",
      text: "完整回复",
      sequence: 2,
      final: true,
    });

    expect(http.requests.map((request) => request.method)).toEqual([
      "POST",
      "POST",
      "POST",
      "PUT",
      "PATCH",
    ]);
    expect(http.requests[1]).toMatchObject({
      url: expect.stringContaining("/cardkit/v1/cards"),
      body: {
        type: "card_json",
        data: expect.stringContaining("\"streaming_mode\":true"),
      },
    });
    expect(http.requests[2]).toMatchObject({
      url: expect.stringContaining(
        "/im/v1/messages/om_message_2/reply",
      ),
      body: {
        msg_type: "interactive",
        content: expect.stringContaining("\"card_id\":\"card-1\""),
      },
    });
    expect(http.requests[3]).toMatchObject({
      url: expect.stringContaining(
        "/elements/streaming_content/content",
      ),
      body: {
        content: "完整回复",
        sequence: 2,
        uuid: expect.any(String),
      },
    });
    expect(http.requests[4]).toMatchObject({
      url: expect.stringContaining("/card-1/settings"),
      body: {
        settings: expect.stringContaining(
          "\"streaming_mode\":false",
        ),
        sequence: 3,
        uuid: expect.any(String),
      },
    });
    await client.stop();
  });

  it("finalizes a single-segment CardKit reply immediately", async () => {
    const client = createFakeFeishuClient();
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter));

    const result = await adapter.streaming!(
      outboundDelivery(),
      {
        sequence: 1,
        final: true,
        previousResult: null,
      },
    );

    expect(result.rawSummary).toMatchObject({
      cardId: "card-1",
      edited: true,
    });
    expect(client.updated).toEqual([{
      messageId: "om_sent_1",
      cardId: "card-1",
      text: "完整回复",
      sequence: 1,
      final: true,
    }]);
    await adapter.stop("shutdown");
  });
});

function testAdapter(client: FakeFeishuClient) {
  return createFeishuAdapter({
    clientFactory: () => client,
    autoListen: false,
    now: () => NOW,
  });
}

function runtimeContext(
  adapter: ReturnType<typeof createFeishuAdapter>,
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
    id: "delivery-1",
    eventId: "event-1",
    connectionId: CONTEXT.connectionId,
    assistantMessageId: "assistant-1",
    body: "完整回复",
    recipient: {
      externalConversationId: "oc_chat_2:ou_user_2",
    },
    replyHandle: {
      publicFields: {
        chatId: "oc_chat_2",
        messageId: "om_message_2",
      },
      secretFields: {},
      expiresAt: null,
    },
  };
}

type FakeFeishuClient = FeishuClientPort & {
  starts: number;
  stops: number;
  sent: unknown[];
  updated: unknown[];
};

function createFakeFeishuClient(options: Readonly<{
  startError?: Error;
}> = {}): FakeFeishuClient {
  return {
    starts: 0,
    stops: 0,
    sent: [],
    updated: [],
    async start() {
      this.starts += 1;
      if (options.startError) throw options.startError;
      return { botOpenId: "ou_bot" };
    },
    async stop() {
      this.stops += 1;
    },
    async send(input) {
      this.sent.push(input);
      return {
        messageId: "om_sent_1",
        cardId: "card-1",
      };
    },
    async updateCard(input) {
      this.updated.push(input);
    },
  };
}

async function fixture(name: string): Promise<Record<string, unknown>> {
  const value = JSON.parse(
    await readFile(
      path.join(
        process.cwd(),
        "tests/fixtures/channels/feishu",
        name,
      ),
      "utf8",
    ),
  ) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("feishu_fixture_invalid");
  }
  return value as Record<string, unknown>;
}
