import { createHash } from "node:crypto";

import {
  connect,
  type IClientOptions,
  type MqttClient,
} from "mqtt";

import type {
  MqttConfig,
  MqttQos,
} from "./config";

export type MqttTransportErrorCode =
  | "credential_invalid"
  | "permission_denied"
  | "rate_limited"
  | "network_unreachable";

export class MqttTransportError extends Error {
  readonly code: MqttTransportErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(input: Readonly<{
    code: MqttTransportErrorCode;
    retryable: boolean;
    retryAfterMs?: number;
  }>) {
    super(input.code);
    this.name = "MqttTransportError";
    this.code = input.code;
    this.retryable = input.retryable;
    this.retryAfterMs = input.retryAfterMs;
  }
}

export type MqttInboundFrame = Readonly<{
  topic: string;
  payload: Buffer;
  packet: Readonly<{
    qos: MqttQos;
    messageId?: number;
    dup: boolean;
    retain: boolean;
  }>;
}>;

export type MqttClientPort = Readonly<{
  start(input: Readonly<{
    signal: AbortSignal;
    onMessage(payload: unknown): Promise<void>;
    onError(error: Error): void;
    onConnected?(): void;
  }>): Promise<void>;
  stop(): Promise<void>;
  publish(input: Readonly<{
    topic: string;
    payload: string;
    qos: MqttQos;
    retain: false;
  }>): Promise<Readonly<{ messageId: number | null }>>;
}>;

export type MqttClientFactory = (
  config: MqttConfig,
  connectionId: string,
) => MqttClientPort;

export type MqttConnector = (
  options: IClientOptions,
) => MqttClient;

export function mqttClientOptions(
  config: MqttConfig,
  connectionId: string,
): IClientOptions {
  const secure = config.tls_enabled
    || config.transport === "tls"
    || config.transport === "wss";
  const protocol = config.transport === "ws"
    ? secure ? "wss" : "ws"
    : config.transport === "wss"
      ? "wss"
      : secure
        ? "mqtts"
        : "mqtt";

  return {
    protocol,
    host: config.host,
    port: config.port,
    clientId: `digitalmate-${
      createHash("sha256")
        .update(connectionId)
        .digest("hex")
        .slice(0, 24)
    }`,
    clean: config.clean_session,
    protocolVersion: 4,
    connectTimeout: 30_000,
    reconnectPeriod: 1_000,
    reconnectOnConnackError: false,
    resubscribe: true,
    queueQoSZero: false,
    rejectUnauthorized: true,
    ...(config.username
      ? { username: config.username }
      : {}),
    ...(config.password
      ? { password: config.password }
      : {}),
    ...(config.tls_ca_certs
      ? { ca: Buffer.from(config.tls_ca_certs, "utf8") }
      : {}),
    ...(config.tls_certfile
      ? { cert: Buffer.from(config.tls_certfile, "utf8") }
      : {}),
    ...(config.tls_keyfile
      ? { key: Buffer.from(config.tls_keyfile, "utf8") }
      : {}),
  };
}

export function createMqttClient(
  config: MqttConfig,
  connectionId: string,
  connector: MqttConnector = connect,
): MqttClientPort {
  let client: MqttClient | null = null;
  let stopped = false;
  let ready = false;
  let detachAbort: (() => void) | null = null;

  return {
    async start(input) {
      input.signal.throwIfAborted();
      stopped = false;
      const activeClient = connector(
        mqttClientOptions(config, connectionId),
      );
      client = activeClient;
      const onAbort = () => {
        void stop();
      };
      input.signal.addEventListener("abort", onAbort, {
        once: true,
      });
      detachAbort = () =>
        input.signal.removeEventListener("abort", onAbort);

      activeClient.handleMessage = (packet, callback) => {
        const frame: MqttInboundFrame = {
          topic: String(packet.topic),
          payload: Buffer.isBuffer(packet.payload)
            ? packet.payload
            : Buffer.from(packet.payload),
          packet: {
            qos: packet.qos,
            ...(packet.messageId
              ? { messageId: packet.messageId }
              : {}),
            dup: packet.dup,
            retain: packet.retain,
          },
        };
        void input.onMessage(frame).then(
          () => callback(),
          (error: unknown) => {
            const mapped = mapMqttError(error);
            input.onError(mapped);
            callback(mapped);
          },
        );
      };
      activeClient.on("error", (error) => {
        if (ready && !stopped) {
          input.onError(mapMqttError(error));
        }
      });
      activeClient.on("close", () => {
        if (ready && !stopped) {
          input.onError(new MqttTransportError({
            code: "network_unreachable",
            retryable: true,
          }));
        }
      });
      activeClient.on("reconnect", () => {
        if (ready && !stopped) {
          input.onError(new MqttTransportError({
            code: "network_unreachable",
            retryable: true,
          }));
        }
      });

      try {
        await waitForInitialConnection(
          activeClient,
          config,
          input.signal,
        );
        ready = true;
        input.onConnected?.();
      } catch (error) {
        await stop();
        throw mapMqttError(error);
      }

      activeClient.on("connect", () => {
        if (ready && !stopped) input.onConnected?.();
      });
    },

    stop,

    async publish(input) {
      const activeClient = client;
      if (!activeClient || !activeClient.connected || stopped) {
        throw new MqttTransportError({
          code: "network_unreachable",
          retryable: true,
        });
      }
      return new Promise((resolve, reject) => {
        activeClient.publish(
          input.topic,
          input.payload,
          {
            qos: input.qos,
            retain: input.retain,
          },
          (error, packet) => {
            if (error) {
              reject(mapMqttError(error));
              return;
            }
            resolve({
              messageId: publishMessageId(packet),
            });
          },
        );
      });
    },
  };

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    ready = false;
    detachAbort?.();
    detachAbort = null;
    const activeClient = client;
    client = null;
    if (!activeClient) return;
    activeClient.removeAllListeners();
    await activeClient.endAsync(true).catch(() => undefined);
  }
}

export function mapMqttError(
  error: unknown,
): MqttTransportError {
  if (error instanceof MqttTransportError) return error;
  const record = asRecord(error);
  const reasonCode = numericReasonCode(record);
  if (reasonCode === 4 || reasonCode === 134) {
    return new MqttTransportError({
      code: "credential_invalid",
      retryable: false,
    });
  }
  if (reasonCode === 5 || reasonCode === 135) {
    return new MqttTransportError({
      code: "permission_denied",
      retryable: false,
    });
  }
  if (reasonCode === 151 || reasonCode === 159) {
    return new MqttTransportError({
      code: "rate_limited",
      retryable: true,
    });
  }
  return new MqttTransportError({
    code: "network_unreachable",
    retryable: true,
  });
}

async function waitForInitialConnection(
  client: MqttClient,
  config: MqttConfig,
  signal: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return false;
      settled = true;
      client.off("connect", onConnect);
      client.off("error", onError);
      signal.removeEventListener("abort", onAbort);
      return true;
    };
    const fail = (error: unknown) => {
      if (finish()) reject(mapMqttError(error));
    };
    const onError = (error: Error) => fail(error);
    const onAbort = () =>
      fail(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("mqtt_start_aborted"),
      );
    const onConnect = () => {
      client.subscribe(
        config.subscribe_topic,
        { qos: config.qos },
        (error, granted) => {
          if (error) {
            fail(error);
            return;
          }
          if (
            !granted
            || granted.length !== 1
            || granted[0]?.qos === 128
          ) {
            fail(new MqttTransportError({
              code: "permission_denied",
              retryable: false,
            }));
            return;
          }
          if (finish()) resolve();
        },
      );
    };

    client.once("connect", onConnect);
    client.once("error", onError);
    signal.addEventListener("abort", onAbort, {
      once: true,
    });
    if (signal.aborted) onAbort();
  });
}

function publishMessageId(
  packet: unknown,
): number | null {
  const value = asRecord(packet).messageId;
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    ? value
    : null;
}

function numericReasonCode(
  record: Record<string, unknown>,
): number | null {
  for (const value of [
    record.reasonCode,
    record.returnCode,
    record.code,
  ]) {
    if (
      typeof value === "number"
      && Number.isSafeInteger(value)
    ) {
      return value;
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
