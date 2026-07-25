import { readFile } from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";
import type {
  ClientSubscribeCallback,
  DoneCallback,
  IClientPublishOptions,
  IPublishPacket,
  MqttClient,
  Packet,
  PacketCallback,
} from "mqtt";

import {
  createMqttAdapter,
} from "@/server/channels/adapters/mqtt";
import {
  createMqttClient,
  mapMqttError,
  mqttClientOptions,
  type MqttClientPort,
} from "@/server/channels/adapters/mqtt/transport";
import {
  assertStableExternalEventId,
  defineChannelContract,
} from "@/server/channels/testing/contract";
import {
  ChannelAdapterRegistry,
  registerMqttChannelAdapter,
} from "@/server/channels/runtime/registry";

const NOW = new Date("2026-07-26T00:00:00.000Z");
const CONTEXT = {
  connectionId: "connection-mqtt",
  userId: "user-1",
  agentId: "agent-1",
  receivedAt: NOW,
};
const CONFIG = {
  enabled: true,
  host: "mqtt.example.com",
  port: 1_883,
  transport: "tcp",
  clean_session: false,
  qos: 2,
  username: "device-user",
  password: "mqtt-secret",
  subscribe_topic: "devices/+/in",
  publish_topic: "devices/{client_id}/out",
  tls_enabled: false,
} as const;

defineChannelContract({
  type: "mqtt",

  assertConfig() {
    const adapter = createMqttAdapter({
      clientFactory: () => createFakeMqttClient(),
      autoListen: false,
    });
    expect(adapter.validateConfig(CONFIG)).toMatchObject(CONFIG);
    expect(() =>
      adapter.validateConfig({ ...CONFIG, host: "" })
    ).toThrow("mqtt_host_required");
    expect(() =>
      adapter.validateConfig({ ...CONFIG, qos: 3 })
    ).toThrow();
    expect(() =>
      adapter.validateConfig({
        ...CONFIG,
        publish_topic: "devices/+/out",
      })
    ).toThrow("mqtt_publish_topic_invalid");
  },

  async assertLifecycle() {
    const client = createFakeMqttClient();
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
      .not.toContain(CONFIG.password);
  },

  async assertInbound() {
    const adapter = testAdapter(createFakeMqttClient());
    const json = await adapter.normalizeInbound(
      await fixture("message-json.json"),
      CONTEXT,
    );
    const plain = await adapter.normalizeInbound(
      await fixture("message-plain.json"),
      CONTEXT,
    );

    expect(json).toMatchObject({
      externalEventId:
        "mqtt:devices/device-7/in:event-9001",
      externalConversationId: "device-7",
      externalSenderId: "device-7",
      chatType: "direct",
      mentioned: true,
      text: "设备温度 23°C",
      thread: {},
      attachments: [],
      replyHandle: {
        publicFields: { clientId: "device-7" },
        secretFields: {},
      },
    });
    expect(plain).toMatchObject({
      externalConversationId: "device-8",
      externalSenderId: "device-8",
      chatType: "direct",
      text: "设备状态正常",
      rawSummary: {
        eventIdSource: "qos0_hash",
        qos: 0,
      },
    });
  },

  async assertStableIds() {
    const adapter = testAdapter(createFakeMqttClient());
    const payload = await fixture("message-json.json");
    const payloadRecord = JSON.parse(
      String(payload.payload),
    ) as Record<string, unknown>;
    delete payloadRecord.event_id;
    const packetFallback = {
      ...payload,
      payload: JSON.stringify(payloadRecord),
    };

    await expect(
      assertStableExternalEventId(() =>
        adapter.normalizeInbound(packetFallback, CONTEXT)
      ),
    ).resolves.toBe(
      "mqtt:devices/device-7/in:packet-41",
    );
    const qos0 = await fixture("message-plain.json");
    const first = await adapter.normalizeInbound(qos0, CONTEXT);
    const second = await adapter.normalizeInbound(qos0, CONTEXT);
    const nextBucket = await adapter.normalizeInbound(qos0, {
      ...CONTEXT,
      receivedAt: new Date(
        CONTEXT.receivedAt.getTime() + 30_000,
      ),
    });
    expect(first?.externalEventId).toBe(second?.externalEventId);
    expect(nextBucket?.externalEventId)
      .not.toBe(first?.externalEventId);
  },

  async assertOutbound() {
    const client = createFakeMqttClient();
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

    expect(result.externalMessageId).toBe("mqtt-publish:501");
    expect(recipient.address).toEqual({
      clientId: "device-7",
      conversationId: "device-7",
    });
    expect(client.published).toHaveLength(1);
    expect(client.published[0]).toMatchObject({
      topic: "devices/device-7/out",
      qos: 2,
      retain: false,
    });
    expect(JSON.parse(
      String(client.published[0]?.payload),
    )).toEqual({
      id: "delivery-mqtt-1",
      reply_to: "mqtt:devices/device-7/in:event-9001",
      text: "完整回复",
      created_at: NOW.toISOString(),
    });
    await adapter.stop("shutdown");
  },

  async assertHealth() {
    const client = createFakeMqttClient({
      startError: mapMqttError({ reasonCode: 4 }),
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
      .not.toContain(CONFIG.password);
  },

  async assertShutdown() {
    const client = createFakeMqttClient();
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
});

describe("MQTT transaction boundary", () => {
  it("registers the production adapter", () => {
    const registry = new ChannelAdapterRegistry();
    registerMqttChannelAdapter(registry);

    expect(registry.registeredTypes()).toEqual(["mqtt"]);
    expect(
      registry.create("mqtt", { now: () => NOW }).manifest.type,
    ).toBe("mqtt");
  });

  it("only advances the ingress callback after a received frame", async () => {
    const client = createFakeMqttClient();
    const acceptInbound = vi.fn(async () => ({
      kind: "accepted" as const,
      eventId: "event-1",
    }));
    const adapter = createMqttAdapter({
      clientFactory: () => client,
      scope: {
        userId: CONTEXT.userId,
        agentId: CONTEXT.agentId,
      },
      acceptInbound,
      now: () => NOW,
    });
    await adapter.start(runtimeContext(adapter));

    await client.emitMessage(await fixture("message-json.json"));

    expect(acceptInbound).toHaveBeenCalledTimes(1);
    expect(acceptInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "devices/device-7/in",
      }),
      expect.objectContaining({
        connectionId: CONTEXT.connectionId,
        receivedAt: NOW,
      }),
      {
        userId: CONTEXT.userId,
        agentId: CONTEXT.agentId,
      },
    );
    await adapter.stop("shutdown");
  });

  it("maps fixed CONNACK failures without reflecting broker text", async () => {
    const cases = await fixture("connack-errors.json") as Array<{
      reasonCode: number;
      expectedCode: string;
      retryable: boolean;
    }>;
    for (const entry of cases) {
      expect(mapMqttError({
        reasonCode: entry.reasonCode,
        message: `broker leaked ${CONFIG.password}`,
      })).toMatchObject({
        code: entry.expectedCode,
        retryable: entry.retryable,
        message: entry.expectedCode,
      });
    }
  });

  it("keeps TLS key material in memory and selects secure protocols", () => {
    const options = mqttClientOptions({
      ...CONFIG,
      transport: "tcp",
      tls_enabled: true,
      tls_ca_certs: "-----BEGIN CERTIFICATE-----\nCA",
      tls_certfile: "-----BEGIN CERTIFICATE-----\nCLIENT",
      tls_keyfile: "-----BEGIN PRIVATE KEY-----\nSECRET",
    }, CONTEXT.connectionId);

    expect(options).toMatchObject({
      protocol: "mqtts",
      host: CONFIG.host,
      port: CONFIG.port,
      clean: false,
      rejectUnauthorized: true,
    });
    expect(Buffer.isBuffer(options.ca)).toBe(true);
    expect(Buffer.isBuffer(options.cert)).toBe(true);
    expect(Buffer.isBuffer(options.key)).toBe(true);
    expect(String(options.key)).toContain("PRIVATE KEY");
    expect(options.clientId).toMatch(/^digitalmate-[a-f0-9]{24}$/);
  });

  it("waits for durable ingress and broker publish callbacks", async () => {
    const emitter = new EventEmitter();
    const nativeClient = emitter as unknown as MqttClient;
    let publishCallback: PacketCallback | undefined;
    Object.assign(emitter, {
      connected: true,
      handleMessage(
        _packet: IPublishPacket,
        callback: DoneCallback,
      ) {
        callback();
      },
      subscribe(
        _topic: string | string[],
        _options: unknown,
        callback?: ClientSubscribeCallback,
      ) {
        callback?.(null, [{
          topic: CONFIG.subscribe_topic,
          qos: CONFIG.qos,
        }]);
        return nativeClient;
      },
      publish(
        _topic: string,
        _payload: string | Buffer,
        _options: IClientPublishOptions,
        callback?: PacketCallback,
      ) {
        publishCallback = callback;
        return nativeClient;
      },
      async endAsync() {
        return undefined;
      },
    });
    let releaseIngress!: () => void;
    const ingressGate = new Promise<void>((resolve) => {
      releaseIngress = resolve;
    });
    const port = createMqttClient(
      createMqttAdapter({
        autoListen: false,
      }).validateConfig(CONFIG),
      CONTEXT.connectionId,
      () => nativeClient,
    );
    const started = port.start({
      signal: new AbortController().signal,
      onMessage: () => ingressGate,
      onError: vi.fn(),
    });
    emitter.emit("connect", {
      cmd: "connack",
      returnCode: 0,
      sessionPresent: false,
    });
    await started;

    let ingressAcknowledged = false;
    nativeClient.handleMessage({
      cmd: "publish",
      topic: "devices/device-7/in",
      payload: Buffer.from("hello", "utf8"),
      qos: 1,
      messageId: 41,
      dup: false,
      retain: false,
    }, () => {
      ingressAcknowledged = true;
    });
    await Promise.resolve();
    expect(ingressAcknowledged).toBe(false);
    releaseIngress();
    await vi.waitFor(() => {
      expect(ingressAcknowledged).toBe(true);
    });

    let publishSettled = false;
    const published = port.publish({
      topic: "devices/device-7/out",
      payload: "{}",
      qos: 2,
      retain: false,
    }).finally(() => {
      publishSettled = true;
    });
    await Promise.resolve();
    expect(publishSettled).toBe(false);
    publishCallback?.(
      undefined,
      {
        cmd: "puback",
        messageId: 501,
      } as Packet,
    );
    await expect(published).resolves.toEqual({
      messageId: 501,
    });
    await port.stop();
  });

  it("rejects invalid UTF-8, empty text and unsafe client ids", async () => {
    const adapter = testAdapter(createFakeMqttClient());
    await expect(adapter.normalizeInbound({
      topic: "devices/device-7/in",
      payload: Buffer.from([0xff, 0xfe]),
      packet: { qos: 1, messageId: 7 },
    }, CONTEXT)).resolves.toBeNull();
    await expect(adapter.normalizeInbound({
      topic: "devices/device-7/in",
      payload: "{\"text\":\"\"}",
      packet: { qos: 1, messageId: 8 },
    }, CONTEXT)).resolves.toBeNull();
    await expect(adapter.normalizeInbound({
      topic: "devices/device-7/in",
      payload: JSON.stringify({
        text: "hello",
        redirect_client_id: "bad/#",
        event_id: "event-1",
      }),
      packet: { qos: 1, messageId: 9 },
    }, CONTEXT)).resolves.toBeNull();
  });
});

function testAdapter(client: FakeMqttClient) {
  return createMqttAdapter({
    clientFactory: () => client,
    autoListen: false,
    now: () => NOW,
  });
}

function runtimeContext(
  adapter: ReturnType<typeof createMqttAdapter>,
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
    id: "delivery-mqtt-1",
    eventId: "mqtt:devices/device-7/in:event-9001",
    connectionId: CONTEXT.connectionId,
    assistantMessageId: "assistant-1",
    body: "完整回复",
    recipient: {
      externalConversationId: "device-7",
    },
    replyHandle: {
      publicFields: { clientId: "device-7" },
      secretFields: {},
      expiresAt: null,
    },
  };
}

type FakeMqttClient = MqttClientPort & {
  starts: number;
  stops: number;
  published: Array<{
    topic: string;
    payload: string;
    qos: 0 | 1 | 2;
    retain: false;
  }>;
  emitMessage(payload: unknown): Promise<void>;
  emitError(error: Error): void;
};

function createFakeMqttClient(options: Readonly<{
  startError?: Error;
}> = {}): FakeMqttClient {
  let onMessage: ((payload: unknown) => Promise<void>) | null = null;
  let onError: ((error: Error) => void) | null = null;
  return {
    starts: 0,
    stops: 0,
    published: [],
    async start(input) {
      this.starts += 1;
      onMessage = input.onMessage;
      onError = input.onError;
      if (options.startError) throw options.startError;
    },
    async stop() {
      this.stops += 1;
    },
    async publish(input) {
      this.published.push(input);
      return { messageId: 501 };
    },
    async emitMessage(payload) {
      if (!onMessage) throw new Error("mqtt_listener_missing");
      await onMessage(payload);
    },
    emitError(error) {
      onError?.(error);
    },
  };
}

async function fixture<T = Record<string, unknown>>(
  name: string,
): Promise<T> {
  return JSON.parse(
    await readFile(
      path.join(
        process.cwd(),
        "tests/fixtures/channels/mqtt",
        name,
      ),
      "utf8",
    ),
  ) as T;
}
