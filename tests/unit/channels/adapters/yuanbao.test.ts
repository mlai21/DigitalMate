import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createYuanbaoTokenManager,
  formatYuanbaoTimestamp,
  generateYuanbaoSignature,
  YuanbaoAuthError,
} from "@/server/channels/adapters/yuanbao/auth";
import {
  createYuanbaoCodec,
  YUANBAO_BUSINESS_TYPES,
  YUANBAO_COMMANDS,
  YUANBAO_COMMAND_TYPES,
  YUANBAO_CONNECTION_TYPES,
  YUANBAO_MODULES,
} from "@/server/channels/adapters/yuanbao/codec";
import {
  createYuanbaoAdapter,
  parseYuanbaoConfig,
} from "@/server/channels/adapters/yuanbao";
import {
  createYuanbaoWebSocketClient,
  YUANBAO_AUTH_REFRESH_CODES,
  YUANBAO_NO_RECONNECT_CLOSE_CODES,
  YUANBAO_WEBSOCKET_URL,
  YuanbaoTransportError,
  type YuanbaoClientPort,
  type YuanbaoClientStartInput,
  type YuanbaoSocketLike,
} from "@/server/channels/adapters/yuanbao/transport";
import type {
  YuanbaoTokenManager,
} from "@/server/channels/adapters/yuanbao/auth";
import {
  createYuanbaoAttachmentFetcher,
  generateYuanbaoCosAuthorization,
  uploadYuanbaoMedia,
} from "@/server/channels/adapters/yuanbao/media";
import {
  ChannelAdapterRegistry,
  registerYuanbaoChannelAdapter,
} from "@/server/channels/runtime/registry";
import {
  assertStableExternalEventId,
  defineChannelContract,
} from "@/server/channels/testing/contract";

const FIXTURE_ROOT = path.join(
  process.cwd(),
  "tests/fixtures/channels/yuanbao",
);
const PROTO_ROOT = path.join(
  process.cwd(),
  "src/server/channels/adapters/yuanbao/proto",
);
const NOW = new Date("2026-07-26T00:00:00.000Z");
const CONTEXT = {
  connectionId: "connection-yuanbao",
  userId: "user-1",
  agentId: "agent-1",
  receivedAt: NOW,
};
const CONFIG = {
  enabled: true,
  app_id: "app-fixture",
  app_secret: "secret-fixture",
  api_domain: "bot.yuanbao.tencent.com",
  media_dir: null,
  accept_bot_messages: false,
} as const;

defineChannelContract({
  type: "yuanbao",

  assertConfig() {
    const adapter = createYuanbaoAdapter({
      autoListen: false,
    });
    expect(adapter.validateConfig(CONFIG)).toMatchObject({
      ...CONFIG,
      filter_thinking: true,
      filter_tool_messages: true,
    });
    expect(() =>
      adapter.validateConfig({
        ...CONFIG,
        app_id: "",
      })
    ).toThrow("yuanbao_app_id_required");
    expect(() =>
      adapter.validateConfig({
        ...CONFIG,
        app_secret: "",
      })
    ).toThrow("yuanbao_app_secret_required");
    expect(() =>
      adapter.validateConfig({
        ...CONFIG,
        api_domain: "http://localhost:3000/path",
      })
    ).toThrow("yuanbao_api_domain_invalid");
    expect(adapter.manifest.prerequisites).toContain(
      "腾讯元宝智能体机器人接入资格",
    );
    expect(adapter.manifest.capabilities)
      .toContain("groups");
    expect(JSON.stringify(adapter.manifest))
      .not.toContain(CONFIG.app_secret);
  },

  async assertLifecycle() {
    const client = fakeClient();
    const adapter = testAdapter(client);
    const context = runtimeContext(adapter);

    await Promise.all([
      adapter.start(context),
      adapter.start(context),
    ]);
    expect(client.starts).toBe(1);
    expect(await adapter.health()).toMatchObject({
      status: "healthy",
      reconnectAttempts: 0,
    });
    await adapter.stop("reconfigure");
    await adapter.stop("reconfigure");
    expect(client.stops).toBe(1);
  },

  async assertInbound() {
    const client = fakeClient();
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter));
    const direct = await adapter.normalizeInbound(
      await inboundFixture("message-c2c.json"),
      CONTEXT,
    );
    const group = await adapter.normalizeInbound(
      await inboundFixture("message-group.json"),
      CONTEXT,
    );
    const groupWithoutDeclaredSize =
      await inboundFixture("message-group.json");
    const unknownSize = await adapter.normalizeInbound(
      {
        ...groupWithoutDeclaredSize,
        msgBody: groupWithoutDeclaredSize.msgBody.map(
          (element) => ({
            ...element,
            msgContent: Object.fromEntries(
              Object.entries(element.msgContent)
                .filter(([key]) =>
                  key !== "file_size"
                  && key !== "fileSize"
                  && key !== "size"
                ),
            ),
          }),
        ),
      },
      CONTEXT,
    );

    expect(direct).toMatchObject({
      externalEventId:
        "yuanbao:message:msg-c2c-7001",
      externalConversationId: "user-alice",
      externalSenderId: "user-alice",
      chatType: "direct",
      mentioned: true,
      text: "你好，DigitalMate",
      attachments: [],
      replyHandle: {
        publicFields: {
          chatType: "direct",
          targetId: "user-alice",
        },
      },
    });
    expect(group).toMatchObject({
      externalEventId:
        "yuanbao:message:msg-group-7002",
      externalConversationId: "group-product",
      externalSenderId: "user-bob",
      chatType: "group",
      mentioned: true,
      text: "[quoted file: history.csv]\n看看这份记录",
      attachments: [{
        externalAttachmentId: "msg-group-7002:0",
        fileName: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        source: {
          resourceUrl: expect.stringContaining(
            "resourceId=resource-7002",
          ),
        },
      }],
      permission: {
        webSearch: false,
        backgroundNetwork: false,
        tools: false,
        skills: "none",
        attachmentsPresent: true,
      },
      replyHandle: {
        publicFields: {
          chatType: "group",
          targetId: "group-product",
        },
      },
    });
    expect(JSON.stringify(group?.rawSummary))
      .not.toContain("resource-7002");
    expect(unknownSize?.attachments[0]?.sizeBytes)
      .toBeNull();
    const directPayload =
      await inboundFixture("message-c2c.json");
    const quoteCases = [
      {
        quote: { type: 1, desc: "你好呀" },
        prefix: "[quoted message: 你好呀]",
      },
      {
        quote: { type: 2, desc: "" },
        prefix: "[quoted image]",
      },
      {
        quote: { type: 3, desc: "note.txt" },
        prefix: "[quoted file: note.txt]",
      },
      {
        quote: { type: 3, desc: "voice.mp3" },
        prefix: "[quoted audio: voice.mp3]",
      },
      {
        quote: { type: 99, desc: "" },
        prefix: "[quoted message]",
      },
    ] as const;
    for (const [index, value] of quoteCases.entries()) {
      const quoted = await adapter.normalizeInbound(
        {
          ...directPayload,
          msgId: `quote-${index}`,
          cloudCustomData: {
            quote: value.quote,
          },
        },
        CONTEXT,
      );
      expect(quoted?.text.startsWith(value.prefix))
        .toBe(true);
    }
    await adapter.stop("shutdown");
  },

  async assertStableIds() {
    const client = fakeClient();
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter));
    const payload =
      await inboundFixture("message-c2c.json");
    await expect(
      assertStableExternalEventId(() =>
        adapter.normalizeInbound(payload, CONTEXT)
      ),
    ).resolves.toBe(
      "yuanbao:message:msg-c2c-7001",
    );
    await adapter.stop("shutdown");
  },

  async assertOutbound() {
    const client = fakeClient();
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter));
    const result = await adapter.send(
      outboundDelivery(
        "😀".repeat(2_799),
      ),
      {
        config: adapter.validateConfig({
          ...CONFIG,
          bot_prefix: "前",
        }),
        signal: new AbortController().signal,
        now: () => NOW,
      },
    );

    expect(result.externalMessageId)
      .toBe("yuanbao-send-1");
    expect(client.texts).toHaveLength(1);
    expect(client.texts.every(
      (item) => item.chatType === "group"
        && item.targetId === "group-product",
    )).toBe(true);
    expect(client.texts.map((item) =>
      Array.from(item.text).length
    )).toEqual([2_800]);
    expect(client.texts[0]?.text.startsWith("前"))
      .toBe(true);
    expect(client.typing).toEqual([]);
    await expect(adapter.send(
      outboundDelivery("😀".repeat(2_800)),
      {
        config: adapter.validateConfig({
          ...CONFIG,
          bot_prefix: "前",
        }),
        signal: new AbortController().signal,
        now: () => NOW,
      },
    )).rejects.toThrow(
      "yuanbao_delivery_body_too_large",
    );
    expect(client.texts).toHaveLength(1);
    await adapter.stop("shutdown");
  },

  async assertHealth() {
    const secretError = new YuanbaoTransportError({
      code: "permission_denied",
      retryable: false,
      detail: "yuanbao_eligibility_required",
    });
    const adapter = testAdapter(
      fakeClient({ startError: secretError }),
    );
    await expect(
      adapter.start(runtimeContext(adapter)),
    ).rejects.toMatchObject({
      code: "permission_denied",
      detail: "yuanbao_eligibility_required",
    });
    expect(await adapter.health()).toMatchObject({
      status: "degraded",
      error: {
        code: "permission_denied",
        detail: "yuanbao_eligibility_required",
      },
    });
    expect(JSON.stringify(await adapter.health()))
      .not.toContain(CONFIG.app_secret);
  },

  async assertShutdown() {
    const client = fakeClient();
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

  async assertBinarySafety() {
    await expect(sha256(
      path.join(PROTO_ROOT, "conn.json"),
    )).resolves.toBe(
      "978b1110f19990c84125fd2f15d329287c13f2bf779d09ebe2b37086be7b7dd9",
    );
  },
});

describe("Yuanbao Protobuf compatibility", () => {
  it("keeps the fixed QwenPaw descriptors byte-for-byte", async () => {
    await expect(sha256(
      path.join(PROTO_ROOT, "conn.json"),
    )).resolves.toBe(
      "978b1110f19990c84125fd2f15d329287c13f2bf779d09ebe2b37086be7b7dd9",
    );
    await expect(sha256(
      path.join(PROTO_ROOT, "biz.json"),
    )).resolves.toBe(
      "0a17426c06bc20bcb50b9db78a9e503c3a7ef4c30325452a4ebe6289267c3ddd",
    );
  });

  it("matches the fixed AuthBind golden frame", async () => {
    const codec = createYuanbaoCodec({
      nextSequence: () => 7,
      nextMessageId: () =>
        "0123456789abcdef0123456789abcdef",
      randomUint32: () => 42,
    });
    const encoded = codec.encodeAuthBind({
      bizId: "ybBot",
      uid: "bot-fixture",
      source: "bot",
      token: "fixture-token",
    });
    const golden = await readFile(
      path.join(FIXTURE_ROOT, "auth-bind.bin"),
    );

    expect(encoded).toEqual(golden);
    expect(codec.decodeAuthBindResponse(
      await readFile(
        path.join(FIXTURE_ROOT, "auth-bind-rsp.bin"),
      ),
    )).toMatchObject({
      head: {
        cmdType: 1,
        cmd: "auth-bind",
        status: 0,
      },
      response: {
        code: 0,
        connectId: "connection-fixture",
      },
    });
  });
});

describe("Yuanbao sign-token authentication", () => {
  it("uses the fixed Beijing timestamp and HMAC payload", () => {
    const nonce =
      "00112233445566778899aabbccddeeff";
    const timestamp = formatYuanbaoTimestamp(
      new Date("2026-07-26T00:00:00.000Z"),
    );

    expect(timestamp).toBe(
      "2026-07-26T08:00:00+08:00",
    );
    expect(generateYuanbaoSignature({
      nonce,
      timestamp,
      appId: "app-fixture",
      appSecret: "secret-fixture",
    })).toBe(
      "0d4bfd2732835446f0fd69c7f43ddc462535a6baf774ea4f61e89cfe571ea070",
    );
  });

  it("retries code 10099 and refreshes once inside the 300-second margin", async () => {
    const responses = [
      {
        code: 10099,
        msg: "retry",
      },
      {
        code: 0,
        data: {
          bot_id: "bot-1",
          token: "token-1",
          source: "bot",
          duration: 600,
          product: "yuanbao",
        },
      },
      {
        code: 0,
        data: {
          bot_id: "bot-1",
          token: "token-2",
          source: "bot",
          duration: 600,
          product: "yuanbao",
        },
      },
    ];
    let now = new Date("2026-07-26T00:00:00.000Z");
    const fetchImpl = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      expect(String(input)).toBe(
        "https://bot.yuanbao.tencent.com/api/v5/robotLogic/sign-token",
      );
      const body = JSON.parse(
        String(init?.body),
      ) as Record<string, unknown>;
      expect(body).toMatchObject({
        app_key: "app-fixture",
        nonce:
          "00112233445566778899aabbccddeeff",
        timestamp:
          formatYuanbaoTimestamp(now),
      });
      expect(String(body.signature)).not.toContain(
        "secret-fixture",
      );
      return new Response(
        JSON.stringify(responses.shift()),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    });
    const manager = createYuanbaoTokenManager(
      {
        appId: "app-fixture",
        appSecret: "secret-fixture",
        apiDomain: "bot.yuanbao.tencent.com",
      },
      {
        fetchImpl: fetchImpl as typeof fetch,
        now: () => now,
        nonce: () =>
          "00112233445566778899aabbccddeeff",
        sleep: async () => undefined,
        scheduleRefresh: false,
      },
    );

    const first = await manager.getToken();
    expect(first.token).toBe("token-1");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(manager.getToken()).resolves.toBe(first);

    now = new Date(
      now.getTime() + 301 * 1_000,
    );
    const [refreshedA, refreshedB] = await Promise.all([
      manager.getToken(),
      manager.getToken(),
    ]);
    expect(refreshedA.token).toBe("token-2");
    expect(refreshedB).toBe(refreshedA);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    await manager.stop();
  });

  it("aborts an in-flight sign-token request when stopped", async () => {
    let requestSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn((
      _input: string | URL | Request,
      init?: RequestInit,
    ) => new Promise<Response>((_resolve, reject) => {
      requestSignal = init?.signal ?? undefined;
      requestSignal?.addEventListener(
        "abort",
        () => reject(
          requestSignal?.reason ?? new Error("aborted"),
        ),
        { once: true },
      );
    }));
    const manager = createYuanbaoTokenManager(
      {
        appId: "app-fixture",
        appSecret: "secret-fixture",
        apiDomain: "bot.yuanbao.tencent.com",
      },
      {
        fetchImpl: fetchImpl as typeof fetch,
        nonce: () =>
          "00112233445566778899aabbccddeeff",
        scheduleRefresh: false,
      },
    );
    const outcome = manager.getToken().then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    await manager.stop();

    expect(requestSignal?.aborted).toBe(true);
    await expect(outcome).resolves.toBeInstanceOf(
      YuanbaoAuthError,
    );
  });
});

describe("Yuanbao temporary media credentials", () => {
  it("uses auth only for URL resolution and never forwards it to CDN", async () => {
    const tokenManager = fakeTokenManager();
    const fetchImpl = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.includes("/api/resource/v1/download")) {
        expect(init?.headers).toMatchObject({
          "X-ID": "bot-fixture",
          "X-Token": "token-fixture",
        });
        return new Response(JSON.stringify({
          data: {
            url:
              "https://fixture.cos.ap-shanghai.myqcloud.com/notes.txt",
          },
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }
      expect(url).toContain("myqcloud.com/notes.txt");
      expect(init?.headers).not.toMatchObject({
        "X-Token": expect.anything(),
        authorization: expect.anything(),
      });
      return new Response("hello", {
        status: 200,
        headers: {
          "content-length": "5",
          "content-type": "text/plain",
        },
      });
    });
    const fetcher = createYuanbaoAttachmentFetcher({
      apiDomain: "bot.yuanbao.tencent.com",
      tokenManager,
      fetchImpl: fetchImpl as typeof fetch,
    });
    const descriptor = {
      externalAttachmentId: "msg-1:0",
      fileName: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      source: {
        resourceUrl:
          "https://bot.yuanbao.tencent.com/resource/file?resourceId=resource-1",
      },
    };

    await expect(
      fetcher.inspect(descriptor),
    ).resolves.toEqual({
      fileName: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    fetcher.release(descriptor);
  });

  it("keeps COS keys out of the returned upload result and rejects over 20 MiB", async () => {
    const tokenManager = fakeTokenManager();
    const temporarySecret = "cos-secret-fixture";
    const fetchImpl = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.includes("/api/resource/genUploadInfo")) {
        return new Response(JSON.stringify({
          data: {
            bucketName: "fixture-123",
            region: "ap-shanghai",
            location: "/uploads/notes.txt",
            encryptTmpSecretId: "cos-id-fixture",
            encryptTmpSecretKey: temporarySecret,
            encryptToken: "cos-token-fixture",
            startTime: 1_784_995_200,
            expiredTime: 1_784_997_000,
            resourceUrl:
              "https://fixture.cos.ap-shanghai.myqcloud.com/uploads/notes.txt",
            resourceID: "resource-upload-1",
          },
        }), { status: 200 });
      }
      expect(url).toBe(
        "https://fixture-123.cos.ap-shanghai.myqcloud.com/uploads/notes.txt",
      );
      const headers = init?.headers as Record<
        string,
        string
      >;
      expect(headers.authorization).toContain(
        "q-ak=cos-id-fixture",
      );
      expect(headers.authorization)
        .not.toContain(temporarySecret);
      expect(headers["x-cos-security-token"])
        .toBe("cos-token-fixture");
      return new Response(null, { status: 204 });
    });

    const uploaded = await uploadYuanbaoMedia({
      bytes: new TextEncoder().encode("hello"),
      fileName: "notes.txt",
      mimeType: "text/plain",
      apiDomain: "bot.yuanbao.tencent.com",
      tokenManager,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(uploaded).toMatchObject({
      resourceId: "resource-upload-1",
      sizeBytes: 5,
    });
    expect(JSON.stringify(uploaded))
      .not.toContain(temporarySecret);
    await expect(uploadYuanbaoMedia({
      bytes: new Uint8Array(
        20 * 1024 * 1024 + 1,
      ),
      fileName: "large.txt",
      mimeType: "text/plain",
      apiDomain: "bot.yuanbao.tencent.com",
      tokenManager,
      fetchImpl: fetchImpl as typeof fetch,
    })).rejects.toThrow("yuanbao_upload_size_invalid");
  });

  it("matches the QwenPaw COS HMAC-SHA1 shape", () => {
    const authorization =
      generateYuanbaoCosAuthorization({
        secretId: "cos-id-fixture",
        secretKey: "cos-secret-fixture",
        method: "PUT",
        pathname: "/uploads/notes.txt",
        headers: {
          host:
            "fixture-123.cos.ap-shanghai.myqcloud.com",
          "content-length": "5",
        },
        startTime: 1_784_995_200,
        expiredTime: 1_784_997_000,
      });
    expect(authorization).toContain(
      "q-sign-algorithm=sha1",
    );
    expect(authorization).toContain(
      "q-header-list=content-length;host",
    );
    expect(authorization).not.toContain(
      "cos-secret-fixture",
    );
  });
});

describe("Yuanbao WebSocket transport", () => {
  it("authenticates, acknowledges pushes, and correlates send responses", async () => {
    const sockets: FakeYuanbaoSocket[] = [];
    const tokenManager = fakeTokenManager();
    const codec = createYuanbaoCodec({
      nextSequence: sequenceGenerator(),
      nextMessageId: messageIdGenerator(),
      randomUint32: () => 42,
    });
    let releaseInbound: (() => void) | undefined;
    const onInbound = vi.fn(() =>
      new Promise<void>((resolve) => {
        releaseInbound = resolve;
      })
    );
    const states: unknown[] = [];
    const errors: YuanbaoTransportError[] = [];
    const client = createYuanbaoWebSocketClient(
      parseYuanbaoConfig(CONFIG),
      {
        codec,
        tokenManager,
        socketFactory(url, options) {
          expect(url).toBe(YUANBAO_WEBSOCKET_URL);
          expect(options).toMatchObject({
            rejectUnauthorized: true,
            maxPayload: 2 * 1024 * 1024,
          });
          const socket = new FakeYuanbaoSocket();
          sockets.push(socket);
          return socket;
        },
      },
    );
    const started = client.start({
      signal: new AbortController().signal,
      onInbound,
      onState: (state) => states.push(state),
      onError: (error) => errors.push(error),
    });
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    const socket = sockets[0]!;
    socket.open();
    await vi.waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });
    expect(
      codec.decodeFrame(socket.sent[0]!).head,
    ).toMatchObject({
      cmdType: YUANBAO_COMMAND_TYPES.request,
      cmd: YUANBAO_COMMANDS.authBind,
      module: YUANBAO_MODULES.connection,
    });
    socket.receive(codec.encodeConnectionFrame({
      head: {
        cmdType: YUANBAO_COMMAND_TYPES.response,
        cmd: YUANBAO_COMMANDS.authBind,
        module: YUANBAO_MODULES.connection,
        status: 0,
      },
      typeName:
        YUANBAO_CONNECTION_TYPES.authBindResponse,
      body: {
        code: 0,
        connectId: "connected-fixture",
      },
    }));
    await expect(started).resolves.toEqual({
      botId: "bot-fixture",
    });

    const sending = client.sendText({
      chatType: "direct",
      targetId: "user-alice",
      text: "你好",
    });
    await vi.waitFor(() => {
      expect(socket.sent).toHaveLength(2);
    });
    const sendHead =
      codec.decodeFrame(socket.sent[1]!).head;
    expect(sendHead).toMatchObject({
      cmd: YUANBAO_COMMANDS.sendC2C,
      module: YUANBAO_MODULES.business,
    });
    socket.receive(codec.encodeConnectionFrame({
      head: {
        cmdType: YUANBAO_COMMAND_TYPES.response,
        cmd: YUANBAO_COMMANDS.sendC2C,
        module: YUANBAO_MODULES.business,
        msgId: sendHead.msgId,
        status: 0,
      },
      typeName:
        YUANBAO_BUSINESS_TYPES.sendC2CResponse,
      body: {
        code: 0,
        message: "ok",
      },
    }));
    await expect(sending).resolves.toEqual({
      messageId: sendHead.msgId,
    });

    socket.receive(codec.encodeConnectionFrame({
      head: {
        cmdType: YUANBAO_COMMAND_TYPES.push,
        cmd: "message_push",
        module: YUANBAO_MODULES.business,
        msgId: "push-fixture",
        needAck: true,
      },
      data: new TextEncoder().encode(
        JSON.stringify(
          await rawFixture("message-c2c.json"),
        ),
      ),
    }));
    await vi.waitFor(() => {
      expect(onInbound).toHaveBeenCalledTimes(1);
    });
    expect(socket.sent).toHaveLength(2);
    const concurrentSending = client.sendText({
      chatType: "direct",
      targetId: "user-alice",
      text: "响应不能被入站持久化阻塞",
    });
    await vi.waitFor(() => {
      expect(socket.sent).toHaveLength(3);
    });
    const concurrentHead =
      codec.decodeFrame(socket.sent[2]!).head;
    socket.receive(codec.encodeConnectionFrame({
      head: {
        cmdType: YUANBAO_COMMAND_TYPES.response,
        cmd: YUANBAO_COMMANDS.sendC2C,
        module: YUANBAO_MODULES.business,
        msgId: concurrentHead.msgId,
        status: 0,
      },
      typeName:
        YUANBAO_BUSINESS_TYPES.sendC2CResponse,
      body: {
        code: 0,
        message: "ok",
      },
    }));
    await expect(concurrentSending).resolves.toEqual({
      messageId: concurrentHead.msgId,
    });
    releaseInbound?.();
    await vi.waitFor(() => {
      expect(socket.sent).toHaveLength(4);
    });
    expect(
      codec.decodeFrame(socket.sent[3]!).head,
    ).toMatchObject({
      cmdType: YUANBAO_COMMAND_TYPES.pushAck,
      msgId: "push-fixture",
    });
    expect(errors).toEqual([]);
    expect(states).toContainEqual({
      status: "connected",
      reconnectAttempts: 0,
    });
    await client.stop();
    expect(tokenManager.stop).toHaveBeenCalledTimes(1);
  });

  it("settles an in-flight start when stopped during authentication", async () => {
    const sockets: FakeYuanbaoSocket[] = [];
    const client = createYuanbaoWebSocketClient(
      parseYuanbaoConfig(CONFIG),
      {
        tokenManager: fakeTokenManager(),
        socketFactory() {
          const socket = new FakeYuanbaoSocket();
          sockets.push(socket);
          return socket;
        },
      },
    );
    const started = client.start({
      signal: new AbortController().signal,
      onInbound: async () => undefined,
      onState: () => undefined,
      onError: () => undefined,
    });
    const outcome = started.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    await client.stop();

    await expect(outcome).resolves.toMatchObject({
      code: "network_unreachable",
      retryable: true,
      detail: "yuanbao_client_stopped",
    });
    expect(sockets[0]?.readyState).toBe(3);
  });

  it("maps terminal and auth-refresh close codes during authentication", async () => {
    const terminal = await pendingAuthenticationTransport();
    terminal.socket.serverClose(4012);
    await expect(terminal.started).rejects.toMatchObject({
      code: "permission_denied",
      retryable: false,
      detail: "yuanbao_close_not_reconnectable",
    });
    expect(
      terminal.tokenManager.forceRefresh,
    ).not.toHaveBeenCalled();
    await terminal.client.stop();

    const refresh = await pendingAuthenticationTransport();
    refresh.socket.serverClose(41103);
    await expect(refresh.started).rejects.toMatchObject({
      code: "network_unreachable",
      retryable: true,
      detail: "yuanbao_auth_refresh_required",
    });
    await vi.waitFor(() => {
      expect(
        refresh.tokenManager.forceRefresh,
      ).toHaveBeenCalledTimes(1);
    });
    await refresh.client.stop();
  });

  it("refreshes and exposes a retryable error when initial AuthBind expires", async () => {
    const pending = await pendingAuthenticationTransport();
    pending.socket.open();
    await vi.waitFor(() => {
      expect(pending.socket.sent).toHaveLength(1);
    });
    pending.socket.receive(
      pending.codec.encodeConnectionFrame({
        head: {
          cmdType: YUANBAO_COMMAND_TYPES.response,
          cmd: YUANBAO_COMMANDS.authBind,
          module: YUANBAO_MODULES.connection,
        },
        typeName:
          YUANBAO_CONNECTION_TYPES.authBindResponse,
        body: {
          code: 41103,
          message: "expired",
        },
      }),
    );

    await expect(pending.started).rejects.toMatchObject({
      code: "network_unreachable",
      retryable: true,
      detail: "yuanbao_auth_refresh_required",
    });
    await vi.waitFor(() => {
      expect(
        pending.tokenManager.forceRefresh,
      ).toHaveBeenCalledTimes(1);
    });
    await pending.client.stop();
  });

  it.each([
    {
      statusCode: 401,
      code: "credential_invalid",
      detail: "yuanbao_credential_invalid",
    },
    {
      statusCode: 403,
      code: "permission_denied",
      detail: "yuanbao_eligibility_required",
    },
  ])(
    "maps an HTTP $statusCode websocket upgrade rejection",
    async ({ statusCode, code, detail }) => {
      const pending = await pendingAuthenticationTransport();
      pending.socket.emit(
        "unexpected-response",
        {},
        { statusCode },
      );

      await expect(pending.started).rejects.toMatchObject({
        code,
        retryable: false,
        detail,
      });
      await pending.client.stop();
    },
  );

  it("closes the socket when AuthBind is rejected", async () => {
    const sockets: FakeYuanbaoSocket[] = [];
    const codec = createYuanbaoCodec({
      nextSequence: sequenceGenerator(),
      nextMessageId: messageIdGenerator(),
      randomUint32: () => 42,
    });
    const client = createYuanbaoWebSocketClient(
      parseYuanbaoConfig(CONFIG),
      {
        codec,
        tokenManager: fakeTokenManager(),
        socketFactory() {
          const socket = new FakeYuanbaoSocket();
          sockets.push(socket);
          return socket;
        },
      },
    );
    const started = client.start({
      signal: new AbortController().signal,
      onInbound: async () => undefined,
      onState: () => undefined,
      onError: () => undefined,
    });
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    const socket = sockets[0]!;
    socket.open();
    await vi.waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });
    socket.receive(codec.encodeConnectionFrame({
      head: {
        cmdType: YUANBAO_COMMAND_TYPES.response,
        cmd: YUANBAO_COMMANDS.authBind,
        module: YUANBAO_MODULES.connection,
        status: 403,
      },
      typeName:
        YUANBAO_CONNECTION_TYPES.authBindResponse,
      body: {
        code: 403,
        message: "rejected",
      },
    }));

    await expect(started).rejects.toMatchObject({
      code: "credential_invalid",
      retryable: false,
      detail: "yuanbao_auth_bind_rejected",
    });
    expect(socket.readyState).toBe(3);
    await client.stop();
  });

  it("does not reconnect terminal close codes and refreshes auth close codes", async () => {
    expect(
      YUANBAO_NO_RECONNECT_CLOSE_CODES.has(4012),
    ).toBe(true);
    expect(
      YUANBAO_AUTH_REFRESH_CODES.has(41103),
    ).toBe(true);
    const first = await connectedTransport();
    first.socket.serverClose(4012);
    await vi.waitFor(() => {
      expect(first.errors).toContainEqual(
        expect.objectContaining({
          code: "permission_denied",
          retryable: false,
        }),
      );
    });
    expect(first.states).toContainEqual({
      status: "disconnected",
      reconnectAttempts: 0,
      retryExhausted: true,
    });
    expect(first.sockets).toHaveLength(1);
    await first.client.stop();

    const second = await connectedTransport();
    second.socket.serverClose(41103);
    await vi.waitFor(() => {
      expect(
        second.tokenManager.forceRefresh,
      ).toHaveBeenCalledTimes(1);
    });
    await second.client.stop();
  });

  it("closes an invalid runtime AuthBind even when token refresh fails", async () => {
    const connected = await connectedTransport();
    connected.tokenManager.forceRefresh
      .mockRejectedValueOnce(new Error("refresh failed"));
    connected.socket.receive(
      connected.codec.encodeConnectionFrame({
        head: {
          cmdType: YUANBAO_COMMAND_TYPES.response,
          cmd: YUANBAO_COMMANDS.authBind,
          module: YUANBAO_MODULES.connection,
        },
        typeName:
          YUANBAO_CONNECTION_TYPES.authBindResponse,
        body: {
          code: 41103,
          message: "expired",
        },
      }),
    );

    await vi.waitFor(() => {
      expect(connected.socket.readyState).toBe(3);
    });
    expect(
      connected.tokenManager.forceRefresh,
    ).toHaveBeenCalledTimes(1);
    await connected.client.stop();
  });

  it("rejects rather than hanging on a malformed correlated response", async () => {
    const connected = await connectedTransport();
    const sending = connected.client.sendText({
      chatType: "direct",
      targetId: "user-alice",
      text: "测试异常响应",
    });
    await vi.waitFor(() => {
      expect(connected.socket.sent).toHaveLength(2);
    });
    const head = connected.codec.decodeFrame(
      connected.socket.sent[1]!,
    ).head;
    connected.socket.receive(
      connected.codec.encodeConnectionFrame({
        head: {
          cmdType: YUANBAO_COMMAND_TYPES.response,
          cmd: YUANBAO_COMMANDS.sendC2C,
          module: YUANBAO_MODULES.business,
          msgId: head.msgId,
          status: 0,
        },
        data: Uint8Array.from([0xff]),
      }),
    );

    await expect(sending).rejects.toMatchObject({
      code: "unknown",
      retryable: false,
      detail: "delivery_outcome_unknown",
    });
    await connected.client.stop();
  });

  it("does not retry after the socket accepted a write but lost its response", async () => {
    const connected = await connectedTransport();
    const sending = connected.client.sendText({
      chatType: "direct",
      targetId: "user-alice",
      text: "只允许发送一次",
    });
    await vi.waitFor(() => {
      expect(connected.socket.sent).toHaveLength(2);
    });

    connected.socket.serverClose(1006);

    await expect(sending).rejects.toMatchObject({
      code: "unknown",
      retryable: false,
      detail: "delivery_outcome_unknown",
    });
    await connected.client.stop();
  });

  it("does not retry when shutdown aborts after the socket accepted a write", async () => {
    const connected = await connectedTransport();
    const controller = new AbortController();
    const sending = connected.client.sendText({
      chatType: "direct",
      targetId: "user-alice",
      text: "写入后停止也不能重发",
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(connected.socket.sent).toHaveLength(2);
    });

    controller.abort(new Error("shutdown"));

    await expect(sending).rejects.toMatchObject({
      code: "unknown",
      retryable: false,
      detail: "delivery_outcome_unknown",
    });
    await connected.client.stop();
  });

  it("does not retry when abort races the websocket send callback", async () => {
    const connected = await connectedTransport();
    connected.socket.deferSendCallbacks = true;
    const controller = new AbortController();
    const sending = connected.client.sendText({
      chatType: "direct",
      targetId: "user-alice",
      text: "回调前中断也不能重发",
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(connected.socket.sent).toHaveLength(2);
    });

    controller.abort(new Error("shutdown"));

    await expect(sending).rejects.toMatchObject({
      code: "unknown",
      retryable: false,
      detail: "delivery_outcome_unknown",
    });
    await connected.client.stop();
  });

  it.each([
    {
      bodyCode: 429,
      code: "rate_limited",
      retryable: true,
    },
    {
      bodyCode: 401,
      code: "credential_invalid",
      retryable: false,
    },
    {
      bodyCode: 403,
      code: "credential_invalid",
      retryable: false,
    },
  ])(
    "classifies a send response body code $bodyCode",
    async ({ bodyCode, code, retryable }) => {
      const connected = await connectedTransport();
      const sending = connected.client.sendText({
        chatType: "direct",
        targetId: "user-alice",
        text: "业务错误码",
      });
      await vi.waitFor(() => {
        expect(connected.socket.sent).toHaveLength(2);
      });
      const head = connected.codec.decodeFrame(
        connected.socket.sent[1]!,
      ).head;
      connected.socket.receive(
        connected.codec.encodeConnectionFrame({
          head: {
            cmdType: YUANBAO_COMMAND_TYPES.response,
            cmd: YUANBAO_COMMANDS.sendC2C,
            module: YUANBAO_MODULES.business,
            msgId: head.msgId,
            status: 0,
          },
          typeName:
            YUANBAO_BUSINESS_TYPES.sendC2CResponse,
          body: {
            code: bodyCode,
            message: "rejected",
          },
        }),
      );

      await expect(sending).rejects.toMatchObject({
        code,
        retryable,
        detail: "yuanbao_send_rejected",
      });
      await connected.client.stop();
    },
  );

  it("encodes Ping/Pong and private/group typing heartbeats", () => {
    const codec = createYuanbaoCodec({
      nextSequence: sequenceGenerator(),
      nextMessageId: messageIdGenerator(),
      randomUint32: () => 42,
    });
    expect(codec.decodeFrame(codec.encodePing()).head)
      .toMatchObject({
        cmd: YUANBAO_COMMANDS.ping,
        cmdType: YUANBAO_COMMAND_TYPES.request,
      });
    const pong = codec.encodeConnectionFrame({
      head: {
        cmdType: YUANBAO_COMMAND_TYPES.response,
        cmd: YUANBAO_COMMANDS.ping,
        module: YUANBAO_MODULES.connection,
      },
      typeName: YUANBAO_CONNECTION_TYPES.pingResponse,
      body: {
        heartInterval: 9,
        timestamp: "1784995200",
      },
    });
    expect(codec.decodePingResponse(pong))
      .toMatchObject({
        heartInterval: 9,
        timestamp: "1784995200",
      });
    expect(codec.decodeFrame(codec.encodeTyping({
      fromAccount: "bot-fixture",
      toAccount: "user-alice",
      heartbeat: 1,
    }).raw).head.cmd).toBe(
      YUANBAO_COMMANDS.privateHeartbeat,
    );
    expect(codec.decodeFrame(codec.encodeTyping({
      fromAccount: "bot-fixture",
      toAccount: "",
      groupCode: "group-product",
      heartbeat: 2,
    }).raw).head.cmd).toBe(
      YUANBAO_COMMANDS.groupHeartbeat,
    );
  });
});

async function sha256(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

type FakeYuanbaoClient = YuanbaoClientPort & {
  starts: number;
  stops: number;
  texts: Array<Readonly<{
    chatType: "direct" | "group";
    targetId: string;
    text: string;
  }>>;
  typing: Array<Readonly<{
    chatType: "direct" | "group";
    targetId: string;
    heartbeat: 1 | 2;
  }>>;
  startInput: YuanbaoClientStartInput | null;
};

function fakeClient(
  options: Readonly<{
    startError?: unknown;
  }> = {},
): FakeYuanbaoClient {
  const fetcher = {
    inspect: vi.fn(async () => ({
      fileName: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
    })),
    download: vi.fn(async () => (
      async function* () {
        yield new TextEncoder().encode("hello");
      }
    )()),
  };
  const client: FakeYuanbaoClient = {
    starts: 0,
    stops: 0,
    texts: [],
    typing: [],
    startInput: null,
    async start(input) {
      client.starts += 1;
      client.startInput = input;
      if (options.startError) {
        throw options.startError;
      }
      input.onState({
        status: "connected",
        reconnectAttempts: 0,
      });
      return { botId: "bot-fixture" };
    },
    async stop() {
      client.stops += 1;
    },
    async sendText(input) {
      client.texts.push({
        chatType: input.chatType,
        targetId: input.targetId,
        text: input.text,
      });
      return {
        messageId:
          `yuanbao-send-${client.texts.length}`,
      };
    },
    async sendTyping(input) {
      client.typing.push({
        chatType: input.chatType,
        targetId: input.targetId,
        heartbeat: input.heartbeat,
      });
    },
    attachmentFetcher() {
      return {
        ...fetcher,
        release: vi.fn(),
      };
    },
  };
  return client;
}

function testAdapter(
  client: FakeYuanbaoClient,
) {
  const adapter = createYuanbaoAdapter({
    clientFactory: () => client,
    autoListen: false,
    scope: {
      userId: "user-1",
      agentId: "agent-1",
    },
    now: () => NOW,
  });
  adapter.validateConfig(CONFIG);
  return adapter;
}

function runtimeContext(
  adapter: ReturnType<typeof testAdapter>,
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

async function inboundFixture(
  fileName: string,
) {
  const value = JSON.parse(
    await readFile(
      path.join(FIXTURE_ROOT, fileName),
      "utf8",
    ),
  );
  return createYuanbaoCodec().decodeInbound(
    new TextEncoder().encode(
      JSON.stringify(value),
    ),
  );
}

function outboundDelivery(body: string) {
  return {
    id: "delivery-yuanbao",
    eventId: "event-yuanbao",
    connectionId: CONTEXT.connectionId,
    assistantMessageId: "assistant-yuanbao",
    body,
    recipient: {
      externalConversationId: "group-product",
      externalUserId: "user-bob",
      chatType: "group" as const,
    },
    replyHandle: {
      publicFields: {
        chatType: "group",
        targetId: "group-product",
      },
      secretFields: {},
      expiresAt: null,
    },
  };
}

class FakeYuanbaoSocket
  extends EventEmitter
  implements YuanbaoSocketLike {
  #readyState = 0;
  readonly sent: Uint8Array[] = [];
  deferSendCallbacks = false;
  readonly pendingSendCallbacks: Array<
    (error?: Error) => void
  > = [];

  get readyState() {
    return this.#readyState;
  }

  open(): void {
    this.#readyState = 1;
    this.emit("open");
  }

  send(
    data: Uint8Array,
    callback?: (error?: Error) => void,
  ): void {
    this.sent.push(Uint8Array.from(data));
    if (callback && this.deferSendCallbacks) {
      this.pendingSendCallbacks.push(callback);
    } else {
      callback?.();
    }
  }

  receive(data: Uint8Array): void {
    this.emit("message", Buffer.from(data), true);
  }

  serverClose(code: number): void {
    this.#readyState = 3;
    this.emit("close", code);
  }

  close(): void {
    this.#readyState = 3;
  }

  terminate(): void {
    this.#readyState = 3;
  }
}

function fakeTokenManager(): YuanbaoTokenManager & {
  getToken: ReturnType<typeof vi.fn>;
  forceRefresh: ReturnType<typeof vi.fn>;
  getAuthHeaders: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  const token = {
    botId: "bot-fixture",
    token: "token-fixture",
    source: "bot",
    durationSeconds: 600,
    product: "yuanbao",
  };
  return {
    getToken: vi.fn(async () => token),
    forceRefresh: vi.fn(async () => token),
    getAuthHeaders: vi.fn(async () => ({
      "X-ID": token.botId,
      "X-Token": token.token,
      "X-Source": token.source,
    })),
    stop: vi.fn(async () => undefined),
  };
}

function sequenceGenerator(): () => number {
  let value = 0;
  return () => {
    value += 1;
    return value;
  };
}

function messageIdGenerator(): () => string {
  let value = 0;
  return () => {
    value += 1;
    return `message-${value}`;
  };
}

async function rawFixture(
  fileName: string,
): Promise<unknown> {
  return JSON.parse(
    await readFile(
      path.join(FIXTURE_ROOT, fileName),
      "utf8",
    ),
  ) as unknown;
}

async function connectedTransport() {
  const sockets: FakeYuanbaoSocket[] = [];
  const tokenManager = fakeTokenManager();
  const errors: YuanbaoTransportError[] = [];
  const states: unknown[] = [];
  const codec = createYuanbaoCodec({
    nextSequence: sequenceGenerator(),
    nextMessageId: messageIdGenerator(),
    randomUint32: () => 42,
  });
  const client = createYuanbaoWebSocketClient(
    parseYuanbaoConfig(CONFIG),
    {
      codec,
      tokenManager,
      socketFactory() {
        const socket = new FakeYuanbaoSocket();
        sockets.push(socket);
        return socket;
      },
    },
  );
  const started = client.start({
    signal: new AbortController().signal,
    onInbound: async () => undefined,
    onState: (state) => states.push(state),
    onError: (error) => errors.push(error),
  });
  await vi.waitFor(() => {
    expect(sockets).toHaveLength(1);
  });
  const socket = sockets[0]!;
  socket.open();
  await vi.waitFor(() => {
    expect(socket.sent).toHaveLength(1);
  });
  socket.receive(codec.encodeConnectionFrame({
    head: {
      cmdType: YUANBAO_COMMAND_TYPES.response,
      cmd: YUANBAO_COMMANDS.authBind,
      module: YUANBAO_MODULES.connection,
    },
    typeName:
      YUANBAO_CONNECTION_TYPES.authBindResponse,
    body: {
      code: 0,
      connectId: "connection-fixture",
    },
  }));
  await started;
  return {
    client,
    socket,
    sockets,
    tokenManager,
    errors,
    states,
    codec,
  };
}

async function pendingAuthenticationTransport() {
  const tokenManager = fakeTokenManager();
  const socket = new FakeYuanbaoSocket();
  const codec = createYuanbaoCodec({
    nextSequence: sequenceGenerator(),
    nextMessageId: messageIdGenerator(),
    randomUint32: () => 42,
  });
  const client = createYuanbaoWebSocketClient(
    parseYuanbaoConfig(CONFIG),
    {
      codec,
      tokenManager,
      socketFactory: () => socket,
    },
  );
  const started = client.start({
    signal: new AbortController().signal,
    onInbound: async () => undefined,
    onState: () => undefined,
    onError: () => undefined,
  });
  await vi.waitFor(() => {
    expect(socket.listenerCount("close")).toBe(1);
  });
  return {
    client,
    socket,
    codec,
    tokenManager,
    started,
  };
}

describe("Yuanbao typing lifecycle", () => {
  it("sends running every three seconds and one finish after Agent processing", async () => {
    vi.useFakeTimers();
    try {
      const client = fakeClient();
      const adapter = testAdapter(client);
      await adapter.start(runtimeContext(adapter));
      const recipient = await adapter.resolveRecipient({
        externalConversationId: "group-product",
        externalUserId: "user-bob",
        chatType: "group",
      });

      await adapter.typing?.(recipient, true);
      expect(client.typing.map((item) => item.heartbeat))
        .toEqual([1]);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(client.typing.map((item) => item.heartbeat))
        .toEqual([1, 1]);
      await adapter.typing?.(recipient, false);
      expect(client.typing.map((item) => item.heartbeat))
        .toEqual([1, 1, 2]);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(client.typing.map((item) => item.heartbeat))
        .toEqual([1, 1, 2]);
      await adapter.stop("shutdown");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Yuanbao adapter registry", () => {
  it("registers the production factory exactly once", () => {
    const registry = new ChannelAdapterRegistry();
    registerYuanbaoChannelAdapter(registry);
    expect(registry.has("yuanbao")).toBe(true);
    expect(() =>
      registerYuanbaoChannelAdapter(registry)
    ).toThrow("duplicate_channel_adapter:yuanbao");
  });
});
