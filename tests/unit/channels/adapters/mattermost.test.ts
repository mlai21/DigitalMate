import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createMattermostAdapter,
} from "@/server/channels/adapters/mattermost";
import {
  createMattermostAttachmentFetcher,
  mapMattermostError,
  MattermostTransportError,
  mattermostWebSocketUrl,
  type MattermostClientPort,
} from "@/server/channels/adapters/mattermost/transport";
import {
  createFakeHttpClient,
} from "@/server/channels/testing/fixtures";
import {
  ChannelAdapterRegistry,
  registerMattermostChannelAdapter,
} from "@/server/channels/runtime/registry";
import {
  assertStableExternalEventId,
  defineChannelContract,
} from "@/server/channels/testing/contract";

const NOW = new Date("2026-07-26T00:00:00.000Z");
const CONTEXT = {
  connectionId: "connection-mattermost",
  userId: "user-1",
  agentId: "agent-1",
  receivedAt: NOW,
};
const CONFIG = {
  enabled: true,
  url: "https://mattermost.example.com",
  bot_token: "mattermost-secret",
  show_typing: true,
  thread_follow_without_mention: true,
};

defineChannelContract({
  type: "mattermost",

  assertConfig() {
    const adapter = createMattermostAdapter({
      clientFactory: () => createFakeMattermostClient(),
      autoListen: false,
    });
    expect(adapter.validateConfig(CONFIG)).toMatchObject({
      url: CONFIG.url,
      bot_token: CONFIG.bot_token,
      thread_follow_without_mention: true,
    });
    expect(() =>
      adapter.validateConfig({ ...CONFIG, bot_token: "" })
    ).toThrow("mattermost_bot_token_required");
  },

  async assertLifecycle() {
    const client = createFakeMattermostClient();
    const adapter = testAdapter(client);
    const context = runtimeContext(adapter);

    await Promise.all([
      adapter.start(context),
      adapter.start(context),
    ]);
    await adapter.stop("reconfigure");
    await adapter.stop("reconfigure");

    expect(client.starts).toBe(1);
    expect(client.stops).toBe(1);
    expect(await adapter.health()).toMatchObject({
      status: "stopped",
      reconnectAttempts: 0,
    });
    expect(JSON.stringify(await adapter.health()))
      .not.toContain(CONFIG.bot_token);
  },

  async assertInbound() {
    const client = createFakeMattermostClient();
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter));
    const direct = await adapter.normalizeInbound(
      await fixture("posted-direct.json"),
      CONTEXT,
    );
    const group = await adapter.normalizeInbound(
      await fixture("posted-thread-file.json"),
      CONTEXT,
    );

    expect(direct).toMatchObject({
      externalEventId: "post:post-123",
      externalConversationId: "channel-dm",
      externalSenderId: "user-100",
      chatType: "direct",
      mentioned: true,
    });
    expect(group).toMatchObject({
      externalEventId: "post:post-124",
      externalConversationId: "channel-team",
      externalSenderId: "user-101",
      chatType: "group",
      mentioned: true,
      text: "看一下附件",
      thread: {
        externalThreadId: "root-100",
        replyToEventId: "root-100",
      },
      attachments: [{
        externalAttachmentId: "file-100",
        fileName: null,
        mimeType: null,
        sizeBytes: null,
        source: { fileId: "file-100" },
      }],
    });
    await adapter.stop("shutdown");
  },

  async assertStableIds() {
    const client = createFakeMattermostClient();
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter));
    const payload = await fixture("posted-direct.json");

    await expect(
      assertStableExternalEventId(() =>
        adapter.normalizeInbound(payload, CONTEXT)
      ),
    ).resolves.toBe("post:post-123");
    await adapter.stop("shutdown");
  },

  async assertOutbound() {
    const client = createFakeMattermostClient();
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter));
    const delivery = outboundDelivery();
    const result = await adapter.send(delivery, {
      config: adapter.validateConfig(CONFIG),
      signal: new AbortController().signal,
      now: () => NOW,
    });
    const recipient = await adapter.resolveRecipient(
      delivery.recipient,
    );
    await adapter.typing?.(recipient, true);

    expect(result.externalMessageId).toBe("post-sent-1");
    expect(client.posted).toEqual([{
      channelId: "channel-team",
      message: "完整回复",
      rootId: "root-100",
    }]);
    expect(client.typing).toEqual([{
      userId: "bot-user",
      channelId: "channel-team",
      parentId: "root-100",
    }]);
    await adapter.stop("shutdown");
  },

  async assertHealth() {
    const client = createFakeMattermostClient({
      startError: new MattermostTransportError({
        code: "credential_invalid",
        retryable: false,
      }),
    });
    const adapter = testAdapter(client);
    await expect(
      adapter.start(runtimeContext(adapter)),
    ).rejects.toMatchObject({
      code: "credential_invalid",
    });
    expect(await adapter.health()).toMatchObject({
      status: "degraded",
      error: { code: "credential_invalid" },
    });
  },

  async assertShutdown() {
    const client = createFakeMattermostClient();
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

describe("Mattermost WebSocket transaction boundary", () => {
  it("registers the production adapter and resolves the websocket path", () => {
    const registry = new ChannelAdapterRegistry();
    registerMattermostChannelAdapter(registry);

    expect(registry.registeredTypes()).toEqual(["mattermost"]);
    expect(mattermostWebSocketUrl(CONFIG.url)).toBe(
      "wss://mattermost.example.com/api/v4/websocket",
    );
  });

  it("passes monotonic sequence values and durable events to ingress", async () => {
    const client = createFakeMattermostClient();
    const acceptInbound = vi.fn(async () => ({
      kind: "accepted" as const,
      eventId: "event-1",
    }));
    const adapter = createMattermostAdapter({
      clientFactory: () => client,
      scope: {
        userId: CONTEXT.userId,
        agentId: CONTEXT.agentId,
      },
      acceptInbound,
      now: () => NOW,
    });
    await adapter.start(runtimeContext(adapter));

    await client.emitEvent(await fixture("posted-direct.json"));
    await client.emitEvent(await fixture("posted-direct.json"));

    expect(acceptInbound).toHaveBeenCalledTimes(1);
    await adapter.stop("shutdown");
  });

  it("follows a thread after the Bot has replied without requiring another mention", async () => {
    const client = createFakeMattermostClient();
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter));
    await adapter.send(outboundDelivery(), {
      config: adapter.validateConfig(CONFIG),
      signal: new AbortController().signal,
      now: () => NOW,
    });
    const payload = await fixture("posted-thread-file.json");
    const data = payload.data as Record<string, unknown>;
    const post = JSON.parse(String(data.post)) as Record<string, unknown>;
    post.message = "继续";

    await expect(adapter.normalizeInbound({
      ...payload,
      data: {
        ...data,
        post: JSON.stringify(post),
      },
    }, CONTEXT)).resolves.toMatchObject({
      mentioned: true,
      text: "继续",
    });
    await adapter.stop("shutdown");
  });

  it("ignores the current Bot user and maps HTTP errors", async () => {
    const client = createFakeMattermostClient();
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter));
    const payload = await fixture("posted-direct.json");
    const data = payload.data as Record<string, unknown>;
    const post = JSON.parse(String(data.post)) as Record<string, unknown>;
    post.user_id = "bot-user";

    await expect(adapter.normalizeInbound({
      ...payload,
      data: { ...data, post: JSON.stringify(post) },
    }, CONTEXT)).resolves.toBeNull();
    expect(mapMattermostError({
      status: 429,
      headers: { "retry-after": "2" },
    })).toMatchObject({
      code: "rate_limited",
      retryAfterMs: 2_000,
    });
    expect(mapMattermostError({ status: 403 })).toMatchObject({
      code: "permission_denied",
      retryable: false,
    });
    await adapter.stop("shutdown");
  });

  it("loads file metadata and bytes through authenticated REST calls", async () => {
    const http = createFakeHttpClient();
    http.enqueue({
      status: 200,
      body: {
        id: "file-100",
        name: "notes.txt",
        mime_type: "text/plain",
        size: 5,
      },
    });
    http.enqueue({
      status: 200,
      body: new TextEncoder().encode("hello"),
    });
    const adapter = createMattermostAdapter({
      clientFactory: () => createFakeMattermostClient(),
      autoListen: false,
    });
    const fetcher = createMattermostAttachmentFetcher(
      adapter.validateConfig(CONFIG),
      http,
    );
    const descriptor = {
      externalAttachmentId: "file-100",
      fileName: null,
      mimeType: null,
      sizeBytes: null,
      source: { fileId: "file-100" },
    };

    await expect(
      fetcher.inspect(descriptor),
    ).resolves.toEqual({
      fileName: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of await fetcher.download(descriptor)) {
      chunks.push(chunk);
    }
    expect(new TextDecoder().decode(chunks[0])).toBe("hello");
    expect(JSON.stringify(http.requests))
      .not.toContain(CONFIG.bot_token);
  });
});

function testAdapter(client: FakeMattermostClient) {
  return createMattermostAdapter({
    clientFactory: () => client,
    autoListen: false,
    now: () => NOW,
  });
}

function runtimeContext(
  adapter: ReturnType<typeof createMattermostAdapter>,
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
      externalConversationId: "channel-team",
      externalThreadId: "root-100",
    },
    replyHandle: {
      publicFields: {
        channelId: "channel-team",
        rootId: "root-100",
      },
      secretFields: {},
      expiresAt: null,
    },
  };
}

type FakeMattermostClient = MattermostClientPort & {
  starts: number;
  stops: number;
  posted: unknown[];
  typing: unknown[];
  emitEvent(payload: unknown): Promise<void>;
};

function createFakeMattermostClient(options: Readonly<{
  startError?: Error;
}> = {}): FakeMattermostClient {
  let eventListener:
    | ((payload: unknown) => Promise<void>)
    | null = null;
  return {
    starts: 0,
    stops: 0,
    posted: [],
    typing: [],
    async start(input) {
      this.starts += 1;
      eventListener = input.onEvent;
      if (options.startError) throw options.startError;
      return {
        botUserId: "bot-user",
        botUsername: "mate",
      };
    },
    async stop() {
      this.stops += 1;
    },
    async post(input) {
      this.posted.push(input);
      return { postId: `post-sent-${this.posted.length}` };
    },
    async sendTyping(input) {
      this.typing.push(input);
    },
    async emitEvent(payload) {
      await eventListener?.(payload);
    },
  };
}

async function fixture(name: string): Promise<Record<string, unknown>> {
  const value = JSON.parse(
    await readFile(
      path.join(
        process.cwd(),
        "tests/fixtures/channels/mattermost",
        name,
      ),
      "utf8",
    ),
  ) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("mattermost_fixture_invalid");
  }
  return value as Record<string, unknown>;
}
