import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createSlackAdapter,
} from "@/server/channels/adapters/slack";
import {
  createSlackAttachmentFetcher,
  mapSlackError,
  slackProxyOptions,
  SlackTransportError,
  type SlackClientPort,
} from "@/server/channels/adapters/slack/transport";
import {
  createFakeHttpClient,
} from "@/server/channels/testing/fixtures";
import {
  ChannelAdapterRegistry,
  registerSlackChannelAdapter,
} from "@/server/channels/runtime/registry";
import {
  assertStableExternalEventId,
  defineChannelContract,
} from "@/server/channels/testing/contract";

const NOW = new Date("2026-07-26T00:00:00.000Z");
const CONTEXT = {
  connectionId: "connection-slack",
  userId: "user-1",
  agentId: "agent-1",
  receivedAt: NOW,
};
const CONFIG = {
  enabled: true,
  bot_token: "xoxb-slack-secret",
  app_token: "xapp-slack-secret",
  signing_secret: "",
  proxy: null,
  streaming_enabled: true,
  require_mention: true,
};

defineChannelContract({
  type: "slack",

  assertConfig() {
    const adapter = createSlackAdapter({
      clientFactory: () => createFakeSlackClient(),
      autoListen: false,
    });
    expect(adapter.validateConfig(CONFIG)).toMatchObject({
      bot_token: CONFIG.bot_token,
      app_token: CONFIG.app_token,
      require_mention: true,
    });
    expect(() =>
      adapter.validateConfig({
        ...CONFIG,
        bot_token: "not-a-bot-token",
      })
    ).toThrow("slack_bot_token_invalid");
    expect(() =>
      adapter.validateConfig({
        ...CONFIG,
        app_token: "not-an-app-token",
      })
    ).toThrow("slack_app_token_invalid");
  },

  async assertLifecycle() {
    const client = createFakeSlackClient();
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
    const client = createFakeSlackClient();
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter));
    const direct = await adapter.normalizeInbound(
      await fixture("event-direct.json"),
      CONTEXT,
    );
    const group = await adapter.normalizeInbound(
      await fixture("event-channel-thread-file.json"),
      CONTEXT,
    );

    expect(direct).toMatchObject({
      externalEventId: "event:Ev123:1712345.100",
      externalConversationId: "D100",
      externalSenderId: "U100",
      chatType: "direct",
      mentioned: true,
    });
    expect(group).toMatchObject({
      externalEventId: "event:Ev124:1712346.200",
      externalConversationId: "C200",
      externalSenderId: "U101",
      chatType: "group",
      mentioned: true,
      text: "看一下附件",
      thread: {
        externalThreadId: "1712300.000",
        replyToEventId: "1712300.000",
      },
      attachments: [{
        externalAttachmentId: "F100",
        fileName: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 128,
        source: { fileId: "F100" },
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
    const client = createFakeSlackClient();
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter));
    const payload = await fixture("event-direct.json");

    await expect(
      assertStableExternalEventId(() =>
        adapter.normalizeInbound(payload, CONTEXT)
      ),
    ).resolves.toBe("event:Ev123:1712345.100");
    await adapter.stop("shutdown");
  },

  async assertOutbound() {
    const client = createFakeSlackClient();
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
    const recipient = await adapter.resolveRecipient(
      delivery.recipient,
    );

    expect(first.externalMessageId).toBe("1712400.001");
    expect(streamed?.externalMessageId).toBe("1712400.001");
    expect(client.posted).toEqual([{
      channel: "C200",
      text: "完整回复",
      threadTs: "1712300.000",
    }]);
    expect(client.updated).toEqual([{
      channel: "C200",
      ts: "1712400.001",
      text: "完整回复",
    }]);
    expect(recipient).toEqual({
      address: {
        channel: "C200",
        conversationId: "C200",
        threadTs: "1712300.000",
      },
    });
    expect(adapter.typing).toBeUndefined();
    await adapter.stop("shutdown");
  },

  async assertHealth() {
    const client = createFakeSlackClient({
      startError: new SlackTransportError({
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
    expect(JSON.stringify(await adapter.health()))
      .not.toContain(CONFIG.app_token);
  },

  async assertShutdown() {
    const client = createFakeSlackClient();
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

describe("Slack Socket Mode transaction boundary", () => {
  it("registers the production adapter factory", () => {
    const registry = new ChannelAdapterRegistry();
    registerSlackChannelAdapter(registry);

    expect(registry.registeredTypes()).toEqual(["slack"]);
    expect(
      registry.create("slack", { now: () => NOW }).manifest.type,
    ).toBe("slack");
  });

  it("configures a proxy without credentials in the URL", () => {
    expect(slackProxyOptions({
      proxy: "http://proxy.internal:8080",
    })).toEqual({
      uri: "http://proxy.internal:8080",
    });
  });

  it("acknowledges only after durable ingress and stays within three seconds", async () => {
    vi.useFakeTimers();
    try {
      const client = createFakeSlackClient();
      let release: () => void = () => {};
      const persisted = new Promise<void>((resolve) => {
        release = resolve;
      });
      const order: string[] = [];
      const adapter = createSlackAdapter({
        clientFactory: () => client,
        scope: {
          userId: CONTEXT.userId,
          agentId: CONTEXT.agentId,
        },
        acceptInbound: async (
          _payload,
          _context,
          _scope,
          acknowledge,
        ) => {
          order.push("persist-start");
          await persisted;
          order.push("persisted");
          await acknowledge();
          return {
            kind: "accepted" as const,
            eventId: "event-1",
          };
        },
        now: () => NOW,
      });
      await adapter.start(runtimeContext(adapter));

      const emitted = client.emitEnvelope(
        await fixture("event-direct.json"),
        () => {
          order.push("ack");
        },
      );
      await Promise.resolve();
      expect(order).toEqual(["persist-start"]);
      await vi.advanceTimersByTimeAsync(2_500);
      release();
      await emitted;

      expect(order).toEqual([
        "persist-start",
        "persisted",
        "ack",
      ]);
      await adapter.stop("shutdown");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores message_changed, bot messages and the current Bot user", async () => {
    const base = await fixture("event-direct.json");
    const client = createFakeSlackClient();
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter));

    await expect(adapter.normalizeInbound({
      ...base,
      event: {
        ...(base.event as Record<string, unknown>),
        subtype: "message_changed",
      },
    }, CONTEXT)).resolves.toBeNull();
    await expect(adapter.normalizeInbound({
      ...base,
      event: {
        ...(base.event as Record<string, unknown>),
        bot_id: "B-OTHER",
      },
    }, CONTEXT)).resolves.toBeNull();
    await expect(adapter.normalizeInbound({
      ...base,
      event: {
        ...(base.event as Record<string, unknown>),
        user: "U-BOT",
      },
    }, CONTEXT)).resolves.toBeNull();
    await adapter.stop("shutdown");
  });

  it("maps Slack ratelimited retry metadata", () => {
    expect(mapSlackError({
      code: "slack_webapi_rate_limited_error",
      retryAfter: 3,
      data: { error: CONFIG.bot_token },
    })).toMatchObject({
      code: "rate_limited",
      retryable: true,
      retryAfterMs: 3_000,
    });
  });

  it("resolves and downloads file_share bytes without exposing the bot token", async () => {
    const http = createFakeHttpClient();
    http.enqueue({
      status: 200,
      body: {
        ok: true,
        file: {
          id: "F100",
          name: "notes.txt",
          mimetype: "text/plain",
          size: 5,
          url_private_download:
            "https://files.slack.com/files-pri/T100-F100/notes.txt",
        },
      },
    });
    http.enqueue({
      status: 200,
      body: new TextEncoder().encode("hello"),
    });
    const adapter = createSlackAdapter({
      clientFactory: () => createFakeSlackClient(),
      autoListen: false,
    });
    const fetcher = createSlackAttachmentFetcher(
      adapter.validateConfig(CONFIG),
      http,
    );
    const descriptor = {
      externalAttachmentId: "F100",
      fileName: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      source: { fileId: "F100" },
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
    expect(http.requests).toHaveLength(2);
  });
});

function testAdapter(client: FakeSlackClient) {
  return createSlackAdapter({
    clientFactory: () => client,
    autoListen: false,
    now: () => NOW,
  });
}

function runtimeContext(
  adapter: ReturnType<typeof createSlackAdapter>,
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
      externalConversationId: "C200",
      externalThreadId: "1712300.000",
    },
    replyHandle: {
      publicFields: {
        channel: "C200",
        threadTs: "1712300.000",
      },
      secretFields: {},
      expiresAt: null,
    },
  };
}

type FakeSlackClient = SlackClientPort & {
  starts: number;
  stops: number;
  posted: unknown[];
  updated: unknown[];
  emitEnvelope(
    payload: unknown,
    ack: () => void,
  ): Promise<void>;
};

function createFakeSlackClient(options: Readonly<{
  startError?: Error;
}> = {}): FakeSlackClient {
  let envelopeListener:
    | ((payload: unknown, ack: () => Promise<void>) => Promise<void>)
    | null = null;
  return {
    starts: 0,
    stops: 0,
    posted: [],
    updated: [],
    async start(input) {
      this.starts += 1;
      envelopeListener = input.onEnvelope;
      if (options.startError) throw options.startError;
      return {
        botUserId: "U-BOT",
        botId: "B-BOT",
      };
    },
    async stop() {
      this.stops += 1;
    },
    async postMessage(input) {
      this.posted.push(input);
      return { ts: "1712400.001" };
    },
    async updateMessage(input) {
      this.updated.push(input);
    },
    async emitEnvelope(payload, ack) {
      await envelopeListener?.(
        payload,
        async () => ack(),
      );
    },
  };
}

async function fixture(name: string): Promise<Record<string, unknown>> {
  const value = JSON.parse(
    await readFile(
      path.join(
        process.cwd(),
        "tests/fixtures/channels/slack",
        name,
      ),
      "utf8",
    ),
  ) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("slack_fixture_invalid");
  }
  return value as Record<string, unknown>;
}
