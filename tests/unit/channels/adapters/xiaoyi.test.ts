import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  ATTACHMENT_LIMITS,
} from "@/server/attachments/types";
import {
  createXiaoYiAdapter,
  parseXiaoYiConfig,
} from "@/server/channels/adapters/xiaoyi";
import {
  generateXiaoYiAuthHeaders,
  generateXiaoYiSignature,
} from "@/server/channels/adapters/xiaoyi/auth";
import {
  buildXiaoYiArtifactFrame,
  buildXiaoYiControlResponse,
  normalizeXiaoYiInbound,
  splitXiaoYiText,
  xiaoYiControlRequest,
} from "@/server/channels/adapters/xiaoyi/protocol";
import {
  createXiaoYiAttachmentFetcher,
  createXiaoYiWebSocketClient,
  inspectXiaoYiAttachmentBatch,
  mapXiaoYiError,
  XIAOYI_ENDPOINTS,
  XIAOYI_HEARTBEAT_INTERVAL_MS,
  XIAOYI_MAX_RECONNECT_ATTEMPTS,
  XIAOYI_RECONNECT_DELAYS_MS,
  type XiaoYiClientPort,
  type XiaoYiClientStartInput,
  type XiaoYiServerName,
  type XiaoYiSocketLike,
} from "@/server/channels/adapters/xiaoyi/transport";
import {
  ChannelConnectionError,
  createChannelConnectionManager,
  type RuntimeChannelHealthUpdate,
} from "@/server/channels/runtime/connection-manager";
import type {
  ClaimedChannelDelivery,
} from "@/server/channels/runtime/delivery-repository";
import {
  createChannelDeliveryWorker,
} from "@/server/channels/runtime/delivery-worker";
import {
  ChannelAdapterRegistry,
  registerXiaoYiChannelAdapter,
} from "@/server/channels/runtime/registry";
import {
  assertStableExternalEventId,
  defineChannelContract,
} from "@/server/channels/testing/contract";

const NOW = new Date("2026-07-26T00:00:00.000Z");
const CONTEXT = {
  connectionId: "connection-xiaoyi",
  userId: "user-1",
  agentId: "agent-1",
  receivedAt: NOW,
};
const CONFIG = {
  enabled: true,
  ak: "xiaoyi-access-key",
  sk: "xiaoyi-secret-key",
  agent_id: "agent-xiaoyi",
  task_timeout_ms: 3_600_000,
} as const;
const VALIDATED_CONFIG = parseXiaoYiConfig(CONFIG);

defineChannelContract({
  type: "xiaoyi",

  assertConfig() {
    const adapter = testAdapter(createFakeXiaoYiClient());
    expect(adapter.validateConfig(CONFIG)).toMatchObject({
      ...CONFIG,
      filter_thinking: true,
      filter_tool_messages: true,
    });
    expect(() =>
      adapter.validateConfig({ ...CONFIG, ak: "" })
    ).toThrow("xiaoyi_ak_required");
    expect(() =>
      adapter.validateConfig({ ...CONFIG, sk: "" })
    ).toThrow("xiaoyi_sk_required");
    expect(() =>
      adapter.validateConfig({ ...CONFIG, agent_id: "" })
    ).toThrow("xiaoyi_agent_id_required");
    expect(() =>
      adapter.validateConfig({
        ...CONFIG,
        bot_prefix: "前".repeat(4_000),
      })
    ).toThrow("xiaoyi_bot_prefix_too_long");
    expect(adapter.manifest.prerequisites).toContain(
      "华为小艺智能体 A2A 接入资格",
    );
    expect(JSON.stringify(adapter.manifest))
      .not.toContain(CONFIG.sk);
  },

  async assertLifecycle() {
    const client = createFakeXiaoYiClient();
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
    const adapter = testAdapter(createFakeXiaoYiClient());
    const text = await adapter.normalizeInbound({
      serverName: "primary",
      payload: await fixture("message-text.json"),
    }, CONTEXT);
    const media = await adapter.normalizeInbound({
      serverName: "backup",
      payload: await fixture("message-media.json"),
    }, CONTEXT);

    expect(text).toMatchObject({
      externalEventId:
        "xiaoyi:task:task-9901:message-1",
      externalConversationId: "session-alice",
      externalSenderId: "session-alice",
      chatType: "direct",
      mentioned: true,
      text: "你好，DigitalMate",
      attachments: [],
      replyHandle: {
        publicFields: {
          sessionId: "session-alice",
          serverName: "primary",
        },
        secretFields: {
          taskId: "task-9901",
          messageId: "message-1",
        },
        expiresAt: new Date(
          NOW.getTime() + CONFIG.task_timeout_ms,
        ),
      },
    });
    expect(media).toMatchObject({
      externalEventId:
        "xiaoyi:task:task-9902:message-2",
      externalConversationId: "session-bob",
      text: "看看这张图",
      attachments: [{
        externalAttachmentId: "message-2:0",
        fileName: "xiaoyi-image.png",
        mimeType: "image/png",
        sizeBytes: 1024,
        source: {
          uri: expect.stringContaining(
            "myhuaweicloud.com",
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
    });
    expect(JSON.stringify(media?.rawSummary))
      .not.toContain("myhuaweicloud.com");
  },

  async assertStableIds() {
    const adapter = testAdapter(createFakeXiaoYiClient());
    const payload = {
      serverName: "primary",
      payload: await fixture("message-text.json"),
    };
    await expect(
      assertStableExternalEventId(() =>
        adapter.normalizeInbound(payload, CONTEXT)
      ),
    ).resolves.toBe(
      "xiaoyi:task:task-9901:message-1",
    );
    const backup = await adapter.normalizeInbound({
      ...payload,
      serverName: "backup",
    }, CONTEXT);
    expect(backup?.externalEventId).toBe(
      "xiaoyi:task:task-9901:message-1",
    );
  },

  async assertOutbound() {
    const client = createFakeXiaoYiClient();
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter));
    const delivery = outboundDelivery();
    const first = await adapter.streaming!(delivery, {
      sequence: 1,
      final: false,
      previousResult: null,
    });
    const middleBody =
      `第一段${"😀".repeat(4_000)}`;
    const middle = await adapter.streaming!(
      { ...delivery, body: middleBody },
      {
        sequence: 2,
        final: false,
        previousResult: first,
      },
    );
    const finalBody = `${middleBody}😀`;
    const lastText = await adapter.streaming!(
      { ...delivery, body: finalBody },
      {
        sequence: 3,
        final: false,
        previousResult: middle,
      },
    );
    const final = await adapter.streaming!(
      { ...delivery, body: finalBody },
      {
        sequence: 4,
        final: true,
        previousResult: lastText,
      },
    );

    expect(first.externalMessageId)
      .toBe(final.externalMessageId);
    expect(middle.externalMessageId)
      .toBe(final.externalMessageId);
    expect(client.sent.every(
      (item) => item.preferredServer === "backup",
    )).toBe(true);
    const details = client.sent.map((item) =>
      JSON.parse(
        String(item.payload.msgDetail),
      ) as Record<string, unknown>
    );
    const results = details.map((detail) =>
      detail.result as Record<string, unknown>
    );
    expect(details.every(
      (detail) => detail.id === "message-1",
    )).toBe(true);
    const artifactUpdates = results.filter(
      (result) => result.kind === "artifact-update",
    );
    expect(artifactUpdates).toHaveLength(4);
    expect(results.some((result) =>
      result.kind === "status-update"
      && (
        result.status as Record<string, unknown>
      ).state === "completed"
    )).toBe(true);
    expect(artifactUpdates.at(-1)).toMatchObject({
      final: true,
    });
    for (const result of artifactUpdates) {
      const artifact = result.artifact as {
        parts: Array<{ text: string }>;
      };
      expect(Array.from(artifact.parts[0]!.text).length)
        .toBeLessThanOrEqual(4_000);
    }
    expect((
      artifactUpdates.at(-1)!.artifact as {
        parts: Array<{ text: string }>;
      }
    ).parts[0]?.text).toBe("");

    expect(await adapter.resolveRecipient(
      delivery.recipient,
    )).toEqual({
      address: {
        sessionId: "session-alice",
        conversationId: "session-alice",
      },
    });
    await adapter.stop("shutdown");
  },

  async assertHealth() {
    const client = createFakeXiaoYiClient({
      startError: mapXiaoYiError({ statusCode: 403 }),
    });
    const adapter = testAdapter(client);
    const failure = await adapter
      .start(runtimeContext(adapter))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ChannelConnectionError);
    expect(failure).toMatchObject({
      code: "runtime_prerequisite_missing",
      detail: "xiaoyi_agent_eligibility_required",
    });
    expect(await adapter.health()).toMatchObject({
      status: "degraded",
      error: {
        code: "runtime_prerequisite_missing",
      },
    });

    const credentials = testAdapter(
      createFakeXiaoYiClient({
        startError: mapXiaoYiError({ statusCode: 401 }),
      }),
    );
    await expect(
      credentials.start(runtimeContext(credentials)),
    ).rejects.toMatchObject({
      code: "credential_invalid",
      detail: "xiaoyi_credentials_invalid",
    });

    const dual = createFakeXiaoYiClient();
    const connected = testAdapter(dual);
    await connected.start(runtimeContext(connected));
    dual.emitServerState("primary", false);
    expect(await connected.health()).toMatchObject({
      status: "healthy",
    });
    dual.emitServerState("backup", false);
    expect(await connected.health()).toMatchObject({
      status: "disconnected",
      error: { code: "network_unreachable" },
    });
  },

  async assertShutdown() {
    const client = createFakeXiaoYiClient();
    const adapter = testAdapter(client);
    const controller = new AbortController();
    await adapter.start(runtimeContext(adapter, controller.signal));
    controller.abort();
    await vi.waitFor(() => {
      expect(client.stops).toBe(1);
    });
    expect(await adapter.health()).toMatchObject({
      status: "stopped",
    });
  },
});

describe("XiaoYi protocol", () => {
  it("uses the v2.0.0.post3 AK/SK header contract", () => {
    expect(
      generateXiaoYiSignature(
        "xiaoyi-secret-key",
        "1785024000000",
      ),
    ).toBe("rBiSv+0iYT8NxcMGavPxZTwQTwGf6XejK68CexsG2CI=");
    expect(generateXiaoYiAuthHeaders(
      CONFIG.ak,
      CONFIG.sk,
      CONFIG.agent_id,
      1_785_024_000_000,
    )).toEqual({
      "x-access-key": CONFIG.ak,
      "x-sign":
        "rBiSv+0iYT8NxcMGavPxZTwQTwGf6XejK68CexsG2CI=",
      "x-ts": "1785024000000",
      "x-agent-id": CONFIG.agent_id,
    });
  });

  it("splits by Unicode code points and builds stable artifacts", () => {
    const chunks = splitXiaoYiText(
      `${"😀".repeat(4_000)}尾`,
    );
    expect(chunks).toHaveLength(2);
    expect(Array.from(chunks[0]!).length).toBe(4_000);
    expect(chunks[1]).toBe("尾");

    const first = buildXiaoYiArtifactFrame({
      agentId: CONFIG.agent_id,
      sessionId: "session-alice",
      taskId: "task-9901",
      messageId: "message-1",
      artifactId: "artifact-stable-1",
      text: "你好",
      final: false,
    });
    const second = buildXiaoYiArtifactFrame({
      agentId: CONFIG.agent_id,
      sessionId: "session-alice",
      taskId: "task-9901",
      messageId: "message-1",
      artifactId: "artifact-stable-1",
      text: "你好",
      final: false,
    });
    expect(second).toEqual(first);
  });

  it("handles clear and cancel control frames without an Agent turn", () => {
    const control = xiaoYiControlRequest({
      method: "tasks/cancel",
      id: "cancel-1",
      sessionId: "session-alice",
      taskId: "task-9901",
    });
    expect(control).toEqual({
      method: "tasks/cancel",
      requestId: "cancel-1",
      sessionId: "session-alice",
      taskId: "task-9901",
    });
    const response = buildXiaoYiControlResponse({
      agentId: CONFIG.agent_id,
      ...control!,
    });
    expect(response).toMatchObject({
      taskId: "cancel-1",
    });
    expect(JSON.parse(
      String(response.msgDetail),
    )).toMatchObject({
      id: "cancel-1",
      result: {
        id: "cancel-1",
        status: { state: "canceled" },
      },
    });

    const actionControl = xiaoYiControlRequest({
      action: "clear",
      id: "clear-1",
      sessionId: "session-alice",
    });
    expect(actionControl).toEqual({
      method: "clearContext",
      requestId: "clear-1",
      sessionId: "session-alice",
      taskId: "clear-1",
    });
    expect(buildXiaoYiControlResponse({
      agentId: CONFIG.agent_id,
      ...actionControl!,
    })).toMatchObject({
      taskId: "clear-1",
    });
  });

  it("drops non-whitelisted or non-Huawei media locators", async () => {
    const payload = await fixture("message-media.json");
    const parts = (
      (
        payload.params as Record<string, unknown>
      ).message as { parts: Array<Record<string, unknown>> }
    ).parts;
    const file = parts[1]!.file as Record<string, unknown>;
    file.name = "payload.svg";
    file.mimeType = "image/svg+xml";
    const event = normalizeXiaoYiInbound({
      serverName: "primary",
      payload,
    }, CONTEXT, VALIDATED_CONFIG);
    expect(event?.attachments).toEqual([]);

    file.name = "image.png";
    file.mimeType = "image/png";
    file.uri = "https://attacker.example/image.png";
    const external = normalizeXiaoYiInbound({
      serverName: "primary",
      payload,
    }, CONTEXT, VALIDATED_CONFIG);
    expect(external?.attachments).toEqual([]);
  });

  it("atomically rejects more than four files or over 20 MiB", async () => {
    const source = await fixture("message-media.json");
    const message = (
      source.params as Record<string, unknown>
    ).message as { parts: Array<Record<string, unknown>> };
    const textPart = structuredClone(message.parts[0]!);
    const filePart = structuredClone(message.parts[1]!);

    message.parts = [
      textPart,
      ...Array.from({ length: ATTACHMENT_LIMITS.maxCount + 1 }, (
        _value,
        index,
      ) => {
        const part = structuredClone(filePart);
        const file = part.file as Record<string, unknown>;
        file.name = `image-${index}.png`;
        file.uri =
          `https://fixture-${index}.obs.cn-north-4.myhuaweicloud.com/image.png`;
        return part;
      }),
    ];
    expect(normalizeXiaoYiInbound({
      serverName: "primary",
      payload: source,
    }, CONTEXT, VALIDATED_CONFIG)).toBeNull();

    message.parts = [
      textPart,
      ...Array.from({ length: 3 }, (_value, index) => {
        const part = structuredClone(filePart);
        const file = part.file as Record<string, unknown>;
        file.name = `large-${index}.png`;
        file.uri =
          `https://large-${index}.obs.cn-north-4.myhuaweicloud.com/image.png`;
        file.sizeBytes = 8 * 1024 * 1024;
        return part;
      }),
    ];
    expect(normalizeXiaoYiInbound({
      serverName: "primary",
      payload: source,
    }, CONTEXT, VALIDATED_CONFIG)).toBeNull();
  });
});

describe("XiaoYi attachment transport", () => {
  it("reuses bytes for one download and releases them afterwards", async () => {
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47,
      0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const fetchImpl = vi.fn(async () => new Response(bytes, {
      status: 200,
      headers: {
        "content-type": "image/png",
        "content-length": String(bytes.byteLength),
      },
    }));
    const fetcher = createXiaoYiAttachmentFetcher(
      fetchImpl as typeof fetch,
    );
    const descriptor = {
      externalAttachmentId: "message-2:0",
      fileName: "xiaoyi-image.png",
      mimeType: "image/png",
      sizeBytes: bytes.byteLength,
      source: {
        uri: "https://digitalmate-fixture.obs.cn-north-4.myhuaweicloud.com/xiaoyi/image.png",
      },
    };

    await expect(fetcher.inspect(descriptor))
      .resolves.toEqual({
        fileName: "xiaoyi-image.png",
        mimeType: "image/png",
        sizeBytes: bytes.byteLength,
      });
    const chunks: Uint8Array[] = [];
    for await (
      const chunk of await fetcher.download(descriptor)
    ) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([bytes]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await fetcher.inspect(descriptor);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("myhuaweicloud.com"),
      expect.objectContaining({
        redirect: "error",
        headers: expect.not.objectContaining({
          authorization: expect.anything(),
        }),
      }),
    );
  });

  it("rejects an actual aggregate over 20 MiB before download", async () => {
    const release = vi.fn();
    const fetcher = {
      inspect: vi.fn(async () => ({
        fileName: "large.png",
        mimeType: "image/png",
        sizeBytes: 8 * 1024 * 1024,
      })),
      download: vi.fn(),
      release,
    };
    const descriptors = Array.from({ length: 3 }, (
      _value,
      index,
    ) => ({
      externalAttachmentId: `message-2:${index}`,
      fileName: `large-${index}.png`,
      mimeType: "image/png",
      sizeBytes: null,
      source: {
        uri:
          `https://large-${index}.obs.cn-north-4.myhuaweicloud.com/image.png`,
      },
    }));

    await expect(inspectXiaoYiAttachmentBatch(
      fetcher,
      descriptors,
    )).rejects.toThrow("attachment_message_too_large");
    expect(fetcher.download).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(3);
  });
});

describe("XiaoYi control lifecycle", () => {
  it("persists control events before sending one response", async () => {
    const client = createFakeXiaoYiClient();
    const acceptControl = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const acceptInbound = vi.fn(async () => ({
      kind: "ignored" as const,
    }));
    const adapter = createXiaoYiAdapter({
      clientFactory: () => client,
      scope: { userId: "user-1", agentId: "agent-1" },
      acceptControl,
      acceptInbound,
      now: () => NOW,
    });
    const config = adapter.validateConfig(CONFIG);
    await adapter.start({
      connectionId: CONTEXT.connectionId,
      agentId: CONTEXT.agentId,
      config,
      signal: new AbortController().signal,
      now: () => NOW,
    });
    const frame = {
      agentId: CONFIG.agent_id,
      method: "tasks/cancel",
      id: "cancel-1",
      sessionId: "session-alice",
      taskId: "task-9901",
    };
    await client.emitMessage(frame, "primary");
    await client.emitMessage(frame, "backup");

    expect(acceptControl).toHaveBeenCalledTimes(2);
    expect(acceptControl.mock.calls[0]?.[0]).toMatchObject({
      externalEventId:
        "xiaoyi:control:tasks/cancel:cancel-1",
    });
    expect(acceptInbound).not.toHaveBeenCalled();
    expect(client.sent).toHaveLength(1);
    expect(JSON.parse(
      String(client.sent[0]?.payload.msgDetail),
    )).toMatchObject({
      result: {
        status: { state: "canceled" },
      },
    });
    await adapter.stop("shutdown");
  });
});

describe("XiaoYi dual WebSocket transport", () => {
  it("settles start when stopped while both sockets are connecting", async () => {
    const sockets: FakeSocket[] = [];
    const client = createXiaoYiWebSocketClient(
      VALIDATED_CONFIG,
      {
        socketFactory(url, options) {
          const socket = new FakeSocket(url, options);
          sockets.push(socket);
          return socket;
        },
      },
    );
    let settled = false;
    const started = client.start(clientStartInput()).then(() => {
      settled = true;
    });

    await client.stop();
    await Promise.resolve();

    expect(settled).toBe(true);
    expect(sockets.every((socket) => socket.closed)).toBe(true);
    await started;
  });

  it("connects both endpoints, sends init/heartbeat, and reconnects independently", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const client = createXiaoYiWebSocketClient(
        VALIDATED_CONFIG,
        {
          now: () => NOW.getTime(),
          hostname: () => "digitalmate-worker",
          socketFactory(url, options) {
            const socket = new FakeSocket(url, options);
            sockets.push(socket);
            return socket;
          },
        },
      );
      const input = clientStartInput();
      const started = client.start(input);
      expect(sockets.map((socket) => socket.url)).toEqual([
        XIAOYI_ENDPOINTS.primary,
        XIAOYI_ENDPOINTS.backup,
      ]);
      expect(sockets[1]?.options.servername)
        .toBe("hag.cloud.huawei.com");
      expect(sockets[0]?.options.headers)
        .not.toHaveProperty("authorization");

      sockets[0]!.open();
      sockets[1]!.open();
      await started;
      expect(input.onServerState).toHaveBeenCalledWith(
        "primary",
        true,
      );
      expect(input.onServerState).toHaveBeenCalledWith(
        "backup",
        true,
      );
      expect(sockets.every((socket) =>
        parsedFrames(socket).some(
          (frame) => frame.msgType === "clawd_bot_init",
        )
      )).toBe(true);

      await vi.advanceTimersByTimeAsync(
        XIAOYI_HEARTBEAT_INTERVAL_MS,
      );
      expect(sockets.every((socket) =>
        parsedFrames(socket).some(
          (frame) => frame.msgType === "heartbeat",
        )
      )).toBe(true);

      sockets[0]!.remoteClose();
      await vi.advanceTimersByTimeAsync(
        XIAOYI_RECONNECT_DELAYS_MS[0],
      );
      expect(sockets).toHaveLength(3);
      expect(sockets[2]?.url).toBe(
        XIAOYI_ENDPOINTS.primary,
      );
      expect(input.onReconnect).toHaveBeenCalledWith(
        "primary",
        1,
        XIAOYI_RECONNECT_DELAYS_MS[0],
      );
      sockets[2]!.open();

      await client.stop();
      expect(sockets.every((socket) => socket.closed))
        .toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the exact reconnect and eligibility policy", () => {
    expect(XIAOYI_RECONNECT_DELAYS_MS).toEqual([
      1_000,
      2_000,
      5_000,
      10_000,
      30_000,
      60_000,
    ]);
    expect(XIAOYI_MAX_RECONNECT_ATTEMPTS).toBe(50);
    expect(mapXiaoYiError({ statusCode: 401 }))
      .toMatchObject({
        code: "credential_invalid",
        retryable: false,
      });
    expect(mapXiaoYiError({ statusCode: 403 }))
      .toMatchObject({
        code: "runtime_prerequisite_missing",
        detail: "xiaoyi_agent_eligibility_required",
        retryable: false,
      });
  });

  it("stops a failed link after 50 reconnect attempts", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const input = clientStartInput();
      const client = createXiaoYiWebSocketClient(
        VALIDATED_CONFIG,
        {
          now: () => NOW.getTime(),
          socketFactory(url, options) {
            const socket = new FakeSocket(url, options);
            sockets.push(socket);
            return socket;
          },
        },
      );
      const started = client.start(input);
      sockets[0]!.fail();
      sockets[1]!.open();
      await started;

      for (
        let attempt = 0;
        attempt < XIAOYI_MAX_RECONNECT_ATTEMPTS;
        attempt += 1
      ) {
        await vi.advanceTimersByTimeAsync(
          XIAOYI_RECONNECT_DELAYS_MS[
            Math.min(
              attempt,
              XIAOYI_RECONNECT_DELAYS_MS.length - 1,
            )
          ]!,
        );
        sockets.at(-1)!.fail();
      }
      await vi.advanceTimersByTimeAsync(60_000);

      expect(
        sockets.filter((socket) =>
          socket.url === XIAOYI_ENDPOINTS.primary
        ),
      ).toHaveLength(
        XIAOYI_MAX_RECONNECT_ATTEMPTS + 1,
      );
      expect(input.onReconnect).toHaveBeenLastCalledWith(
        "primary",
        XIAOYI_MAX_RECONNECT_ATTEMPTS,
        60_000,
      );
      await client.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("XiaoYi delivery idempotency", () => {
  it("does not repeat visible text when the final frame is retried", async () => {
    const client = createFakeXiaoYiClient({
      failSendCalls: new Set([4]),
    });
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter));
    const delivery = outboundDelivery();
    const first = await adapter.streaming!(delivery, {
      sequence: 1,
      final: false,
      previousResult: null,
    });
    const finalDelivery = { ...delivery, body: "第一段尾" };
    const lastText = await adapter.streaming!(finalDelivery, {
      sequence: 2,
      final: false,
      previousResult: first,
    });

    await expect(adapter.streaming!(finalDelivery, {
      sequence: 3,
      final: true,
      previousResult: lastText,
    })).rejects.toThrow("socket closed");
    await adapter.streaming!(finalDelivery, {
      sequence: 3,
      final: true,
      previousResult: lastText,
    });

    const visibleTexts = client.sent
      .map((item) => JSON.parse(
        String(item.payload.msgDetail),
      ) as Record<string, unknown>)
      .map((detail) =>
        detail.result as Record<string, unknown>
      )
      .filter((result) =>
        result.kind === "artifact-update"
      )
      .map((result) => (
        result.artifact as {
          parts: Array<{ text: string }>;
        }
      ).parts[0]!.text)
      .filter(Boolean);
    expect(visibleTexts).toEqual(["第一段", "尾"]);
    await adapter.stop("shutdown");
  });

  it("preserves whitespace at a 4,000-code-point worker boundary", async () => {
    const client = createFakeXiaoYiClient();
    const adapter = testAdapter(client);
    await adapter.start(runtimeContext(adapter));
    const body =
      `${"a".repeat(3_999)} ${"b".repeat(4_000)}`;
    const baseDelivery = outboundDelivery();
    const claim = {
      id: baseDelivery.id,
      scope: {
        userId: CONTEXT.userId,
        agentId: CONTEXT.agentId,
      },
      eventId: baseDelivery.eventId,
      sourceTaskId: null,
      connectionId: baseDelivery.connectionId,
      assistantMessageId: baseDelivery.assistantMessageId,
      replyHandleId: null,
      body,
      recipient: baseDelivery.recipient,
      status: "running",
      claimOwner: "xiaoyi-worker",
      claimExpiresAt: new Date(NOW.getTime() + 30_000),
      attempts: 1,
      attemptCycleBaseline: 0,
      nextAttemptAt: NOW,
      lastErrorCode: null,
      sentAt: null,
    } satisfies ClaimedChannelDelivery;
    let markedSent = false;
    let scheduledRetry = false;
    const worker = createChannelDeliveryWorker({
      owner: "xiaoyi-worker",
      deliveries: {
        leaseDurationMs: 30_000,
        claimNext: vi.fn()
          .mockResolvedValueOnce(claim)
          .mockResolvedValue(null),
        renew: vi.fn(async () =>
          new Date(NOW.getTime() + 30_000)
        ),
        freezeSegments: vi.fn(async (
          _claim,
          segments,
        ) => [...segments]),
        beginSegment: vi.fn(async () => ({
          action: "send" as const,
          previousResult: null,
        })),
        completeSegment: vi.fn(async () => true),
        markSent: vi.fn(async () => {
          markedSent = true;
          return true;
        }),
        scheduleRetry: vi.fn(async () => {
          scheduledRetry = true;
          return true;
        }),
        deadLetter: vi.fn(async () => true),
      },
      transport: {
        mode: vi.fn(async () => "task-streaming" as const),
        taskSegmentCodePointLimit: vi.fn(async () => 4_000),
        send: async (part, signal) =>
          adapter.streaming!(
            {
              ...baseDelivery,
              body: part.body,
            },
            {
              ...part.state,
              previousResult: part.previousResult,
              signal,
            },
          ),
      },
      loadCadence: vi.fn(async () => ({
        responseDelayMs: 0,
        segmentDelayMs: 0,
        maxSegments: 5,
      })),
      now: () => NOW,
    });

    await worker.runOne();

    const visibleText = client.sent
      .map((item) => JSON.parse(
        String(item.payload.msgDetail),
      ) as Record<string, unknown>)
      .map((detail) =>
        detail.result as Record<string, unknown>
      )
      .filter((result) =>
        result.kind === "artifact-update"
      )
      .map((result) => (
        result.artifact as {
          parts: Array<{ text: string }>;
        }
      ).parts[0]!.text)
      .join("");
    expect(markedSent).toBe(true);
    expect(scheduledRetry).toBe(false);
    expect(visibleText).toBe(body);
    await adapter.stop("shutdown");
  });
});

describe("XiaoYi connection manager boundary", () => {
  it("blocks an ineligible agent without scheduling a retry", async () => {
    vi.useFakeTimers();
    try {
      const client = createFakeXiaoYiClient({
        startError: mapXiaoYiError({ statusCode: 403 }),
      });
      const adapter = testAdapter(client);
      const connection = {
        id: CONTEXT.connectionId,
        scope: {
          userId: CONTEXT.userId,
          agentId: CONTEXT.agentId,
        },
        channelType: "xiaoyi" as const,
        enabled: true,
        revision: 1,
        config: CONFIG,
      };
      const healthUpdates: RuntimeChannelHealthUpdate[] = [];
      const manager = createChannelConnectionManager({
        store: {
          listEnabled: vi.fn(async () => [connection]),
          get: vi.fn(async () => connection),
          updateHealth: vi.fn(async (_connection, health) => {
            healthUpdates.push(health);
          }),
          subscribe: vi.fn(async () =>
            vi.fn(async () => undefined)
          ),
        },
        createAdapter: () => adapter,
        now: () => NOW,
        random: () => 0.5,
      });

      await manager.startAll();
      expect(healthUpdates.at(-1)).toMatchObject({
        status: "blocked",
        detail: {
          code: "runtime_prerequisite_missing",
        },
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(client.starts).toBe(1);
      await manager.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("XiaoYi registry", () => {
  it("registers the adapter without enabling proactive dispatch", () => {
    const registry = new ChannelAdapterRegistry();
    registerXiaoYiChannelAdapter(registry);
    expect(registry.registeredTypes()).toEqual(["xiaoyi"]);
    expect(
      registry.create("xiaoyi", { now: () => NOW }).manifest.type,
    ).toBe("xiaoyi");
  });
});

function testAdapter(
  client: FakeXiaoYiClient,
) {
  const adapter = createXiaoYiAdapter({
    clientFactory: () => client,
    autoListen: false,
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

function outboundDelivery() {
  return {
    id: "delivery-xiaoyi-1",
    eventId: "event-xiaoyi-1",
    connectionId: CONTEXT.connectionId,
    assistantMessageId: "assistant-xiaoyi-1",
    body: "第一段",
    recipient: {
      externalConversationId: "session-alice",
      externalUserId: "session-alice",
      chatType: "direct" as const,
    },
    replyHandle: {
      publicFields: {
        sessionId: "session-alice",
        serverName: "backup",
      },
      secretFields: {
        taskId: "task-9901",
        messageId: "message-1",
      },
      expiresAt: new Date(
        NOW.getTime() + CONFIG.task_timeout_ms,
      ),
    },
  };
}

type FakeXiaoYiClient = XiaoYiClientPort & {
  starts: number;
  stops: number;
  sent: Array<{
    preferredServer: XiaoYiServerName;
    payload: Record<string, unknown>;
  }>;
  emitServerState(
    serverName: XiaoYiServerName,
    connected: boolean,
  ): void;
  emitMessage(
    payload: unknown,
    serverName: XiaoYiServerName,
  ): Promise<void>;
};

function createFakeXiaoYiClient(
  options: Readonly<{
    startError?: Error;
    failSendCalls?: ReadonlySet<number>;
  }> = {},
): FakeXiaoYiClient {
  let callbacks: XiaoYiClientStartInput | null = null;
  const connected = new Set<XiaoYiServerName>();
  let sendCalls = 0;
  return {
    starts: 0,
    stops: 0,
    sent: [],
    async start(input) {
      this.starts += 1;
      callbacks = input;
      if (options.startError) throw options.startError;
      connected.add("primary");
      connected.add("backup");
      input.onServerState("primary", true);
      input.onServerState("backup", true);
    },
    async stop() {
      if (this.stops > 0) return;
      this.stops += 1;
      connected.clear();
    },
    async send(input) {
      sendCalls += 1;
      if (connected.size === 0) {
        throw mapXiaoYiError(new Error("socket closed"));
      }
      if (options.failSendCalls?.has(sendCalls)) {
        throw new Error("socket closed");
      }
      const serverName = connected.has(input.preferredServer)
        ? input.preferredServer
        : Array.from(connected)[0]!;
      this.sent.push({
        preferredServer: input.preferredServer,
        payload: input.payload,
      });
      return { serverName };
    },
    emitServerState(serverName, isConnected) {
      if (isConnected) connected.add(serverName);
      else connected.delete(serverName);
      callbacks?.onServerState(serverName, isConnected);
    },
    async emitMessage(payload, serverName) {
      if (!callbacks) {
        throw new Error("xiaoyi_listener_missing");
      }
      await callbacks.onMessage(payload, serverName);
    },
  };
}

function clientStartInput(): XiaoYiClientStartInput {
  return {
    signal: new AbortController().signal,
    config: VALIDATED_CONFIG,
    onMessage: vi.fn(async () => undefined),
    onServerState: vi.fn(),
    onReconnect: vi.fn(),
    onError: vi.fn(),
  };
}

class FakeSocket extends EventEmitter implements XiaoYiSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  closed = false;

  constructor(
    readonly url: string,
    readonly options: Readonly<{
      headers: Readonly<Record<string, string>>;
      handshakeTimeout: number;
      servername?: string;
    }>,
  ) {
    super();
  }

  send(
    data: string,
    callback?: (error?: Error) => void,
  ): void {
    if (this.readyState !== 1) {
      throw new Error("socket_not_open");
    }
    this.sent.push(data);
    callback?.();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit("close", 1_000, Buffer.alloc(0));
  }

  terminate(): void {
    this.close();
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  remoteClose(): void {
    this.closed = true;
    this.readyState = 3;
    this.emit("close", 1_006, Buffer.alloc(0));
  }

  fail(): void {
    this.emit("error", new Error("socket closed"));
  }
}

function parsedFrames(
  socket: FakeSocket,
): Array<Record<string, unknown>> {
  return socket.sent.map(
    (item) => JSON.parse(item) as Record<string, unknown>,
  );
}

async function fixture<T = Record<string, unknown>>(
  name: string,
): Promise<T> {
  return JSON.parse(
    await readFile(
      path.join(
        process.cwd(),
        "tests/fixtures/channels/xiaoyi",
        name,
      ),
      "utf8",
    ),
  ) as T;
}
