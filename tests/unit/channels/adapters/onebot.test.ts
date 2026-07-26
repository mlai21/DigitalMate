import { EventEmitter, once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import {
  createPublicChannelGateway,
} from "@/agent-service/channel-gateway";
import {
  createOneBotAdapter,
} from "@/server/channels/adapters/onebot";
import {
  ONEBOT_API_TIMEOUT_MS,
  ONEBOT_EVENT_TASK_CAP,
  ONEBOT_EVENT_WATCHDOG_MS,
  ONEBOT_MAX_INLINE_ATTACHMENT_BYTES,
  createOneBotAttachmentFetcher,
  createOneBotGatewayHub,
  inspectOneBotAttachmentBatch,
  OneBotTransportError,
  type OneBotTransportPort,
} from "@/server/channels/adapters/onebot/transport";
import {
  ChannelAdapterRegistry,
  registerOneBotChannelAdapter,
} from "@/server/channels/runtime/registry";
import {
  assertStableExternalEventId,
  defineChannelContract,
} from "@/server/channels/testing/contract";

const NOW = new Date("2026-07-26T04:00:00.000Z");
const CONNECTION_ID =
  "20000000-0000-4000-8000-000000000001";
const CONTEXT = {
  connectionId: CONNECTION_ID,
  userId: "user-1",
  agentId: "agent-1",
  receivedAt: NOW,
};
const CONFIG = {
  enabled: true,
  access_token: "onebot-secret-token",
  share_session_in_group: false,
  ws_host: "127.0.0.1",
  ws_port: 65_000,
} as const;

defineChannelContract({
  type: "onebot",

  assertConfig() {
    const adapter = createOneBotAdapter({
      transport: new FakeTransport(),
      autoListen: false,
    });
    expect(adapter.validateConfig(CONFIG)).toMatchObject({
      access_token: CONFIG.access_token,
      share_session_in_group: false,
      ws_host: "0.0.0.0",
      ws_port: 6_199,
    });
    expect(() => adapter.validateConfig({
      ...CONFIG,
      access_token: " ",
    })).toThrow("onebot_access_token_required");
    expect(
      adapter.manifest.fields
        .filter((field) => ["ws_host", "ws_port"].includes(field.name))
        .every((field) => field.readonly),
    ).toBe(true);
  },

  async assertLifecycle() {
    const transport = new FakeTransport();
    const adapter = createOneBotAdapter({
      transport,
      autoListen: false,
      now: () => NOW,
    });
    const context = runtimeContext(adapter);

    await Promise.all([adapter.start(context), adapter.start(context)]);
    expect(transport.starts).toBe(1);
    expect(await adapter.health()).toMatchObject({
      status: "healthy",
    });
    transport.connected?.("10001");
    expect(await adapter.health()).toMatchObject({
      status: "healthy",
      lastConnectedAt: NOW,
    });
    await adapter.stop("reconfigure");
    await adapter.stop("reconfigure");
    expect(transport.stops).toBe(1);
  },

  async assertInbound() {
    const adapter = createOneBotAdapter({
      transport: new FakeTransport(),
      autoListen: false,
    });
    adapter.validateConfig(CONFIG);
    const direct = await adapter.normalizeInbound(
      await fixture("napcat-private.json"),
      CONTEXT,
    );
    const group = await adapter.normalizeInbound(
      await fixture("gocqhttp-group.json"),
      CONTEXT,
    );
    const cqString = await adapter.normalizeInbound(
      await fixture("lagrange-cq-string.json"),
      CONTEXT,
    );

    expect(direct).toMatchObject({
      externalEventId: "onebot:message:9000001",
      externalConversationId: "private:20001",
      externalSenderId: "20001",
      chatType: "direct",
      mentioned: true,
      text: "你好，DigitalMate",
      attachments: [],
    });
    expect(group).toMatchObject({
      externalEventId: "onebot:message:9000002",
      externalConversationId: "group:30001:user:20002",
      chatType: "group",
      mentioned: true,
      text: "看一下这张图",
      attachments: [{
        externalAttachmentId: "onebot:9000002:2",
        source: {
          kind: "image",
          fileId: "image-9002.jpg",
          url: "https://gchat.qpic.cn/image-9002.jpg",
        },
      }],
    });
    expect(JSON.stringify(group)).not.toContain("voice-ignored");
    expect(cqString).toMatchObject({
      externalConversationId: "group:30001:user:20003",
      text: "帮我读文件",
      attachments: [{
        fileName: "notes.md",
        source: {
          kind: "file",
          fileId: "file-9003",
        },
      }],
    });

    adapter.validateConfig({
      ...CONFIG,
      share_session_in_group: true,
    });
    expect(
      (
        await adapter.normalizeInbound(
          await fixture("gocqhttp-group.json"),
          CONTEXT,
        )
      )?.externalConversationId,
    ).toBe("group:30001");
  },

  async assertStableIds() {
    const adapter = createOneBotAdapter({
      transport: new FakeTransport(),
      autoListen: false,
    });
    adapter.validateConfig(CONFIG);
    const payload = await fixture("napcat-private.json");
    await expect(
      assertStableExternalEventId(() =>
        adapter.normalizeInbound(payload, CONTEXT)
      ),
    ).resolves.toBe("onebot:message:9000001");
  },

  async assertOutbound() {
    const transport = new FakeTransport();
    const adapter = createOneBotAdapter({
      transport,
      autoListen: false,
    });
    await adapter.start(runtimeContext(adapter));
    const direct = outboundDelivery();
    const directResult = await adapter.send(direct, sendContext(adapter));
    const groupResult = await adapter.send({
      ...direct,
      id: "delivery-onebot-2",
      recipient: {
        externalConversationId: "group:30001:user:20002",
        externalUserId: "20002",
        chatType: "group",
      },
      replyHandle: {
        publicFields: {
          messageType: "group",
          groupId: "30001",
          userId: "20002",
        },
        secretFields: {},
        expiresAt: null,
      },
    }, sendContext(adapter));

    expect(transport.requests).toEqual([
      {
        action: "send_private_msg",
        params: {
          user_id: "20001",
          message: [{ type: "text", data: { text: "完整回复" } }],
        },
      },
      {
        action: "send_group_msg",
        params: {
          group_id: "30001",
          message: [{ type: "text", data: { text: "完整回复" } }],
        },
      },
    ]);
    expect(directResult.externalMessageId).toBe("onebot-sent-1");
    expect(groupResult.externalMessageId).toBe("onebot-sent-2");
    expect(
      await adapter.resolveRecipient(direct.recipient),
    ).toEqual({
      address: {
        messageType: "private",
        userId: "20001",
      },
    });
    await adapter.stop("shutdown");
  },

  async assertHealth() {
    const transport = new FakeTransport();
    transport.startError = new OneBotTransportError({
      code: "polling_conflict",
      retryable: false,
    });
    const adapter = createOneBotAdapter({
      transport,
      autoListen: false,
      now: () => NOW,
    });

    await expect(
      adapter.start(runtimeContext(adapter)),
    ).rejects.toMatchObject({ code: "polling_conflict" });
    expect(await adapter.health()).toMatchObject({
      status: "degraded",
      error: {
        code: "polling_conflict",
        detail: "polling_conflict",
      },
    });
    expect(JSON.stringify(await adapter.health()))
      .not.toContain(CONFIG.access_token);
  },

  async assertShutdown() {
    const transport = new FakeTransport();
    const adapter = createOneBotAdapter({
      transport,
      autoListen: false,
    });
    const controller = new AbortController();
    await adapter.start(runtimeContext(adapter, controller.signal));
    controller.abort();
    await vi.waitFor(() => expect(transport.stops).toBe(1));
  },
});

describe("OneBot v11 reverse WebSocket boundary", () => {
  it("registers the production adapter", () => {
    const registry = new ChannelAdapterRegistry();
    registerOneBotChannelAdapter(registry);
    expect(registry.registeredTypes()).toEqual(["onebot"]);
  });

  it("only invokes durable ingress after a message frame", async () => {
    const transport = new FakeTransport();
    const acceptInbound = vi.fn(async () => ({
      kind: "accepted" as const,
      eventId: "event-onebot-1",
    }));
    const adapter = createOneBotAdapter({
      transport,
      scope: {
        userId: CONTEXT.userId,
        agentId: CONTEXT.agentId,
      },
      acceptInbound,
      now: () => NOW,
    });
    await adapter.start(runtimeContext(adapter));

    await transport.emitEvent(
      await fixture("napcat-private.json"),
    );

    expect(acceptInbound).toHaveBeenCalledOnce();
    expect(acceptInbound).toHaveBeenCalledWith(
      expect.objectContaining({ message_id: 9000001 }),
      {
        connectionId: CONNECTION_ID,
        agentId: CONTEXT.agentId,
        receivedAt: NOW,
      },
      {
        userId: CONTEXT.userId,
        agentId: CONTEXT.agentId,
      },
    );
    await adapter.stop("shutdown");
  });

  it("removes the authenticated route when stop overlaps start", async () => {
    const transport = new DelayedStartTransport();
    const adapter = createOneBotAdapter({
      transport,
      autoListen: false,
    });
    const starting = adapter.start(runtimeContext(adapter));
    await transport.entered;

    const stopping = adapter.stop("reconfigure");
    transport.release();

    await expect(starting).rejects.toMatchObject({
      code: "network_unreachable",
    });
    await stopping;
    expect(transport.stops).toBe(1);
    expect(await adapter.health()).toMatchObject({
      status: "stopped",
    });
  });

  it("waits for a running adapter to stop before starting its replacement", async () => {
    const transport = new FakeTransport();
    const adapter = createOneBotAdapter({
      transport,
      autoListen: false,
    });
    const context = runtimeContext(adapter);
    await adapter.start(context);

    const stopping = adapter.stop("reconfigure");
    const restarting = adapter.start(context);
    await Promise.all([stopping, restarting]);

    expect(transport.starts).toBe(2);
    expect(transport.stops).toBe(1);
    expect(await adapter.health()).toMatchObject({
      status: "healthy",
    });
    await adapter.stop("shutdown");
  });

  it("waits for an interrupted start to stop before starting its replacement", async () => {
    const transport = new DelayedStartTransport();
    const adapter = createOneBotAdapter({
      transport,
      autoListen: false,
    });
    const context = runtimeContext(adapter);
    const firstStart = adapter.start(context);
    const firstResult = firstStart.then(
      () => null,
      (error: unknown) => error,
    );
    await transport.entered;

    const stopping = adapter.stop("reconfigure");
    const restarting = adapter.start(context);
    transport.release();

    await expect(firstResult).resolves.toMatchObject({
      code: "network_unreachable",
    });
    await Promise.all([stopping, restarting]);
    expect(transport.starts).toBe(2);
    expect(transport.stops).toBe(1);
    expect(await adapter.health()).toMatchObject({
      status: "healthy",
    });
    await adapter.stop("shutdown");
  });

  it("authenticates bearer tokens before upgrading the socket", async () => {
    const hub = createOneBotGatewayHub();
    const transport = hub.createTransport();
    await transport.start({
      connectionId: CONNECTION_ID,
      accessToken: CONFIG.access_token,
      signal: new AbortController().signal,
      onEvent: async () => undefined,
      onConnected: () => undefined,
      onDisconnected: () => undefined,
    });
    const gateway = createPublicChannelGateway({
      port: 0,
      host: "127.0.0.1",
      authorizeUpgrade: (route, request) =>
        hub.authorize(route, request),
      onUpgrade: (route, socket, request) =>
        hub.accept(route, socket, request),
    });
    const { port } = await gateway.start();
    try {
      const rejected = new WebSocket(
        `ws://127.0.0.1:${port}/channel-gateway/onebot/${CONNECTION_ID}`,
      );
      rejected.on("error", () => undefined);
      const [, response] = await once(
        rejected,
        "unexpected-response",
      ) as [unknown, { statusCode: number }];
      expect(response.statusCode).toBe(401);

      const wrongToken = new WebSocket(
        `ws://127.0.0.1:${port}/channel-gateway/onebot/${CONNECTION_ID}`,
        { headers: { Authorization: "Bearer wrong-token" } },
      );
      wrongToken.on("error", () => undefined);
      const [, wrongTokenResponse] = await once(
        wrongToken,
        "unexpected-response",
      ) as [unknown, { statusCode: number }];
      expect(wrongTokenResponse.statusCode).toBe(401);

      const splitRole = new WebSocket(
        `ws://127.0.0.1:${port}/channel-gateway/onebot/${CONNECTION_ID}`,
        {
          headers: {
            Authorization: `Bearer ${CONFIG.access_token}`,
            "X-Client-Role": "API",
          },
        },
      );
      splitRole.on("error", () => undefined);
      const [, splitRoleResponse] = await once(
        splitRole,
        "unexpected-response",
      ) as [unknown, { statusCode: number }];
      expect(splitRoleResponse.statusCode).toBe(409);

      const accepted = new WebSocket(
        `ws://127.0.0.1:${port}/channel-gateway/onebot/${CONNECTION_ID}`,
        { headers: { Authorization: `Bearer ${CONFIG.access_token}` } },
      );
      accepted.on("error", () => undefined);
      await once(accepted, "open");
      accepted.close();
    } finally {
      await transport.stop();
      await gateway.stop();
    }
  });

  it("keeps large base64 responses behind the one MiB gateway frame boundary", async () => {
    const hub = createOneBotGatewayHub();
    const transport = hub.createTransport();
    await transport.start({
      connectionId: CONNECTION_ID,
      accessToken: CONFIG.access_token,
      signal: new AbortController().signal,
      onEvent: async () => undefined,
      onConnected: () => undefined,
      onDisconnected: () => undefined,
    });
    const gateway = createPublicChannelGateway({
      port: 0,
      host: "127.0.0.1",
      authorizeUpgrade: (route, request) =>
        hub.authorize(route, request),
      onUpgrade: (route, socket, request) =>
        hub.accept(route, socket, request),
    });
    const { port } = await gateway.start();
    const client = new WebSocket(
      `ws://127.0.0.1:${port}/channel-gateway/onebot/${CONNECTION_ID}`,
      { headers: { Authorization: `Bearer ${CONFIG.access_token}` } },
    );
    client.on("error", () => undefined);
    try {
      await once(client, "open");
      client.send(JSON.stringify(
        await fixture("lifecycle-connect.json"),
      ));
      await vi.waitFor(() =>
        expect(hub.connectionState(CONNECTION_ID))
          .toMatchObject({ connected: true })
      );
      const actionFrame = once(client, "message");
      const pending = transport.request(
        "get_image",
        { file: "large.jpg" },
        new AbortController().signal,
      );
      const rejected = pending.then(
        () => null,
        (error: unknown) => error,
      );
      const [payload] = await actionFrame;
      const echo = (
        JSON.parse(String(payload)) as { echo: string }
      ).echo;
      const oversized = Buffer.alloc(
        ONEBOT_MAX_INLINE_ATTACHMENT_BYTES + 64 * 1024,
        1,
      ).toString("base64");
      client.send(JSON.stringify({
        status: "ok",
        retcode: 0,
        data: { base64: oversized },
        echo,
      }));
      const [code] = await once(client, "close") as [number];
      expect([1006, 1009]).toContain(code);
      await expect(rejected).resolves.toMatchObject({
        code: "network_unreachable",
        retryable: true,
      });
    } finally {
      client.terminate();
      await transport.stop();
      await gateway.stop();
    }
  });

  it("does not let an authorization race cross a token rotation", async () => {
    const hub = createOneBotGatewayHub();
    const oldTransport = hub.createTransport();
    await oldTransport.start({
      connectionId: CONNECTION_ID,
      accessToken: "old-token",
      signal: new AbortController().signal,
      onEvent: async () => undefined,
      onConnected: () => undefined,
      onDisconnected: () => undefined,
    });
    const request = {
      headers: {
        authorization: "Bearer old-token",
      },
    };
    const route = {
      type: "onebot" as const,
      connectionId: CONNECTION_ID,
    };
    expect(
      hub.authorize(route, request as never),
    ).toBe(true);
    await oldTransport.stop();
    const newTransport = hub.createTransport();
    await newTransport.start({
      connectionId: CONNECTION_ID,
      accessToken: "new-token",
      signal: new AbortController().signal,
      onEvent: async () => undefined,
      onConnected: () => undefined,
      onDisconnected: () => undefined,
    });
    const socket = new FakeSocket();

    await hub.accept(
      route,
      socket as unknown as WebSocket,
      request as never,
    );

    expect(socket.closeCode).toBe(1008);
    expect(hub.connectionState(CONNECTION_ID)).toMatchObject({
      connected: false,
    });
    await newTransport.stop();
  });

  it("binds lifecycle self_id and accepts all three implementation fixtures", async () => {
    const accepted: unknown[] = [];
    const { hub, socket } = await connectedHub({
      onEvent: async (event) => {
        accepted.push(event);
      },
    });
    for (const name of [
      "napcat-private.json",
      "gocqhttp-group.json",
      "lagrange-cq-string.json",
    ]) {
      socket.emit("message", JSON.stringify(await fixture(name)), false);
    }
    await vi.waitFor(() => expect(accepted).toHaveLength(3));
    expect(hub.connectionState(CONNECTION_ID)).toMatchObject({
      selfId: "10001",
      connected: true,
    });
  });

  it("closes a connection whose message self_id differs from lifecycle", async () => {
    const { socket } = await connectedHub();
    socket.emit("message", JSON.stringify({
      ...(await fixture("napcat-private.json")),
      self_id: 99999,
    }), false);
    expect(socket.closeCode).toBe(1008);
  });

  it("rejects attachment and segment resource amplification before ingress", async () => {
    const adapter = createOneBotAdapter({
      transport: new FakeTransport(),
      autoListen: false,
    });
    adapter.validateConfig(CONFIG);
    const base = await fixture("napcat-private.json");
    const image = (index: number, size?: number) => ({
      type: "image",
      data: {
        file: `image-${index}.jpg`,
        ...(size === undefined ? {} : { size }),
      },
    });

    await expect(adapter.normalizeInbound({
      ...base,
      message_id: 9200001,
      message: Array.from({ length: 5 }, (_, index) =>
        image(index)),
    }, CONTEXT)).resolves.toBeNull();
    await expect(adapter.normalizeInbound({
      ...base,
      message_id: 9200002,
      message: Array.from({ length: 1_025 }, () => ({
        type: "text",
        data: { text: "x" },
      })),
    }, CONTEXT)).resolves.toBeNull();
    await expect(adapter.normalizeInbound({
      ...base,
      message_id: 9200003,
      message: [
        image(1, 8 * 1024 * 1024),
        image(2, 8 * 1024 * 1024),
        image(3, 8 * 1024 * 1024),
      ],
    }, CONTEXT)).resolves.toBeNull();
  });

  it("correlates UUID echoes and times API calls out", async () => {
    const { transport, socket } = await connectedHub({
      apiTimeoutMs: 20,
    });
    const pending = transport.request(
      "send_private_msg",
      { user_id: "20001", message: [] },
      new AbortController().signal,
    );
    const sent = JSON.parse(String(socket.sent[0])) as {
      echo: string;
    };
    expect(sent.echo).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    socket.emit("message", JSON.stringify({
      status: "ok",
      retcode: 0,
      data: { message_id: "echo-result" },
      echo: sent.echo,
    }), false);
    await expect(pending).resolves.toMatchObject({
      data: { message_id: "echo-result" },
    });

    await expect(
      transport.request(
        "get_image",
        { file: "missing" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: "network_unreachable",
      retryable: true,
    });
  });

  it("turns disconnects into retryable delivery failures without replaying ingress", async () => {
    const onEvent = vi.fn(async () => undefined);
    const { transport, socket } = await connectedHub({ onEvent });
    const pending = transport.request(
      "send_private_msg",
      { user_id: "20001", message: [] },
      new AbortController().signal,
    );
    const rejected = pending.then(
      () => null,
      (error: unknown) => error,
    );
    socket.close(1006);

    await expect(rejected).resolves.toMatchObject({
      code: "network_unreachable",
      retryable: true,
    });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("rejects old pending actions immediately when a socket is replaced", async () => {
    const { hub, transport, socket: first } =
      await connectedHub();
    const pending = transport.request(
      "send_private_msg",
      { user_id: "20001", message: [] },
      new AbortController().signal,
    );
    const rejected = pending.then(
      () => null,
      (error: unknown) => error,
    );
    const oldEcho = (
      JSON.parse(String(first.sent[0])) as { echo: string }
    ).echo;
    const replacement = new FakeSocket();

    await hub.accept(
      { type: "onebot", connectionId: CONNECTION_ID },
      replacement as unknown as WebSocket,
    );
    replacement.emit(
      "message",
      JSON.stringify(await fixture("lifecycle-connect.json")),
      false,
    );

    await expect(rejected).resolves.toMatchObject({
      code: "network_unreachable",
      retryable: true,
    });
    replacement.emit("message", JSON.stringify({
      status: "ok",
      retcode: 0,
      data: { message_id: "must-not-settle-old" },
      echo: oldEcho,
    }), false);
    const next = transport.request(
      "send_private_msg",
      { user_id: "20001", message: [] },
      new AbortController().signal,
    );
    const nextFrame = JSON.parse(
      String(replacement.sent.at(-1)),
    ) as { echo: string };
    replacement.emit("message", JSON.stringify({
      status: "ok",
      retcode: 0,
      data: { message_id: "new-result" },
      echo: nextFrame.echo,
    }), false);
    await expect(next).resolves.toMatchObject({
      data: { message_id: "new-result" },
    });
  });

  it("retrieves attachment bytes only through the allowlisted action", async () => {
    const request = vi.fn(async () => ({
      status: "ok" as const,
      retcode: 0,
      data: {
        file_name: "photo.png",
        mime_type: "image/png",
        base64: Buffer.from("image-bytes").toString("base64"),
      },
    }));
    const fetcher = createOneBotAttachmentFetcher({
      start: async () => undefined,
      stop: async () => undefined,
      request,
    });
    const descriptor = {
      externalAttachmentId: "onebot:9000002:2",
      fileName: "photo.png",
      mimeType: "image/png",
      sizeBytes: null,
      source: {
        kind: "image",
        fileId: "image-9002.jpg",
        url: "https://untrusted.example.test/photo.png",
      },
    };

    await expect(fetcher.inspect(descriptor)).resolves.toEqual({
      fileName: "photo.png",
      mimeType: "image/png",
      sizeBytes: 11,
    });
    const stream = await fetcher.download(descriptor);
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(
      Buffer.from("image-bytes"),
    );
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      "get_image",
      { file: "image-9002.jpg" },
      expect.any(AbortSignal),
    );
  });

  it("downloads large attachments from a fixed QQ CDN allowlist instead of WebSocket frames", async () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024, 7);
    const request = vi.fn();
    const fetchImpl = vi.fn(async () =>
      new Response(bytes, {
        status: 200,
        headers: {
          "content-length": String(bytes.byteLength),
          "content-type": "image/png",
        },
      })
    );
    const fetcher = createOneBotAttachmentFetcher({
      start: async () => undefined,
      stop: async () => undefined,
      request,
    }, { fetchImpl });
    const descriptor = {
      externalAttachmentId: "onebot:cdn:1",
      fileName: "photo.png",
      mimeType: "image/png",
      sizeBytes: null,
      source: {
        kind: "image",
        fileId: "photo.png",
        url: "https://gchat.qpic.cn/path/photo.png?token=opaque",
      },
    };

    await expect(fetcher.inspect(descriptor)).resolves.toEqual({
      fileName: "photo.png",
      mimeType: "image/png",
      sizeBytes: bytes.byteLength,
    });
    const stream = await fetcher.download(descriptor);
    let downloaded = 0;
    for await (const chunk of stream) {
      downloaded += chunk.byteLength;
    }
    expect(downloaded).toBe(bytes.byteLength);
    expect(fetchImpl).toHaveBeenCalledWith(
      descriptor.source.url,
      expect.objectContaining({
        method: "GET",
        redirect: "error",
      }),
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("cancels QQ CDN bodies rejected by declared or streamed size", async () => {
    const descriptor = {
      externalAttachmentId: "onebot:cdn:oversized",
      fileName: "photo.png",
      mimeType: "image/png",
      sizeBytes: null,
      source: {
        kind: "image",
        fileId: "photo.png",
        url: "https://gchat.qpic.cn/path/photo.png",
      },
    };
    const declaredCancel = vi.fn();
    const declaredBody = new ReadableStream<Uint8Array>({
      cancel: declaredCancel,
    });
    const declaredFetcher = createOneBotAttachmentFetcher({
      start: async () => undefined,
      stop: async () => undefined,
      request: vi.fn(),
    }, {
      fetchImpl: vi.fn(async () =>
        new Response(declaredBody, {
          status: 200,
          headers: {
            "content-length": String(10 * 1024 * 1024 + 1),
          },
        })
      ),
    });

    await expect(
      declaredFetcher.inspect(descriptor),
    ).rejects.toThrow("onebot_attachment_size_invalid");
    expect(declaredCancel).toHaveBeenCalledOnce();

    const streamedCancel = vi.fn();
    const chunk = new Uint8Array(6 * 1024 * 1024);
    const streamedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
      },
      cancel: streamedCancel,
    });
    const streamedFetcher = createOneBotAttachmentFetcher({
      start: async () => undefined,
      stop: async () => undefined,
      request: vi.fn(),
    }, {
      fetchImpl: vi.fn(async () =>
        new Response(streamedBody, { status: 200 })
      ),
    });

    await expect(
      streamedFetcher.inspect(descriptor),
    ).rejects.toThrow("onebot_attachment_size_invalid");
    expect(streamedCancel).toHaveBeenCalledOnce();
  });

  it("bounds attachment byte caches and releases content after download or TTL", async () => {
    const request = vi.fn(async () => ({
      status: "ok" as const,
      retcode: 0,
      data: {
        file_name: "tiny.txt",
        mime_type: "text/plain",
        base64: Buffer.from("x").toString("base64"),
      },
    }));
    const fetcher = createOneBotAttachmentFetcher({
      start: async () => undefined,
      stop: async () => undefined,
      request,
    }, { cacheTtlMs: 20 });
    const descriptor = (index: number) => ({
      externalAttachmentId: `onebot:cache:${index}`,
      fileName: "tiny.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      source: {
        kind: "file",
        fileId: `file-${index}`,
      },
    });
    await Promise.all(
      [1, 2, 3, 4].map((index) =>
        fetcher.inspect(descriptor(index))
      ),
    );
    await expect(
      fetcher.inspect(descriptor(5)),
    ).rejects.toThrow("onebot_attachment_cache_full");

    const stream = await fetcher.download(descriptor(1));
    const downloaded: Uint8Array[] = [];
    for await (const chunk of stream) downloaded.push(chunk);
    expect(Buffer.concat(downloaded)).toEqual(Buffer.from("x"));
    await expect(
      fetcher.inspect(descriptor(5)),
    ).resolves.toMatchObject({ sizeBytes: 1 });
    [2, 3, 4, 5].forEach((index) =>
      fetcher.release(descriptor(index))
    );

    await Promise.all(
      [6, 7, 8, 9].map((index) =>
        fetcher.inspect(descriptor(index))
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(
      fetcher.inspect(descriptor(10)),
    ).resolves.toMatchObject({ sizeBytes: 1 });
    [6, 7, 8, 9, 10].forEach((index) =>
      fetcher.release(descriptor(index))
    );
  });

  it("rechecks aggregate attachment bytes after platform metadata resolves", async () => {
    const release = vi.fn();
    const descriptors = [1, 2, 3].map((index) => ({
      externalAttachmentId: `onebot:batch:${index}`,
      fileName: `file-${index}.pdf`,
      mimeType: "application/pdf",
      sizeBytes: null,
      source: {
        kind: "file",
        fileId: `file-${index}`,
      },
    }));
    await expect(
      inspectOneBotAttachmentBatch({
        inspect: async (descriptor) => ({
          fileName: descriptor.fileName!,
          mimeType: "application/pdf",
          sizeBytes: 8 * 1024 * 1024,
        }),
        download: async () => (async function* () {
          yield new Uint8Array([1]);
        })(),
        release,
      }, descriptors),
    ).rejects.toThrow("attachment_message_too_large");
    expect(release).toHaveBeenCalledTimes(3);
  });

  it("caps active handlers at 500 and closes a wedged socket after the watchdog", async () => {
    expect(ONEBOT_EVENT_TASK_CAP).toBe(500);
    expect(ONEBOT_EVENT_WATCHDOG_MS).toBe(10_000);
    expect(ONEBOT_API_TIMEOUT_MS).toBe(30_000);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const capped = await connectedHub({
      eventTaskCap: ONEBOT_EVENT_TASK_CAP,
      eventWatchdogMs: 10_000,
      onEvent: async () => blocked,
    });
    for (let index = 0; index <= ONEBOT_EVENT_TASK_CAP; index += 1) {
      capped.socket.emit("message", JSON.stringify({
        ...(await fixture("napcat-private.json")),
        message_id: 9100000 + index,
      }), false);
    }
    expect(capped.socket.closeCode).toBe(1013);
    release();

    const watched = await connectedHub({
      eventWatchdogMs: 20,
      onEvent: async () => new Promise(() => undefined),
    });
    watched.socket.emit(
      "message",
      JSON.stringify(await fixture("napcat-private.json")),
      false,
    );
    await vi.waitFor(
      () => expect(watched.socket.closeCode).toBe(1011),
      { timeout: 200 },
    );
  });

  it("coalesces concurrent duplicate message frames before ingress", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onEvent = vi.fn(async () => blocked);
    const connected = await connectedHub({ onEvent });
    const payload = await fixture("napcat-private.json");

    connected.socket.emit(
      "message",
      JSON.stringify(payload),
      false,
    );
    connected.socket.emit(
      "message",
      JSON.stringify(payload),
      false,
    );

    await vi.waitFor(() => {
      expect(onEvent).toHaveBeenCalledOnce();
    });
    expect(connected.socket.closeCode).toBeNull();
    release();
  });

  it("keeps the hosted path fixed and documents QQ platform risk", async () => {
    const adapter = createOneBotAdapter({
      transport: new FakeTransport(),
      autoListen: false,
    });
    expect(adapter.validateConfig(CONFIG)).toMatchObject({
      ws_host: "0.0.0.0",
      ws_port: 6_199,
    });
    const guide = await readFile(
      path.join(process.cwd(), "docs/channels/onebot.md"),
      "utf8",
    );
    expect(guide).toContain(
      `/channel-gateway/onebot/${"{connection_id}"}`,
    );
    expect(guide).toMatch(/NapCat[\s\S]*go-cqhttp[\s\S]*Lagrange/u);
    expect(guide).toMatch(/风控|封禁/u);
  });
});

class FakeTransport implements OneBotTransportPort {
  starts = 0;
  stops = 0;
  requests: Array<{
    action: string;
    params: Record<string, unknown>;
  }> = [];
  startError: Error | null = null;
  connected?: (selfId: string) => void;
  disconnected?: (error: Error) => void;
  onEvent?: (event: unknown) => Promise<void>;

  async start(input: Parameters<OneBotTransportPort["start"]>[0]) {
    this.starts += 1;
    if (this.startError) throw this.startError;
    this.connected = input.onConnected;
    this.disconnected = input.onDisconnected;
    this.onEvent = input.onEvent;
  }

  async stop() {
    this.stops += 1;
  }

  async request(
    action: Parameters<OneBotTransportPort["request"]>[0],
    params: Record<string, unknown>,
  ) {
    this.requests.push({ action, params });
    return {
      status: "ok" as const,
      retcode: 0,
      data: {
        message_id: `onebot-sent-${this.requests.length}`,
      },
    };
  }

  async emitEvent(event: unknown) {
    await this.onEvent?.(event);
  }
}

class DelayedStartTransport extends FakeTransport {
  readonly entered: Promise<void>;
  #markEntered!: () => void;
  #continue!: () => void;
  #gate: Promise<void>;

  constructor() {
    super();
    this.entered = new Promise((resolve) => {
      this.#markEntered = resolve;
    });
    this.#gate = new Promise((resolve) => {
      this.#continue = resolve;
    });
  }

  override async start(
    input: Parameters<OneBotTransportPort["start"]>[0],
  ) {
    await super.start(input);
    this.#markEntered();
    await this.#gate;
  }

  release() {
    this.#continue();
  }
}

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: unknown[] = [];
  closeCode: number | null = null;

  send(data: unknown) {
    this.sent.push(data);
  }

  close(code?: number) {
    this.closeCode = code ?? 1000;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", this.closeCode);
  }

  terminate() {
    this.close(1006);
  }
}

async function connectedHub(options: {
  apiTimeoutMs?: number;
  eventTaskCap?: number;
  eventWatchdogMs?: number;
  onEvent?: (event: unknown) => Promise<void>;
} = {}) {
  const hub = createOneBotGatewayHub(options);
  const transport = hub.createTransport();
  await transport.start({
    connectionId: CONNECTION_ID,
    accessToken: CONFIG.access_token,
    signal: new AbortController().signal,
    onEvent: options.onEvent ?? (async () => undefined),
    onConnected: () => undefined,
    onDisconnected: () => undefined,
  });
  const socket = new FakeSocket();
  await hub.accept(
    { type: "onebot", connectionId: CONNECTION_ID },
    socket as unknown as WebSocket,
  );
  socket.emit(
    "message",
    JSON.stringify(await fixture("lifecycle-connect.json")),
    false,
  );
  return { hub, transport, socket };
}

function runtimeContext(
  adapter: ReturnType<typeof createOneBotAdapter>,
  signal = new AbortController().signal,
) {
  return {
    connectionId: CONNECTION_ID,
    agentId: CONTEXT.agentId,
    config: adapter.validateConfig(CONFIG),
    signal,
    now: () => NOW,
  };
}

function sendContext(
  adapter: ReturnType<typeof createOneBotAdapter>,
) {
  return {
    config: adapter.validateConfig(CONFIG),
    signal: new AbortController().signal,
    now: () => NOW,
  };
}

function outboundDelivery() {
  return {
    id: "delivery-onebot-1",
    eventId: "event-onebot-1",
    connectionId: CONNECTION_ID,
    assistantMessageId: "assistant-onebot-1",
    body: "完整回复",
    recipient: {
      externalConversationId: "private:20001",
      externalUserId: "20001",
      chatType: "direct" as const,
    },
    replyHandle: {
      publicFields: {
        messageType: "private",
        userId: "20001",
      },
      secretFields: {},
      expiresAt: null,
    },
  };
}

async function fixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(
      path.join(
        process.cwd(),
        "tests/fixtures/channels/onebot",
        name,
      ),
      "utf8",
    ),
  ) as Record<string, unknown>;
}
