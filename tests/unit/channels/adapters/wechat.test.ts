import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createWechatHeaders,
} from "@/server/channels/adapters/wechat/auth";
import {
  decryptWechatMedia,
  encryptWechatMedia,
  parseWechatAesKey,
} from "@/server/channels/adapters/wechat/crypto";
import {
  createWechatAdapter,
  parseWechatConfig,
} from "@/server/channels/adapters/wechat";
import {
  createWechatIlinkClient,
  WechatTransportError,
} from "@/server/channels/adapters/wechat/client";
import {
  createWechatAttachmentFetcher,
} from "@/server/channels/adapters/wechat/media";
import {
  normalizeWechatInbound,
} from "@/server/channels/adapters/wechat/normalize";
import {
  createWechatLongPollTransport,
} from "@/server/channels/adapters/wechat/transport";
import {
  ChannelAdapterRegistry,
  registerWechatChannelAdapter,
} from "@/server/channels/runtime/registry";

const NOW = new Date("2026-07-26T00:00:00.000Z");
const CONFIG = {
  enabled: true,
  bot_token: "wechat-bot-secret",
  bot_token_file: "",
  base_url: "https://ilinkai.weixin.qq.com",
  media_dir: null,
  message_merge_enabled: true,
  message_merge_delay_ms: 0,
} as const;

describe("WeChat iLink channel", () => {
  it("validates the fixed config without exposing its bot token", () => {
    expect(parseWechatConfig(CONFIG)).toMatchObject(CONFIG);
    expect(() => parseWechatConfig({
      ...CONFIG,
      base_url: "http://localhost",
    })).toThrow("wechat_base_url_invalid");
    expect(() => parseWechatConfig({
      ...CONFIG,
      bot_token_file: "/tmp/plaintext-token",
    })).toThrow("wechat_bot_token_file_unsupported");
  });

  it("registers the WeChat adapter exactly once", () => {
    const registry = new ChannelAdapterRegistry();

    registerWechatChannelAdapter(registry);

    expect(registry.registeredTypes()).toEqual(["wechat"]);
    expect(
      registry.create("wechat", {
        now: () => NOW,
      }).manifest.type,
    ).toBe("wechat");
    expect(() =>
      registerWechatChannelAdapter(registry)
    ).toThrow("duplicate_channel_adapter:wechat");
  });

  it("creates a fresh decimal uint32 X-WECHAT-UIN for every request", () => {
    const values = [0, 4_294_967_295];
    const first = createWechatHeaders(
      "token",
      () => values.shift()!,
    );
    const second = createWechatHeaders(
      "token",
      () => values.shift()!,
    );

    expect(first).toMatchObject({
      AuthorizationType: "ilink_bot_token",
      Authorization: "Bearer token",
      "X-WECHAT-UIN": Buffer.from("0").toString("base64"),
    });
    expect(second["X-WECHAT-UIN"]).toBe(
      Buffer.from("4294967295").toString("base64"),
    );
  });

  it("accepts all three upstream AES key encodings", () => {
    const raw = Buffer.from("0123456789abcdef");
    const hex = raw.toString("hex");
    const base64Raw = raw.toString("base64");
    const base64Hex = Buffer.from(hex).toString("base64");
    const plaintext = Buffer.from("private attachment");

    for (const encoded of [hex, base64Raw, base64Hex]) {
      expect(parseWechatAesKey(encoded)).toEqual(raw);
      expect(decryptWechatMedia(
        encryptWechatMedia(plaintext, encoded),
        encoded,
      )).toEqual(plaintext);
    }
  });

  it("normalizes context_token as an encrypted reply handle and excludes video", async () => {
    const raw = JSON.parse(await readFile(path.join(
      process.cwd(),
      "tests/fixtures/channels/wechat/message-text-file.json",
    ), "utf8")) as unknown;
    const normalized = normalizeWechatInbound(raw, {
      connectionId: "connection-wechat",
      agentId: "agent-wechat",
      receivedAt: NOW,
    });

    expect(normalized).toMatchObject({
      channelType: "wechat",
      externalEventId: `wechat:message:context:${
        createHash("sha256")
          .update("context-secret-7001")
          .digest("hex")
      }`,
      externalConversationId: "alice@im.wechat",
      externalSenderId: "alice@im.wechat",
      chatType: "direct",
      mentioned: true,
      text: "看看这份记录\n语音转写内容\n[video]",
      attachments: [{
        externalAttachmentId: "wechat-msg-7001:2",
        fileName: "notes.txt",
        mimeType: "text/plain",
        source: {
          encryptedQueryParam: "encrypted-query-7001",
          aesKey: "MDEyMzQ1Njc4OWFiY2RlZg==",
        },
      }],
      replyHandle: {
        publicFields: {
          targetId: "alice@im.wechat",
        },
        secretFields: {
          contextToken: "context-secret-7001",
        },
      },
    });
    expect(JSON.stringify(normalized?.rawSummary))
      .not.toContain("context-secret-7001");
    expect(normalized?.permission).toMatchObject({
      webSearch: false,
      tools: false,
      attachmentsPresent: true,
    });
  });

  it("sends the fixed getupdates body and never leaks auth into JSON", async () => {
    const fetchImpl = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      void input;
      void init;
      return new Response(JSON.stringify({
        ret: -1,
        msgs: [],
        get_updates_buf: "cursor-next",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = createWechatIlinkClient({
      botToken: CONFIG.bot_token,
      baseUrl: CONFIG.base_url,
      fetchImpl: fetchImpl as typeof fetch,
      randomUint32: () => 7,
    });

    await expect(client.getUpdates("cursor-old"))
      .resolves.toMatchObject({
        ret: -1,
        get_updates_buf: "cursor-next",
      });
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init?.headers).toMatchObject({
      Authorization: `Bearer ${CONFIG.bot_token}`,
      AuthorizationType: "ilink_bot_token",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      get_updates_buf: "cursor-old",
      base_info: { channel_version: "2.0.1" },
    });
    expect(String(init?.body)).not.toContain(CONFIG.bot_token);
  });

  it("uses one context token for one complete persisted delivery", async () => {
    const sent: unknown[] = [];
    const client = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      getQrCode: vi.fn(async () => ({})),
      getQrCodeStatus: vi.fn(async () => ({})),
      getUpdates: vi.fn(async () => ({
        ret: -1,
        msgs: [],
        get_updates_buf: "",
      })),
      sendText: vi.fn(async (input: unknown) => {
        sent.push(input);
        return { ret: 0, errcode: 0 };
      }),
      getConfig: vi.fn(async () => ({
        ret: 0,
        errcode: 0,
        typing_ticket: "ticket",
      })),
      sendTyping: vi.fn(async () => ({
        ret: 0,
        errcode: 0,
      })),
      attachmentFetcher: vi.fn(),
    };
    const adapter = createWechatAdapter({
      clientFactory: () => client,
      autoListen: false,
      now: () => NOW,
    });
    adapter.validateConfig(CONFIG);
    await adapter.start({
      connectionId: "connection-wechat",
      agentId: "agent-wechat",
      config: adapter.validateConfig(CONFIG),
      signal: new AbortController().signal,
      now: () => NOW,
    });

    await adapter.send({
      id: "delivery-wechat",
      eventId: "event-wechat",
      connectionId: "connection-wechat",
      assistantMessageId: "assistant-wechat",
      body: "完整回复",
      recipient: {
        externalConversationId: "alice@im.wechat",
        externalUserId: "alice@im.wechat",
        chatType: "direct",
      },
      replyHandle: {
        publicFields: { targetId: "alice@im.wechat" },
        secretFields: { contextToken: "context-secret" },
        expiresAt: null,
      },
    }, {
      config: adapter.validateConfig(CONFIG),
      signal: new AbortController().signal,
      now: () => NOW,
    });

    expect(sent).toEqual([{
      toUserId: "alice@im.wechat",
      text: "完整回复",
      contextToken: "context-secret",
      signal: expect.any(AbortSignal),
    }]);
    await adapter.stop("shutdown");
  });

  it("does not retry or resend when WeChat rejects an expired context token", async () => {
    const client = fakeIlinkClient({
      sendText: async () => ({
        ret: -2,
        errcode: 0,
      }),
    });
    const adapter = createWechatAdapter({
      clientFactory: () => client,
      autoListen: false,
      now: () => NOW,
    });
    const config = adapter.validateConfig(CONFIG);
    await adapter.start({
      connectionId: "connection-wechat",
      agentId: "agent-wechat",
      config,
      signal: new AbortController().signal,
      now: () => NOW,
    });

    await expect(adapter.send({
      id: "delivery-wechat-expired",
      eventId: "event-wechat-expired",
      connectionId: "connection-wechat",
      assistantMessageId: "assistant-wechat-expired",
      body: "不能重复发送",
      recipient: {
        externalConversationId: "alice@im.wechat",
        externalUserId: "alice@im.wechat",
        chatType: "direct",
      },
      replyHandle: {
        publicFields: {
          targetId: "alice@im.wechat",
        },
        secretFields: {
          contextToken: "expired-context-token",
        },
        expiresAt: null,
      },
    }, {
      config,
      signal: new AbortController().signal,
      now: () => NOW,
    })).rejects.toMatchObject({
      retryable: false,
      detail: "reply_handle_invalid",
    });
    expect(client.sendText).toHaveBeenCalledTimes(1);
    await adapter.stop("shutdown");
  });

  it("keeps the long-poll cursor after ret -1 and stops on ret -2", async () => {
    const calls: string[] = [];
    const client = fakeIlinkClient({
      getUpdates: async (cursor, signal) => {
        calls.push(cursor);
        if (calls.length === 1) {
          return {
            ret: -1,
            msgs: [],
            get_updates_buf: "cursor-next",
          };
        }
        return await new Promise((_, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(signal.reason),
            { once: true },
          );
        });
      },
    });
    const states: unknown[] = [];
    const transport = createWechatLongPollTransport({
      botToken: CONFIG.bot_token,
      baseUrl: CONFIG.base_url,
    }, {
      clientFactory: () => client,
    });
    await transport.start({
      signal: new AbortController().signal,
      onInbound: async () => undefined,
      onState: (state) => states.push(state),
      onError: () => undefined,
    });
    await vi.waitFor(() => {
      expect(calls).toEqual(["", "cursor-next"]);
    });
    await transport.stop();
    expect(states[0]).toEqual({
      status: "connected",
      reconnectAttempts: 0,
    });

    const invalidStates: unknown[] = [];
    const invalidErrors: WechatTransportError[] = [];
    const invalid = createWechatLongPollTransport({
      botToken: CONFIG.bot_token,
      baseUrl: CONFIG.base_url,
    }, {
      clientFactory: () => fakeIlinkClient({
        getUpdates: async () => ({
          ret: -2,
          msgs: [],
          get_updates_buf: "terminal",
        }),
      }),
    });
    await invalid.start({
      signal: new AbortController().signal,
      onInbound: async () => undefined,
      onState: (state) => invalidStates.push(state),
      onError: (error) => invalidErrors.push(error),
    });
    await vi.waitFor(() => {
      expect(invalidStates).toContainEqual({
        status: "disconnected",
        reconnectAttempts: 0,
        retryExhausted: true,
      });
    });
    expect(invalidErrors).toContainEqual(
      expect.objectContaining({
        code: "credential_invalid",
        retryable: false,
      }),
    );
    await invalid.stop();
  });

  it("commits the cursor only after the whole batch persists and restores health", async () => {
    const cursors: string[] = [];
    let calls = 0;
    const batch = {
      ret: 0,
      msgs: [
        { msg_id: "message-first" },
        { msg_id: "message-second" },
      ],
      get_updates_buf: "cursor-next",
    };
    const client = fakeIlinkClient({
      getUpdates: async (cursor, signal) => {
        cursors.push(cursor);
        calls += 1;
        if (calls <= 2) return batch;
        return await new Promise((_, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(signal.reason),
            { once: true },
          );
        });
      },
    });
    const received: string[] = [];
    let secondAttempts = 0;
    const states: unknown[] = [];
    const transport = createWechatLongPollTransport({
      botToken: CONFIG.bot_token,
      baseUrl: CONFIG.base_url,
    }, {
      clientFactory: () => client,
      delay: async () => undefined,
    });
    await transport.start({
      signal: new AbortController().signal,
      onInbound: async (message) => {
        const id = String(message.msg_id);
        received.push(id);
        if (
          id === "message-second"
          && (secondAttempts += 1) === 1
        ) {
          throw new Error("temporary_db_failure");
        }
      },
      onState: (state) => states.push(state),
      onError: () => undefined,
    });
    await vi.waitFor(() => {
      expect(cursors).toEqual([
        "",
        "",
        "cursor-next",
      ]);
    });

    expect(received).toEqual([
      "message-first",
      "message-second",
      "message-first",
      "message-second",
    ]);
    expect(states).toContainEqual({
      status: "disconnected",
      reconnectAttempts: 1,
      nextAttemptAt: expect.any(Date),
    });
    expect(states).toContainEqual({
      status: "connected",
      reconnectAttempts: 0,
    });
    await transport.stop();
  });

  it("cancels a delayed start before any long poll can survive stop", async () => {
    let releaseStart: (() => void) | undefined;
    const client = fakeIlinkClient({
      start: () => new Promise<void>((resolve) => {
        releaseStart = resolve;
      }),
    });
    const states: unknown[] = [];
    const transport = createWechatLongPollTransport({
      botToken: CONFIG.bot_token,
      baseUrl: CONFIG.base_url,
    }, {
      clientFactory: () => client,
    });
    const starting = transport.start({
      signal: new AbortController().signal,
      onInbound: async () => undefined,
      onState: (state) => states.push(state),
      onError: () => undefined,
    });
    await vi.waitFor(() => {
      expect(client.start).toHaveBeenCalledTimes(1);
    });
    const stopping = transport.stop();
    releaseStart?.();

    await expect(starting).rejects.toMatchObject({
      detail: "wechat_transport_start_cancelled",
    });
    await expect(stopping).resolves.toBeUndefined();
    expect(client.getUpdates).not.toHaveBeenCalled();
    expect(states).not.toContainEqual(
      expect.objectContaining({ status: "connected" }),
    );
    expect(client.stop).toHaveBeenCalledTimes(1);
  });

  it("queues restart behind an in-flight stop even while health is still healthy", async () => {
    let releaseStop: (() => void) | undefined;
    let stopCalls = 0;
    const client = fakeIlinkClient({
      stop: () => {
        stopCalls += 1;
        return stopCalls === 1
          ? new Promise<void>((resolve) => {
              releaseStop = resolve;
            })
          : Promise.resolve();
      },
    });
    const adapter = createWechatAdapter({
      clientFactory: () => client,
      autoListen: false,
      now: () => NOW,
    });
    const config = adapter.validateConfig(CONFIG);
    const context = () => ({
      connectionId: "connection-wechat",
      agentId: "agent-wechat",
      config,
      signal: new AbortController().signal,
      now: () => NOW,
    });
    await adapter.start(context());
    await expect(adapter.health()).resolves.toMatchObject({
      status: "healthy",
    });

    const stopping = adapter.stop("reconfigure");
    let restarted = false;
    const restarting = adapter.start(context()).then(() => {
      restarted = true;
    });
    await Promise.resolve();
    expect(restarted).toBe(false);
    expect(client.start).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(client.stop).toHaveBeenCalledTimes(1);
    });
    releaseStop?.();

    await stopping;
    await restarting;
    expect(client.start).toHaveBeenCalledTimes(2);
    await expect(adapter.health()).resolves.toMatchObject({
      status: "healthy",
    });
    await adapter.stop("shutdown");
  });

  it("treats an aborted send after HTTP dispatch as outcome unknown", async () => {
    const fetchImpl = vi.fn((
      _input: string | URL | Request,
      init?: RequestInit,
    ) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(init.signal?.reason),
        { once: true },
      );
    }));
    const client = createWechatIlinkClient({
      botToken: CONFIG.bot_token,
      baseUrl: CONFIG.base_url,
      fetchImpl: fetchImpl as typeof fetch,
    });
    const controller = new AbortController();
    const sending = client.sendText({
      toUserId: "alice@im.wechat",
      text: "只发送一次",
      contextToken: "context-secret",
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
    controller.abort(new Error("shutdown"));

    await expect(sending).rejects.toMatchObject({
      retryable: false,
      detail: "delivery_outcome_unknown",
    });
  });

  it("cancels an oversized JSON response before buffering beyond the limit", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new Uint8Array(2 * 1024 * 1024 + 1),
        );
      },
      cancel() {
        cancelled = true;
      },
    });
    const client = createWechatIlinkClient({
      baseUrl: CONFIG.base_url,
      fetchImpl: vi.fn(async () =>
        new Response(body, { status: 200 })
      ) as typeof fetch,
    });

    await expect(client.getQrCode()).rejects.toMatchObject({
      retryable: false,
      detail: "wechat_response_too_large",
    });
    expect(cancelled).toBe(true);
  });

  it("decrypts an inbound file once for inspect and download", async () => {
    const key = Buffer.from(
      "0123456789abcdef",
    ).toString("base64");
    const encrypted = encryptWechatMedia(
      Buffer.from("hello"),
      key,
    );
    const fetchImpl = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      void input;
      void init;
      return new Response(
        Uint8Array.from(encrypted).buffer,
        { status: 200 },
      );
    });
    const fetcher = createWechatAttachmentFetcher({
      fetchImpl: fetchImpl as typeof fetch,
    });
    const descriptor = {
      externalAttachmentId: "message:0",
      fileName: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: null,
      source: {
        encryptedQueryParam: "private-query",
        aesKey: key,
      },
    };
    await expect(fetcher.inspect(descriptor))
      .resolves.toMatchObject({
        fileName: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
      });
    const stream = await fetcher.download(descriptor);
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe("hello");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0]))
      .not.toContain(key);
  });

  it("keeps typing alive every five seconds and sends one finish", async () => {
    vi.useFakeTimers();
    try {
      const client = fakeIlinkClient();
      const adapter = createWechatAdapter({
        clientFactory: () => client,
        autoListen: false,
        now: () => NOW,
      });
      const parsed = adapter.validateConfig(CONFIG);
      await adapter.start({
        connectionId: "connection-wechat",
        agentId: "agent-wechat",
        config: parsed,
        signal: new AbortController().signal,
        now: () => NOW,
      });
      const raw = JSON.parse(await readFile(path.join(
        process.cwd(),
        "tests/fixtures/channels/wechat/message-text-file.json",
      ), "utf8")) as unknown;
      await adapter.normalizeInbound(raw, {
        connectionId: "connection-wechat",
        agentId: "agent-wechat",
        receivedAt: NOW,
      });
      const recipient = await adapter.resolveRecipient({
        externalConversationId: "alice@im.wechat",
        externalUserId: "alice@im.wechat",
        chatType: "direct",
      });

      await adapter.typing?.(recipient, true);
      expect(client.sendTyping).toHaveBeenCalledWith(
        expect.objectContaining({ status: 1 }),
      );
      await vi.advanceTimersByTimeAsync(5_000);
      expect(client.sendTyping).toHaveBeenCalledTimes(2);
      await adapter.typing?.(recipient, false);
      expect(client.sendTyping).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 2 }),
      );
      await adapter.stop("shutdown");
    } finally {
      vi.useRealTimers();
    }
  });
});

function fakeIlinkClient(overrides: {
  start?: () => Promise<void>;
  stop?: () => Promise<void>;
  getUpdates?: (
    cursor: string,
    signal?: AbortSignal,
  ) => Promise<{
    ret: number;
    msgs: readonly Record<string, unknown>[];
    get_updates_buf: string;
  }>;
  sendText?: (
    input: Readonly<{
      toUserId: string;
      text: string;
      contextToken: string;
      signal?: AbortSignal;
    }>,
  ) => Promise<Readonly<Record<string, unknown>>>;
} = {}) {
  return {
    start: vi.fn(
      overrides.start ?? (async () => undefined),
    ),
    stop: vi.fn(
      overrides.stop ?? (async () => undefined),
    ),
    getQrCode: vi.fn(async () => ({})),
    getQrCodeStatus: vi.fn(async () => ({})),
    getUpdates: vi.fn(
      overrides.getUpdates ?? (async () => ({
        ret: -1,
        msgs: [],
        get_updates_buf: "",
      })),
    ),
    sendText: vi.fn(
      overrides.sendText ?? (async () => ({
        ret: 0,
        errcode: 0,
      })),
    ),
    getConfig: vi.fn(async () => ({
      ret: 0,
      errcode: 0,
      typing_ticket: "typing-ticket",
    })),
    sendTyping: vi.fn(async () => ({
      ret: 0,
      errcode: 0,
    })),
  };
}
