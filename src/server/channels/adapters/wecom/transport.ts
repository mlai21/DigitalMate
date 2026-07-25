import {
  WSClient,
  type BaseMessage,
  type EventMessage,
  type WsFrame,
} from "@wecom/aibot-node-sdk";

import type { WeComConfig } from "./config";

export class WeComTransportError extends Error {
  readonly code:
    | "credential_invalid"
    | "permission_denied"
    | "rate_limited"
    | "network_unreachable"
    | "runtime_prerequisite_missing";
  readonly detail: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(input: Readonly<{
    code: WeComTransportError["code"];
    detail: string;
    retryable: boolean;
    retryAfterMs?: number;
  }>) {
    super(input.code);
    this.name = "WeComTransportError";
    this.code = input.code;
    this.detail = input.detail;
    this.retryable = input.retryable;
    this.retryAfterMs = input.retryAfterMs;
  }
}

export type WeComClientPort = Readonly<{
  start(input: Readonly<{
    signal: AbortSignal;
    config: WeComConfig;
    onMessage(payload: unknown): Promise<void>;
    onWelcome(payload: unknown): Promise<void>;
    onAuthenticated(): void;
    onDisconnected(reason: string): void;
    onReconnecting(attempt: number): void;
    onError(error: Error): void;
  }>): Promise<void>;
  stop(): Promise<void>;
  replyStream(input: Readonly<{
    requestId: string;
    streamId: string;
    content: string;
    finish: boolean;
    nonBlocking: boolean;
  }>): Promise<Readonly<{
    messageId: string;
    skipped: boolean;
  }>>;
  sendMarkdown(input: Readonly<{
    chatId: string;
    content: string;
  }>): Promise<Readonly<{ messageId: string }>>;
  replyWelcome(input: Readonly<{
    requestId: string;
    content: string;
  }>): Promise<void>;
  downloadFile(input: Readonly<{
    url: string;
    aesKey: string;
  }>): Promise<Readonly<{
    bytes: Uint8Array;
    fileName?: string;
  }>>;
  uploadMedia(input: Readonly<{
    bytes: Uint8Array;
    fileName: string;
    mediaType: "file" | "image" | "video" | "voice";
  }>): Promise<Readonly<{ mediaId: string }>>;
}>;

export type WeComClientFactory = (
  config: WeComConfig,
) => WeComClientPort;

export function createWeComSdkClient(
  config: WeComConfig,
): WeComClientPort {
  const client = new WSClient({
    botId: config.bot_id,
    secret: config.secret,
    maxReconnectAttempts: config.max_reconnect_attempts,
    logger: silentLogger,
  });
  let started = false;
  let stopping = false;

  return {
    async start(input) {
      if (started) return;
      stopping = false;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
          fail(new WeComTransportError({
            code: "network_unreachable",
            detail: "wecom_authentication_timeout",
            retryable: true,
          }));
        }, 15_000);
        const cleanupStartup = () => {
          clearTimeout(timeout);
          input.signal.removeEventListener("abort", onAbort);
        };
        const succeed = () => {
          if (settled) {
            started = true;
            input.onAuthenticated();
            return;
          }
          settled = true;
          cleanupStartup();
          started = true;
          input.onAuthenticated();
          resolve();
        };
        const fail = (error: unknown) => {
          const mapped = mapWeComError(error);
          if (settled) {
            input.onError(mapped);
            return;
          }
          settled = true;
          cleanupStartup();
          reject(mapped);
        };
        const onAbort = () => {
          client.disconnect();
          fail(new WeComTransportError({
            code: "network_unreachable",
            detail: "wecom_start_aborted",
            retryable: true,
          }));
        };

        client.on("authenticated", succeed);
        client.on("reconnecting", (attempt) => {
          input.onReconnecting(attempt);
        });
        client.on("disconnected", (_reason) => {
          input.onDisconnected("wecom_disconnected");
        });
        client.on("error", fail);
        client.on("message", (frame: WsFrame<BaseMessage>) => {
          void input.onMessage(frame).catch((error: unknown) => {
            input.onError(mapWeComError(error));
          });
        });
        client.on(
          "event.enter_chat",
          (frame: WsFrame<EventMessage>) => {
            void input.onWelcome(frame).catch((error: unknown) => {
              input.onError(mapWeComError(error));
            });
          },
        );
        input.signal.addEventListener("abort", onAbort, {
          once: true,
        });
        client.connect();
      });
    },

    async stop() {
      if (stopping) return;
      stopping = true;
      client.removeAllListeners();
      client.disconnect();
      started = false;
    },

    async replyStream(input) {
      const frame = requestFrame(input.requestId);
      const response = input.nonBlocking
        ? await client.replyStreamNonBlocking(
            frame,
            input.streamId,
            input.content,
            input.finish,
          )
        : await client.replyStream(
            frame,
            input.streamId,
            input.content,
            input.finish,
          );
      return {
        messageId: `wecom-stream:${input.streamId}`,
        skipped: response === "skipped",
      };
    },

    async sendMarkdown(input) {
      const response = await client.sendMessage(input.chatId, {
        msgtype: "markdown",
        markdown: { content: input.content },
      });
      return {
        messageId:
          frameIdentifier(response)
          ?? `wecom-send:${input.chatId}`,
      };
    },

    async replyWelcome(input) {
      await client.replyWelcome(
        requestFrame(input.requestId),
        {
          msgtype: "text",
          text: { content: input.content },
        },
      );
    },

    async downloadFile(input) {
      const result = await client.downloadFile(
        input.url,
        input.aesKey,
      );
      return {
        bytes: result.buffer,
        ...(result.filename
          ? { fileName: result.filename }
          : {}),
      };
    },

    async uploadMedia(input) {
      const result = await client.uploadMedia(
        Buffer.from(input.bytes),
        {
          type: input.mediaType,
          filename: input.fileName,
        },
      );
      return { mediaId: result.media_id };
    },
  };
}

export function mapWeComError(error: unknown): WeComTransportError {
  if (error instanceof WeComTransportError) return error;
  const record = asRecord(error);
  const code = stringValue(record.code)?.toUpperCase() ?? "";
  const name = stringValue(record.name)?.toUpperCase() ?? "";
  const message = stringValue(record.message)?.toLowerCase() ?? "";
  if (
    code === "WS_AUTH_FAILURE_EXHAUSTED"
    || name === "WSAUTHFAILUREERROR"
  ) {
    return new WeComTransportError({
      code: "credential_invalid",
      detail: "wecom_credentials_rejected",
      retryable: false,
    });
  }
  if (
    code.includes("NOT_ELIGIBLE")
    || name.includes("ELIGIBILITY")
    || message.includes("eligibility")
    || message.includes("资格")
  ) {
    return new WeComTransportError({
      code: "runtime_prerequisite_missing",
      detail: "wecom_bot_eligibility_required",
      retryable: false,
    });
  }
  if (
    code.includes("PERMISSION")
    || code.includes("FORBIDDEN")
    || message.includes("permission denied")
    || message.includes("权限")
  ) {
    return new WeComTransportError({
      code: "permission_denied",
      detail: "wecom_permission_denied",
      retryable: false,
    });
  }
  if (
    code.includes("RATE")
    || code.includes("FREQUENCY")
    || message.includes("rate limit")
  ) {
    return new WeComTransportError({
      code: "rate_limited",
      detail: "wecom_rate_limited",
      retryable: true,
    });
  }
  if (code === "WS_RECONNECT_EXHAUSTED") {
    return new WeComTransportError({
      code: "network_unreachable",
      detail: "wecom_reconnect_exhausted",
      retryable: true,
    });
  }
  return new WeComTransportError({
    code: "network_unreachable",
    detail: "wecom_network_unreachable",
    retryable: true,
  });
}

function requestFrame(requestId: string) {
  return {
    headers: { req_id: requestId },
  };
}

function frameIdentifier(frame: unknown): string | null {
  const record = asRecord(frame);
  const body = asRecord(record.body);
  const headers = asRecord(record.headers);
  return stringValue(body.msgid)
    ?? stringValue(body.message_id)
    ?? stringValue(headers.req_id);
}

const silentLogger = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0
    ? value
    : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
