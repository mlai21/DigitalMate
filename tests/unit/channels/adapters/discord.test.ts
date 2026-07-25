import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createDiscordAdapter,
} from "@/server/channels/adapters/discord";
import {
  createDiscordAttachmentFetcher,
  DiscordTransportError,
  discordProxyOptions,
  mapDiscordError,
  type DiscordClientPort,
} from "@/server/channels/adapters/discord/transport";
import {
  createFakeHttpClient,
} from "@/server/channels/testing/fixtures";
import {
  ChannelAdapterRegistry,
  registerDiscordChannelAdapter,
} from "@/server/channels/runtime/registry";
import {
  assertStableExternalEventId,
  defineChannelContract,
} from "@/server/channels/testing/contract";

const NOW = new Date("2026-07-26T00:00:00.000Z");
const CONTEXT = {
  connectionId: "connection-discord",
  userId: "user-1",
  agentId: "agent-1",
  receivedAt: NOW,
};
const CONFIG = {
  enabled: true,
  bot_token: "discord-secret",
  http_proxy: "",
  http_proxy_auth: "",
  accept_bot_messages: false,
  streaming_enabled: true,
};

defineChannelContract({
  type: "discord",

  assertConfig() {
    const adapter = createDiscordAdapter({
      clientFactory: () => createFakeDiscordClient(),
      autoListen: false,
    });

    expect(adapter.validateConfig(CONFIG)).toMatchObject({
      bot_token: CONFIG.bot_token,
      accept_bot_messages: false,
      streaming_enabled: true,
    });
    expect(() =>
      adapter.validateConfig({ ...CONFIG, bot_token: "" })
    ).toThrow("discord_bot_token_required");
  },

  async assertLifecycle() {
    const client = createFakeDiscordClient();
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
    const client = createFakeDiscordClient();
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter));
    const direct = await adapter.normalizeInbound(
      await fixture("message-direct.json"),
      CONTEXT,
    );
    const group = await adapter.normalizeInbound(
      await fixture("message-guild-thread.json"),
      CONTEXT,
    );

    expect(direct).toMatchObject({
      externalEventId: "message:1200456",
      externalConversationId: "dm-100",
      externalSenderId: "user-100",
      chatType: "direct",
      mentioned: true,
      attachments: [],
    });
    expect(group).toMatchObject({
      externalEventId: "message:1200457",
      externalConversationId: "thread-300",
      externalSenderId: "user-101",
      chatType: "group",
      mentioned: true,
      text: "看一下附件",
      thread: {
        externalThreadId: "thread-300",
        replyToEventId: "1200400",
      },
      attachments: [{
        externalAttachmentId: "attachment-1",
        fileName: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 128,
        source: {
          url: "https://cdn.discordapp.com/attachments/channel/message/notes.txt",
        },
      }],
    });
    expect(group?.permission).toMatchObject({
      webSearch: false,
      tools: false,
      skills: "none",
      attachmentsPresent: true,
    });
    await adapter.stop("shutdown");
  },

  async assertStableIds() {
    const client = createFakeDiscordClient();
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter));
    const payload = await fixture("message-direct.json");

    await expect(
      assertStableExternalEventId(() =>
        adapter.normalizeInbound(payload, CONTEXT)
      ),
    ).resolves.toBe("message:1200456");
    await adapter.stop("shutdown");
  },

  async assertOutbound() {
    const client = createFakeDiscordClient();
    const delays: number[] = [];
    const adapter = createDiscordAdapter({
      clientFactory: () => client,
      autoListen: false,
      delay: async (milliseconds) => {
        delays.push(milliseconds);
      },
      now: () => NOW,
    });
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
    const recipient = await adapter.resolveRecipient(
      delivery.recipient,
    );
    await adapter.typing?.(recipient, true);

    expect(first.externalMessageId).toBe("sent-1");
    expect(streamed?.externalMessageId).toBe("sent-1");
    expect(client.sent).toEqual([{
      channelId: "thread-300",
      userId: undefined,
      content: "完整回复",
      replyToMessageId: "1200457",
    }]);
    expect(client.edited).toEqual([{
      channelId: "thread-300",
      messageId: "sent-1",
      content: "完整回复",
    }]);
    expect(client.typing).toEqual(["thread-300"]);
    expect(delays).toEqual([500]);
    await adapter.stop("shutdown");
  },

  async assertHealth() {
    const client = createFakeDiscordClient({
      startError: new DiscordTransportError({
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
    expect(JSON.stringify(await adapter.health()))
      .not.toContain(CONFIG.bot_token);
  },

  async assertShutdown() {
    const client = createFakeDiscordClient();
    const adapter = testAdapter(client);
    const controller = new AbortController();
    await adapter.start(runtimeContext(adapter, controller.signal));

    controller.abort();
    await vi.waitFor(() => expect(client.stops).toBe(1));
    expect(await adapter.health()).toMatchObject({
      status: "stopped",
    });
  },
});

describe("Discord Gateway transaction boundary", () => {
  it("registers Gateway intents and the production factory", () => {
    const registry = new ChannelAdapterRegistry();
    registerDiscordChannelAdapter(registry);

    expect(registry.registeredTypes()).toEqual(["discord"]);
    expect(
      registry.create("discord", { now: () => NOW }).manifest.type,
    ).toBe("discord");
  });

  it("keeps proxy credentials out of the proxy URL", () => {
    expect(discordProxyOptions({
      http_proxy: "http://proxy.internal:8080",
      http_proxy_auth: "proxy-user:proxy-password",
    })).toEqual({
      uri: "http://proxy.internal:8080",
      token: `Basic ${
        Buffer.from(
          "proxy-user:proxy-password",
          "utf8",
        ).toString("base64")
      }`,
    });
  });

  it("ignores self and other bots unless explicitly allowed", async () => {
    const self = {
      ...(await fixture("message-direct.json")),
      author: { id: "bot-42", username: "mate", bot: true },
    };
    const otherBot = {
      ...(await fixture("message-direct.json")),
      id: "1200458",
      author: { id: "bot-99", username: "helper", bot: true },
    };
    const client = createFakeDiscordClient();
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter));

    await expect(
      adapter.normalizeInbound(self, CONTEXT),
    ).resolves.toBeNull();
    await expect(
      adapter.normalizeInbound(otherBot, CONTEXT),
    ).resolves.toBeNull();

    const permissive = createDiscordAdapter({
      clientFactory: () => createFakeDiscordClient(),
      autoListen: false,
    });
    permissive.validateConfig({
      ...CONFIG,
      accept_bot_messages: true,
    });
    await permissive.start({
      ...runtimeContext(permissive),
      config: permissive.validateConfig({
        ...CONFIG,
        accept_bot_messages: true,
      }),
    });
    await expect(
      permissive.normalizeInbound(otherBot, CONTEXT),
    ).resolves.toMatchObject({
      externalEventId: "message:1200458",
    });
    await adapter.stop("shutdown");
    await permissive.stop("shutdown");
  });

  it("recognizes a mention through one of the current Bot roles", async () => {
    const payload = {
      ...(await fixture("message-guild-thread.json")),
      id: "1200459",
      content: "<@&role-42> 处理这条消息",
      mentions: [],
      mentions_bot: false,
      mentioned_bot_role_ids: ["role-42"],
      attachments: [],
    };
    const client = createFakeDiscordClient();
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter));

    await expect(
      adapter.normalizeInbound(payload, CONTEXT),
    ).resolves.toMatchObject({
      mentioned: true,
      text: "处理这条消息",
    });
    await adapter.stop("shutdown");
  });

  it("durably accepts each Gateway event before returning", async () => {
    const client = createFakeDiscordClient();
    let release: () => void = () => {};
    const accepted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acceptInbound = vi.fn(async () => {
      await accepted;
      return {
        kind: "accepted" as const,
        eventId: "event-1",
      };
    });
    const adapter = createDiscordAdapter({
      clientFactory: () => client,
      scope: {
        userId: CONTEXT.userId,
        agentId: CONTEXT.agentId,
      },
      acceptInbound,
    });
    await adapter.start(runtimeContext(adapter));

    let completed = false;
    const emitted = client.emitMessage(
      await fixture("message-direct.json"),
    ).then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    release();
    await emitted;
    expect(acceptInbound).toHaveBeenCalledTimes(1);
    await adapter.stop("shutdown");
  });

  it("maps permission failures and 429 retry metadata", async () => {
    const client = createFakeDiscordClient();
    client.sendError = new DiscordTransportError({
      code: "rate_limited",
      retryable: true,
      retryAfterMs: 2_500,
    });
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter));

    await expect(
      adapter.send(outboundDelivery(), {
        config: adapter.validateConfig(CONFIG),
        signal: new AbortController().signal,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({
      code: "rate_limited",
      retryable: true,
      retryAfterMs: 2_500,
    });
    client.emitError(new DiscordTransportError({
      code: "permission_denied",
      retryable: false,
    }));
    await vi.waitFor(async () => {
      expect(await adapter.health()).toMatchObject({
        status: "degraded",
        error: { code: "permission_denied" },
      });
    });
    await adapter.stop("shutdown");
  });

  it("maps a Discord REST 429 response and downloads private attachment bytes", async () => {
    expect(mapDiscordError({
      status: 429,
      retry_after: 2.5,
      message: CONFIG.bot_token,
    })).toMatchObject({
      code: "rate_limited",
      retryable: true,
      retryAfterMs: 2_500,
    });

    const http = createFakeHttpClient();
    http.enqueue({
      status: 200,
      body: new TextEncoder().encode("hello"),
    });
    const fetcher = createDiscordAttachmentFetcher(
      createDiscordAdapter({
        clientFactory: () => createFakeDiscordClient(),
        autoListen: false,
      }).validateConfig(CONFIG),
      http,
    );
    const descriptor = {
      externalAttachmentId: "attachment-1",
      fileName: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      source: {
        url: "https://cdn.discordapp.com/attachments/c/m/notes.txt",
      },
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
    expect(http.requests).toEqual([{
      method: "GET",
      url: descriptor.source.url,
      headers: {},
      responseType: "bytes",
    }]);
  });
});

function testAdapter(client: FakeDiscordClient) {
  return createDiscordAdapter({
    clientFactory: () => client,
    autoListen: false,
    now: () => NOW,
  });
}

function runtimeContext(
  adapter: ReturnType<typeof createDiscordAdapter>,
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
      externalConversationId: "thread-300",
      externalThreadId: "thread-300",
    },
    replyHandle: {
      publicFields: {
        channelId: "thread-300",
        replyToMessageId: "1200457",
      },
      secretFields: {},
      expiresAt: null,
    },
  };
}

type FakeDiscordClient = DiscordClientPort & {
  starts: number;
  stops: number;
  sent: unknown[];
  edited: unknown[];
  typing: string[];
  sendError: Error | null;
  emitMessage(payload: unknown): Promise<void>;
  emitError(error: Error): void;
};

function createFakeDiscordClient(options: Readonly<{
  startError?: Error;
}> = {}): FakeDiscordClient {
  let messageListener:
    | ((payload: unknown) => Promise<void>)
    | null = null;
  let errorListener: ((error: Error) => void) | null = null;
  return {
    starts: 0,
    stops: 0,
    sent: [],
    edited: [],
    typing: [],
    sendError: null,
    async start(input) {
      this.starts += 1;
      messageListener = input.onMessage;
      errorListener = input.onError;
      if (options.startError) throw options.startError;
      return { botUserId: "bot-42" };
    },
    async stop() {
      this.stops += 1;
    },
    async sendMessage(input) {
      if (this.sendError) throw this.sendError;
      this.sent.push(input);
      return { messageId: `sent-${this.sent.length}` };
    },
    async editMessage(input) {
      this.edited.push(input);
    },
    async sendTyping(channelId) {
      this.typing.push(channelId);
    },
    async emitMessage(payload) {
      await messageListener?.(payload);
    },
    emitError(error) {
      errorListener?.(error);
    },
  };
}

async function fixture(name: string): Promise<Record<string, unknown>> {
  const value = JSON.parse(
    await readFile(
      path.join(
        process.cwd(),
        "tests/fixtures/channels/discord",
        name,
      ),
      "utf8",
    ),
  ) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("discord_fixture_invalid");
  }
  return value as Record<string, unknown>;
}
