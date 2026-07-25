import { readFile } from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  createQQAdapter,
} from "@/server/channels/adapters/qq";
import {
  createQQAttachmentFetcher,
  createQQGatewayClient,
  createQQTokenCache,
  heartbeatFrame,
  mapQQResponse,
  reduceQQGatewayFrame,
  QQTransportError,
  type QQClientPort,
  type QQGatewayState,
} from "@/server/channels/adapters/qq/transport";
import {
  ChannelAdapterRegistry,
  registerQQChannelAdapter,
} from "@/server/channels/runtime/registry";
import {
  createChannelReplyHandleRepository,
} from "@/server/channels/runtime/reply-handle";
import {
  assertStableExternalEventId,
  defineChannelContract,
} from "@/server/channels/testing/contract";
import {
  createFakeHttpClient,
} from "@/server/channels/testing/fixtures";
import {
  ChannelSecretsKey,
} from "@/server/security/encrypted-secret";

const NOW = new Date("2026-07-26T00:00:00.000Z");
const CONTEXT = {
  connectionId: "connection-qq",
  userId: "user-1",
  agentId: "agent-1",
  receivedAt: NOW,
};
const CONFIG = {
  enabled: true,
  app_id: "1027654321",
  client_secret: "qq-client-secret",
  markdown_enabled: true,
  max_reconnect_attempts: 100,
  ack_message: "已收到",
};

defineChannelContract({
  type: "qq",
  assertConfig() {
    const adapter = createQQAdapter({
      clientFactory: () => createFakeQQClient(),
      autoListen: false,
    });
    expect(adapter.validateConfig(CONFIG)).toMatchObject({
      app_id: CONFIG.app_id,
      markdown_enabled: true,
      max_reconnect_attempts: 100,
      ack_message: "已收到",
    });
    expect(() =>
      adapter.validateConfig({ ...CONFIG, client_secret: "" })
    ).toThrow("qq_client_secret_required");
    expect(() =>
      adapter.validateConfig({ ...CONFIG, app_id: "not-an-app-id" })
    ).toThrow("qq_app_id_invalid");
  },
  async assertLifecycle() {
    const client = createFakeQQClient();
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
    const client = createFakeQQClient();
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter));
    const direct = await adapter.normalizeInbound(
      await fixture("message-c2c.json"),
      CONTEXT,
    );
    const group = await adapter.normalizeInbound(
      await fixture("message-group-image.json"),
      CONTEXT,
    );
    expect(direct).toMatchObject({
      externalEventId: "event:READY-seq-501-message-88",
      externalConversationId: "c2c:user-open-1",
      externalSenderId: "user-open-1",
      chatType: "direct",
      mentioned: true,
      text: "你好",
      replyHandle: {
        publicFields: {
          messageType: "c2c",
          messageId: "message-88",
          senderId: "user-open-1",
        },
        secretFields: {},
      },
    });
    expect(group).toMatchObject({
      externalEventId: "event:event-group-89",
      externalConversationId: "group:group-open-1",
      externalSenderId: "member-open-1",
      chatType: "group",
      mentioned: true,
      text: "/describe",
      attachments: [{
        externalAttachmentId: "attachment-1",
        fileName: "photo.png",
        mimeType: "image/png",
        sizeBytes: 5,
        source: {
          url: expect.stringContaining("multimedia.nt.qq.com.cn"),
        },
      }],
    });
    expect(group?.permission).toEqual({
      webSearch: false,
      backgroundNetwork: false,
      tools: false,
      skills: "none",
      attachmentsPresent: true,
    });
    expect(JSON.stringify(group?.rawSummary))
      .not.toContain("token=private");
    await adapter.stop("shutdown");
  },
  async assertStableIds() {
    const client = createFakeQQClient();
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter));
    const payload = await fixture("message-c2c.json");
    await expect(
      assertStableExternalEventId(() =>
        adapter.normalizeInbound(payload, CONTEXT)
      ),
    ).resolves.toBe("event:READY-seq-501-message-88");
    await expect(adapter.normalizeInbound({
      frame: {
        ...(await fixture("message-c2c.json")),
        id: undefined,
      },
      sessionId: "session-1",
    }, CONTEXT)).resolves.toMatchObject({
      externalEventId: "gateway:session-1:501:message-88",
    });
    await adapter.stop("shutdown");
  },
  async assertOutbound() {
    const client = createFakeQQClient();
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter));
    const reply = await adapter.send(outboundDelivery(), {
      config: adapter.validateConfig(CONFIG),
      signal: new AbortController().signal,
      now: () => NOW,
    });
    const proactive = await adapter.send(proactiveDelivery(), {
      config: adapter.validateConfig(CONFIG),
      signal: new AbortController().signal,
      now: () => NOW,
    });
    expect(reply.externalMessageId).toBe("qq-message-1");
    expect(proactive.externalMessageId).toBe("qq-message-2");
    expect(client.sent).toEqual([
      expect.objectContaining({
        messageType: "group",
        conversationId: "group-open-1",
        senderId: "member-open-1",
        messageId: "message-89",
        content: "完整回复",
        markdown: true,
        msgSeq: 1,
      }),
      expect.objectContaining({
        messageType: "c2c",
        conversationId: "user-open-1",
        senderId: "user-open-1",
        content: "主动消息",
        markdown: true,
        msgSeq: 1,
      }),
    ]);
    expect(adapter.typing).toBeUndefined();
    await adapter.stop("shutdown");
  },
  async assertHealth() {
    const client = createFakeQQClient({
      startError: new QQTransportError({
        code: "permission_denied",
        detail: "qq_intent_not_allowed",
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
        detail: "qq_intent_not_allowed",
      },
    });
  },
  async assertShutdown() {
    const client = createFakeQQClient();
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

describe("QQ Gateway and HTTP API", () => {
  it("registers the adapter without sending the two-message ack option", () => {
    const registry = new ChannelAdapterRegistry();
    registerQQChannelAdapter(registry);
    expect(registry.registeredTypes()).toEqual(["qq"]);
  });

  it("normalizes channel mentions and channel direct messages", async () => {
    const adapter = testAdapter(createFakeQQClient());
    const guild = await adapter.normalizeInbound({
      op: 0,
      s: 503,
      t: "AT_MESSAGE_CREATE",
      id: "event-guild-1",
      d: {
        id: "message-guild-1",
        content: "频道消息",
        channel_id: "channel-1",
        guild_id: "guild-1",
        author: { id: "guild-user-1" },
      },
    }, CONTEXT);
    const direct = await adapter.normalizeInbound({
      op: 0,
      s: 504,
      t: "DIRECT_MESSAGE_CREATE",
      id: "event-dm-1",
      d: {
        id: "message-dm-1",
        content: "频道私信",
        channel_id: "dm-channel-1",
        guild_id: "guild-1",
        author: { id: "guild-user-1" },
      },
    }, CONTEXT);

    expect(guild).toMatchObject({
      externalConversationId: "guild:channel-1",
      externalSenderId: "guild-user-1",
      chatType: "group",
      mentioned: true,
    });
    expect(direct).toMatchObject({
      externalConversationId: "dm:guild-1",
      externalSenderId: "guild-user-1",
      chatType: "direct",
      mentioned: true,
    });
  });

  it("handles Hello, Identify, Resume, Heartbeat, sequence, and invalid sessions", () => {
    const fresh: QQGatewayState = {
      sessionId: null,
      sequence: null,
    };
    const hello = reduceQQGatewayFrame(fresh, {
      op: 10,
      d: { heartbeat_interval: 45_000 },
    }, "access-token");
    expect(hello.outbound).toEqual([{
      op: 2,
      d: {
        token: "QQBot access-token",
        intents: (1 << 30) | (1 << 12) | (1 << 25),
        shard: [0, 1],
      },
    }]);
    expect(hello.heartbeatIntervalMs).toBe(45_000);

    const resumed = reduceQQGatewayFrame({
      sessionId: "session-1",
      sequence: 500,
    }, {
      op: 10,
      d: { heartbeat_interval: 45_000 },
    }, "access-token");
    expect(resumed.outbound).toEqual([{
      op: 6,
      d: {
        token: "QQBot access-token",
        session_id: "session-1",
        seq: 500,
      },
    }]);
    expect(heartbeatFrame({
      sessionId: "session-1",
      sequence: 501,
    })).toEqual({ op: 1, d: 501 });

    const ready = reduceQQGatewayFrame(fresh, {
      op: 0,
      s: 501,
      t: "READY",
      d: { session_id: "session-1" },
    }, "access-token");
    expect(ready.state).toEqual({
      sessionId: "session-1",
      sequence: 501,
    });
    expect(ready.ready).toBe(true);

    const invalid = reduceQQGatewayFrame(ready.state, {
      op: 9,
      d: false,
    }, "access-token");
    expect(invalid).toMatchObject({
      state: { sessionId: null, sequence: null },
      reconnect: true,
      refreshToken: true,
    });
    expect(reduceQQGatewayFrame(ready.state, {
      op: 7,
      d: null,
    }, "access-token").reconnect).toBe(true);
    expect(reduceQQGatewayFrame(ready.state, {
      op: 11,
      d: null,
    }, "access-token").heartbeatAcknowledged).toBe(true);
  });

  it("connects to the official Gateway and sends the documented group shape", async () => {
    const http = createFakeHttpClient();
    http.enqueue({
      status: 200,
      body: {
        access_token: "qq-access-token",
        expires_in: 7_200,
      },
    });
    http.enqueue({
      status: 200,
      body: { url: "wss://gateway.qq.com/websocket" },
    });
    http.enqueue({
      status: 200,
      body: { id: "sent-group-1" },
    });
    const socket = new FakeQQSocket();
    const adapter = createQQAdapter({
      clientFactory: () => createFakeQQClient(),
      autoListen: false,
    });
    const client = createQQGatewayClient(
      adapter.validateConfig(CONFIG),
      {
        http,
        socketFactory: () => {
          queueMicrotask(() => {
            socket.receive({
              op: 10,
              d: { heartbeat_interval: 45_000 },
            });
            socket.receive({
              op: 0,
              s: 501,
              t: "READY",
              d: { session_id: "session-1" },
            });
          });
          return socket as never;
        },
      },
    );
    const states: unknown[] = [];
    await expect(client.start({
      signal: new AbortController().signal,
      onEvent: vi.fn(async () => undefined),
      onState: (state) => states.push(state),
      onError: vi.fn(),
    })).resolves.toEqual({
      sessionId: "session-1",
      sequence: 501,
    });
    expect(socket.sent).toContainEqual({
      op: 2,
      d: {
        token: "QQBot qq-access-token",
        intents: (1 << 30) | (1 << 12) | (1 << 25),
        shard: [0, 1],
      },
    });
    expect(states).toContainEqual(expect.objectContaining({
      sessionId: "session-1",
      sequence: 501,
    }));
    await expect(client.sendMessage({
      messageType: "group",
      conversationId: "group-open-1",
      senderId: "member-open-1",
      messageId: "message-89",
      content: "完整回复",
      markdown: true,
      msgSeq: 1,
    })).resolves.toEqual({ messageId: "sent-group-1" });
    expect(http.requests.map((request) => request.url)).toEqual([
      expect.stringContaining("/app/getAppAccessToken"),
      "https://api.sgroup.qq.com/gateway",
      "https://api.sgroup.qq.com/v2/groups/group-open-1/messages",
    ]);
    expect(http.requests[2]).toMatchObject({
      method: "POST",
      body: {
        markdown: { content: "完整回复" },
        msg_type: 2,
        msg_seq: 1,
        msg_id: "message-89",
      },
    });
    const serialized = JSON.stringify(http.requests);
    expect(serialized).not.toContain("qq-access-token");
    expect(serialized).not.toContain(CONFIG.client_secret);
    await client.stop();
  });

  it("stops reconnecting when the configured Gateway limit is reached", async () => {
    const http = createFakeHttpClient();
    http.enqueue({
      status: 200,
      body: {
        access_token: "qq-access-token",
        expires_in: 7_200,
      },
    });
    http.enqueue({
      status: 200,
      body: { url: "wss://gateway.qq.com/websocket" },
    });
    const socket = new FakeQQSocket();
    const adapter = createQQAdapter({
      clientFactory: () => createFakeQQClient(),
      autoListen: false,
    });
    const client = createQQGatewayClient(
      adapter.validateConfig({
        ...CONFIG,
        max_reconnect_attempts: 1,
      }),
      {
        http,
        socketFactory: () => {
          queueMicrotask(() => {
            socket.receive({
              op: 10,
              d: { heartbeat_interval: 45_000 },
            });
            socket.receive({
              op: 0,
              s: 501,
              t: "READY",
              d: { session_id: "session-1" },
            });
          });
          return socket as never;
        },
      },
    );
    const states: unknown[] = [];
    await client.start({
      signal: new AbortController().signal,
      onEvent: vi.fn(async () => undefined),
      onState: (state) => states.push(state),
      onError: vi.fn(),
    });
    socket.close();
    expect(states).toContainEqual(expect.objectContaining({
      reconnectAttempts: 1,
      exhausted: true,
    }));
    await client.stop();
  });

  it("falls back from explicitly rejected Markdown without changing msg_seq", async () => {
    const http = createFakeHttpClient();
    http.enqueue({
      status: 200,
      body: {
        access_token: "qq-access-token",
        expires_in: 7_200,
      },
    });
    http.enqueue({
      status: 400,
      body: {
        code: 40034012,
        message: "不允许发送原生 markdown",
      },
    });
    http.enqueue({
      status: 200,
      body: { id: "sent-plain-1" },
    });
    const adapter = createQQAdapter({
      clientFactory: () => createFakeQQClient(),
      autoListen: false,
    });
    const client = createQQGatewayClient(
      adapter.validateConfig(CONFIG),
      { http },
    );
    await expect(client.sendMessage({
      messageType: "c2c",
      conversationId: "user-open-1",
      senderId: "user-open-1",
      messageId: "message-88",
      content: "完整回复",
      markdown: true,
      msgSeq: 7,
    })).resolves.toEqual({ messageId: "sent-plain-1" });

    expect(http.requests.slice(1).map((request) => request.body))
      .toEqual([
        {
          markdown: { content: "完整回复" },
          msg_type: 2,
          msg_seq: 7,
          msg_id: "message-88",
        },
        {
          content: "完整回复",
          msg_type: 0,
          msg_seq: 7,
          msg_id: "message-88",
        },
      ]);
    await client.stop();
  });

  it("uses one token load, maps blocked/rate responses, and never exposes bodies", async () => {
    const load = vi.fn(async () => ({
      token: "qq-access-token",
      expiresInSeconds: 7_200,
    }));
    const cache = createQQTokenCache({
      load,
      now: () => NOW,
    });
    await Promise.all([cache.get(), cache.get()]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(() => mapQQResponse({
      status: 403,
      body: {
        code: 11281,
        message: CONFIG.client_secret,
      },
    })).toThrowError(expect.objectContaining({
      code: "permission_denied",
      retryable: false,
    }));
    expect(() => mapQQResponse({
      status: 429,
      headers: { "retry-after": "2" },
      body: {},
    })).toThrowError(expect.objectContaining({
      code: "rate_limited",
      retryAfterMs: 2_000,
    }));
  });

  it("reuses the persisted delivery sequence across bounded retries", async () => {
    const client = createFakeQQClient();
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter));
    const delivery = {
      ...outboundDelivery(),
      deliverySequence: 7,
    };
    const context = {
      config: adapter.validateConfig(CONFIG),
      signal: new AbortController().signal,
      now: () => NOW,
    };
    await adapter.send(delivery, context);
    await adapter.send(delivery, context);

    expect(client.sent).toEqual([
      expect.objectContaining({ msgSeq: 7 }),
      expect.objectContaining({ msgSeq: 7 }),
    ]);
    await adapter.stop("shutdown");
  });

  it("persists a public-only reply context in the encrypted handle ledger", async () => {
    const query = vi.fn(async () => ({
      rowCount: 1,
      rows: [{
        id: "50000000-0000-4000-8000-000000000001",
      }],
    }));
    const repository = createChannelReplyHandleRepository(
      { query } as never,
      ChannelSecretsKey.fromBase64(
        Buffer.alloc(32, 7).toString("base64"),
      ),
    );

    await expect(repository.persist(
      {
        userId: "10000000-0000-4000-8000-000000000001",
        agentId: "10000000-0000-4000-8000-000000000011",
      },
      "30000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000001",
      {
        publicFields: {
          messageType: "c2c",
          messageId: "message-88",
        },
        secretFields: {},
        expiresAt: new Date("2026-07-26T00:05:00.000Z"),
      },
      NOW,
    )).resolves.toBe(
      "50000000-0000-4000-8000-000000000001",
    );
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("downloads only QQ-hosted private attachments", async () => {
    const http = createFakeHttpClient();
    http.enqueue({
      status: 200,
      body: new TextEncoder().encode("hello"),
    });
    const adapter = createQQAdapter({
      clientFactory: () => createFakeQQClient(),
      autoListen: false,
    });
    const fetcher = createQQAttachmentFetcher(
      adapter.validateConfig(CONFIG),
      http,
    );
    const descriptor = {
      externalAttachmentId: "attachment-1",
      fileName: "photo.png",
      mimeType: "image/png",
      sizeBytes: 5,
      source: {
        url: "https://multimedia.nt.qq.com.cn/download/photo.png?token=private",
      },
    };
    await expect(fetcher.inspect(descriptor)).resolves.toEqual({
      fileName: "photo.png",
      mimeType: "image/png",
      sizeBytes: 5,
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of await fetcher.download(descriptor)) {
      chunks.push(chunk);
    }
    expect(new TextDecoder().decode(chunks[0])).toBe("hello");
    await expect(fetcher.inspect({
      ...descriptor,
      externalAttachmentId: "attachment-2",
      source: { url: "https://example.com/private" },
    })).rejects.toThrow("qq_attachment_url_invalid");
  });

  it("marks max reconnect exhaustion as disconnected and preserves resume state", async () => {
    const client = createFakeQQClient();
    const adapter = createQQAdapter({
      clientFactory: () => client,
      autoListen: false,
      initialResumeState: {
        sessionId: "persisted-session",
        sequence: 499,
      },
      now: () => NOW,
    });
    await adapter.start(runtimeContext(adapter));
    client.stateHandler?.({
      sessionId: "session-1",
      sequence: 501,
      reconnectAttempts: 100,
      exhausted: true,
    });
    await expect(adapter.health()).resolves.toMatchObject({
      status: "disconnected",
      reconnectAttempts: 100,
      retryExhausted: true,
      resumeState: {
        sessionId: "session-1",
        sequence: 501,
      },
    });
    expect(client.startedWithResumeState).toEqual({
      sessionId: "persisted-session",
      sequence: 499,
    });
    await adapter.stop("shutdown");
  });
});

function testAdapter(client: FakeQQClient) {
  return createQQAdapter({
    clientFactory: () => client,
    autoListen: false,
    now: () => NOW,
  });
}

function runtimeContext(
  adapter: ReturnType<typeof createQQAdapter>,
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
      externalConversationId: "group:group-open-1",
      externalUserId: "member-open-1",
      chatType: "group" as const,
    },
    replyHandle: {
      publicFields: {
        messageType: "group",
        messageId: "message-89",
        senderId: "member-open-1",
        groupOpenId: "group-open-1",
      },
      secretFields: {},
      expiresAt: new Date("2026-07-26T00:05:00.000Z"),
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
      externalConversationId: "c2c:user-open-1",
      externalUserId: "user-open-1",
      chatType: "direct" as const,
    },
  };
}

type FakeQQClient = QQClientPort & {
  starts: number;
  stops: number;
  sent: unknown[];
  stateHandler:
    | ((state: Parameters<NonNullable<
        Parameters<QQClientPort["start"]>[0]["onState"]
      >>[0]) => void)
    | null;
  startedWithResumeState: unknown;
};

function createFakeQQClient(options: Readonly<{
  startError?: Error;
}> = {}): FakeQQClient {
  let messageNumber = 0;
  return {
    starts: 0,
    stops: 0,
    sent: [],
    stateHandler: null,
    startedWithResumeState: null,
    async start(input) {
      this.starts += 1;
      if (options.startError) throw options.startError;
      this.stateHandler = input.onState ?? null;
      this.startedWithResumeState = input.resumeState ?? null;
      return {
        sessionId: input.resumeState?.sessionId ?? "session-1",
        sequence: input.resumeState?.sequence ?? 500,
      };
    },
    async stop() {
      this.stops += 1;
    },
    async sendMessage(input) {
      messageNumber += 1;
      this.sent.push(input);
      return { messageId: `qq-message-${messageNumber}` };
    },
  };
}

async function fixture(name: string): Promise<Record<string, unknown>> {
  const value = JSON.parse(
    await readFile(
      path.join(
        process.cwd(),
        "tests/fixtures/channels/qq",
        name,
      ),
      "utf8",
    ),
  ) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("qq_fixture_invalid");
  }
  return value as Record<string, unknown>;
}

class FakeQQSocket extends EventEmitter {
  readonly sent: unknown[] = [];
  readyState = 1;

  send(value: string) {
    this.sent.push(JSON.parse(value) as unknown);
  }

  receive(value: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(value)));
  }

  close() {
    this.readyState = 3;
    this.emit("close");
  }

  terminate() {
    this.close();
  }
}
