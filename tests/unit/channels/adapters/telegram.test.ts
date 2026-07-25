import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createTelegramAdapter,
  type TelegramAdapterDependencies,
} from "@/server/channels/adapters/telegram";
import {
  createTelegramTransport,
  telegramProxyOptions,
} from "@/server/channels/adapters/telegram/transport";
import {
  assertStableExternalEventId,
  defineChannelContract,
} from "@/server/channels/testing/contract";
import {
  createFakeHttpClient,
} from "@/server/channels/testing/fixtures";
import {
  ChannelAdapterRegistry,
  registerTelegramChannelAdapter,
} from "@/server/channels/runtime/registry";

const NOW = new Date("2026-07-26T00:00:00.000Z");
const CONTEXT = {
  connectionId: "connection-telegram",
  userId: "user-1",
  agentId: "agent-1",
  receivedAt: NOW,
};
const CONFIG = {
  enabled: true,
  bot_token: "123456:telegram-secret",
  streaming_enabled: true,
  show_typing: true,
};

defineChannelContract({
  type: "telegram",

  assertConfig() {
    const adapter = createTelegramAdapter({ autoPoll: false });
    const config = adapter.validateConfig(CONFIG);

    expect(config).toMatchObject({
      bot_token: CONFIG.bot_token,
      streaming_enabled: true,
      show_typing: true,
    });
    expect(() =>
      adapter.validateConfig({
        ...CONFIG,
        bot_token: "",
      })
    ).toThrow();
  },

  async assertLifecycle() {
    const http = createFakeHttpClient();
    http.enqueue(telegramOk({ id: 42, username: "mate_bot" }));
    const adapter = createTelegramAdapter({
      http,
      autoPoll: false,
    });
    const controller = new AbortController();
    const runtimeContext = {
      connectionId: CONTEXT.connectionId,
      scope: {
        userId: CONTEXT.userId,
        agentId: CONTEXT.agentId,
      },
      agentId: CONTEXT.agentId,
      config: adapter.validateConfig(CONFIG),
      signal: controller.signal,
      now: () => NOW,
    };

    await Promise.all([
      adapter.start(runtimeContext),
      adapter.start(runtimeContext),
    ]);
    await adapter.stop("reconfigure");
    await adapter.stop("reconfigure");

    expect(http.requests).toHaveLength(1);
    expect(await adapter.health()).toMatchObject({
      status: "stopped",
      reconnectAttempts: 0,
    });
    expect(JSON.stringify(await adapter.health()))
      .not.toContain(CONFIG.bot_token);
  },

  async assertInbound() {
    const adapter = createTelegramAdapter({ autoPoll: false });
    const direct = await adapter.normalizeInbound(
      await fixture("update-direct.json"),
      CONTEXT,
    );
    const group = await adapter.normalizeInbound(
      await fixture("update-group-mention.json"),
      CONTEXT,
    );

    expect(direct).toMatchObject({
      externalEventId: "update:90001",
      externalConversationId: "123456",
      externalSenderId: "654321",
      chatType: "direct",
      mentioned: true,
      attachments: [],
    });
    expect(group).toMatchObject({
      externalEventId: "update:90002",
      externalConversationId: "-100123",
      chatType: "group",
      mentioned: true,
      thread: {
        externalThreadId: "12",
        replyToEventId: "71",
      },
      attachments: [{
        externalAttachmentId: "AgADunique",
        fileName: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 128,
        source: { fileId: "BQACAgQAAxkBAAIB" },
      }],
    });
    expect(group?.permission).toMatchObject({
      webSearch: false,
      tools: false,
      skills: "none",
      attachmentsPresent: true,
    });
  },

  async assertStableIds() {
    const payload = await fixture("update-direct.json");
    const adapter = createTelegramAdapter({ autoPoll: false });

    await expect(
      assertStableExternalEventId(() =>
        adapter.normalizeInbound(payload, CONTEXT)
      ),
    ).resolves.toBe("update:90001");
  },

  async assertOutbound() {
    const http = createFakeHttpClient();
    http.enqueue(telegramOk({ message_id: 88 }));
    http.enqueue(telegramOk({ message_id: 89 }));
    http.enqueue(telegramOk(true));
    const adapter = createTelegramAdapter({
      http,
      autoPoll: false,
    });
    adapter.validateConfig(CONFIG);
    const delivery = {
      id: "delivery-1",
      eventId: "event-1",
      connectionId: CONTEXT.connectionId,
      assistantMessageId: "assistant-1",
      body: "<你好> & 再见",
      recipient: {
        externalConversationId: "-100123",
        externalThreadId: "12",
      },
      replyHandle: {
        publicFields: {
          chatId: "-100123",
          messageThreadId: "12",
          replyToMessageId: "77",
        },
        secretFields: {},
        expiresAt: null,
      },
    };
    const sendContext = {
      config: adapter.validateConfig(CONFIG),
      signal: new AbortController().signal,
      now: () => NOW,
    };

    const first = await adapter.send(delivery, sendContext);
    const streamed = await adapter.streaming?.(
      delivery,
      {
        sequence: 2,
        final: true,
        previousResult: first,
      },
    );
    const recipient = await adapter.resolveRecipient(
      delivery.recipient,
    );
    await adapter.typing?.(recipient, true);

    expect(first.externalMessageId).toBe("88");
    expect(streamed?.externalMessageId).toBe("88");
    expect(http.requests.map((request) =>
      request.url.replace(/^.*\//u, "")
    )).toEqual([
      "sendMessage",
      "editMessageText",
      "sendChatAction",
    ]);
    expect(http.requests[0]?.body).toMatchObject({
      chat_id: "-100123",
      message_thread_id: 12,
      reply_to_message_id: 77,
      parse_mode: "HTML",
      text: "&lt;你好&gt; &amp; 再见",
    });
    expect(http.requests[1]?.body).toMatchObject({
      chat_id: "-100123",
      message_id: 88,
    });
  },

  async assertHealth() {
    const unauthorized = createFakeHttpClient();
    unauthorized.enqueue({
      status: 401,
      body: {
        ok: false,
        description: `bad ${CONFIG.bot_token}`,
      },
    });
    const adapter = createTelegramAdapter({
      http: unauthorized,
      autoPoll: false,
    });

    await expect(
      adapter.start({
        connectionId: CONTEXT.connectionId,
        agentId: CONTEXT.agentId,
        config: adapter.validateConfig(CONFIG),
        signal: new AbortController().signal,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "credential_invalid" });
    expect(await adapter.health()).toMatchObject({
      status: "degraded",
      error: { code: "credential_invalid" },
    });
    expect(JSON.stringify(await adapter.health()))
      .not.toContain(CONFIG.bot_token);
  },

  async assertShutdown() {
    const pollStarted = vi.fn();
    const http = blockingPollingHttp(pollStarted);
    const adapter = createTelegramAdapter({
      http,
      scope: {
        userId: CONTEXT.userId,
        agentId: CONTEXT.agentId,
      },
      acceptInbound: async () => ({ kind: "ignored" }),
    });
    await adapter.start({
      connectionId: CONTEXT.connectionId,
      agentId: CONTEXT.agentId,
      config: adapter.validateConfig(CONFIG),
      signal: new AbortController().signal,
      now: () => NOW,
    });
    await vi.waitFor(() => expect(pollStarted).toHaveBeenCalled());

    await adapter.stop("shutdown");

    expect(await adapter.health()).toMatchObject({
      status: "stopped",
    });
  },
});

describe("Telegram long polling transaction boundary", () => {
  it("maps proxy authentication without putting credentials in the URL", () => {
    expect(telegramProxyOptions({
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

  it("registers the production adapter factory", () => {
    const registry = new ChannelAdapterRegistry();
    registerTelegramChannelAdapter(registry);

    expect(registry.registeredTypes()).toEqual(["telegram"]);
    expect(
      registry.create("telegram", { now: () => NOW }).manifest.type,
    ).toBe("telegram");
  });

  it("does not poll when the connection is explicitly in webhook mode", async () => {
    const http = createFakeHttpClient();
    http.enqueue(telegramOk({ id: 42, username: "mate_bot" }));
    const acceptInbound = vi.fn();
    const adapter = createTelegramAdapter({
      http,
      scope: {
        userId: CONTEXT.userId,
        agentId: CONTEXT.agentId,
      },
      acceptInbound,
    });
    const config = adapter.validateConfig({
      ...CONFIG,
      webhook_secret: "webhook-secret",
    });

    await adapter.start({
      connectionId: CONTEXT.connectionId,
      agentId: CONTEXT.agentId,
      config,
      signal: new AbortController().signal,
      now: () => NOW,
    });
    await Promise.resolve();

    expect(http.requests).toHaveLength(1);
    expect(acceptInbound).not.toHaveBeenCalled();
    await adapter.stop("shutdown");
  });

  it("advances offset only after ingress resolves durably", async () => {
    const update = await fixture("update-direct.json");
    const http = createFakeHttpClient();
    http.enqueue(telegramOk([update]));
    http.enqueue(telegramOk([update]));
    const transport = createTelegramTransport({
      http,
      now: () => NOW,
    });
    const config = createTelegramAdapter({
      autoPoll: false,
    }).validateConfig(CONFIG);
    const rejectedIngress = vi.fn(async () => {
      throw new Error("database_unavailable");
    });

    await expect(
      transport.pollOnce({
        config,
        offset: 90001,
        context: CONTEXT,
        accept: rejectedIngress,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("database_unavailable");
    expect(rejectedIngress).toHaveBeenCalledTimes(1);

    const acceptedIngress = vi.fn(async () => ({
      kind: "accepted" as const,
      eventId: "stored-event-1",
    }));
    await expect(
      transport.pollOnce({
        config,
        offset: 90001,
        context: CONTEXT,
        accept: acceptedIngress,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(90002);
    expect(acceptedIngress).toHaveBeenCalledTimes(1);
  });

  it("maps polling conflict and rate limits without leaking token", async () => {
    const http = createFakeHttpClient();
    http.enqueue({
      status: 409,
      body: { ok: false, description: CONFIG.bot_token },
    });
    http.enqueue({
      status: 429,
      headers: { "retry-after": "3" },
      body: {
        ok: false,
        parameters: { retry_after: 3 },
      },
    });
    const transport = createTelegramTransport({
      http,
      now: () => NOW,
    });
    const config = createTelegramAdapter({
      autoPoll: false,
    }).validateConfig(CONFIG);
    const input = {
      config,
      offset: 0,
      context: CONTEXT,
      accept: vi.fn(),
      signal: new AbortController().signal,
    };

    await expect(transport.pollOnce(input)).rejects.toMatchObject({
      code: "polling_conflict",
      retryable: true,
    });
    await expect(transport.pollOnce(input)).rejects.toMatchObject({
      code: "rate_limited",
      retryable: true,
      retryAfterMs: 3_000,
    });
    for (const request of http.requests) {
      expect(request.url).not.toContain(CONFIG.bot_token);
    }
  });

  it("reports a second polling consumer as a degraded connection", async () => {
    const http = createFakeHttpClient();
    http.enqueue(telegramOk({ id: 42, username: "mate_bot" }));
    http.enqueue({
      status: 409,
      body: {
        ok: false,
        description: "another getUpdates request is active",
      },
    });
    const adapter = createTelegramAdapter({
      http,
      scope: {
        userId: CONTEXT.userId,
        agentId: CONTEXT.agentId,
      },
      acceptInbound: async () => ({ kind: "ignored" }),
      delay: async (_milliseconds, signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
      },
    });

    await adapter.start({
      connectionId: CONTEXT.connectionId,
      agentId: CONTEXT.agentId,
      config: adapter.validateConfig(CONFIG),
      signal: new AbortController().signal,
      now: () => NOW,
    });
    await vi.waitFor(async () => {
      expect(await adapter.health()).toMatchObject({
        status: "degraded",
        error: { code: "polling_conflict" },
      });
    });
    await adapter.stop("shutdown");
  });

  it("downloads platform files without exposing the token or file URL", async () => {
    const http = createFakeHttpClient();
    http.enqueue(telegramOk({
      file_path: "documents/notes.txt",
      file_size: 5,
    }));
    http.enqueue({
      status: 200,
      headers: { "content-type": "application/octet-stream" },
      body: new TextEncoder().encode("hello"),
    });
    const config = createTelegramAdapter({
      autoPoll: false,
    }).validateConfig(CONFIG);
    const fetcher = createTelegramTransport({
      http,
      now: () => NOW,
    }).attachmentFetcher(config);
    const descriptor = {
      externalAttachmentId: "unique-file-1",
      fileName: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      source: { fileId: "platform-file-1" },
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
    expect(http.requests[1]).toMatchObject({
      method: "GET",
      responseType: "bytes",
    });
    expect(http.requests[1]?.url).not.toContain(CONFIG.bot_token);
    expect(http.requests[1]?.url).toContain(
      "/file/bot[REDACTED]/documents/notes.txt",
    );
  });
});

function telegramOk(body: unknown) {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: { ok: true, result: body },
  };
}

async function fixture(name: string): Promise<unknown> {
  const source = await readFile(
    path.join(
      process.cwd(),
      "tests/fixtures/channels/telegram",
      name,
    ),
    "utf8",
  );
  return JSON.parse(source) as unknown;
}

function blockingPollingHttp(
  onPoll: () => void,
): NonNullable<TelegramAdapterDependencies["http"]> {
  let request = 0;
  return {
    async request(input) {
      request += 1;
      if (request === 1) {
        return telegramOk({ id: 42, username: "mate_bot" });
      }
      onPoll();
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(input.signal?.reason);
        input.signal?.addEventListener("abort", onAbort, {
          once: true,
        });
        if (input.signal?.aborted) onAbort();
        void resolve;
      });
    },
  };
}
