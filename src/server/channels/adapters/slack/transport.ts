import {
  App,
  SocketModeReceiver,
} from "@slack/bolt";
import {
  ProxyAgent,
} from "undici";

import type {
  AdapterDependencies,
} from "@/server/channels/runtime/types";

import type { SlackConfig } from "./config";

export type SlackTransportErrorCode =
  | "credential_invalid"
  | "permission_denied"
  | "rate_limited"
  | "network_unreachable"
  | "response_invalid";

export class SlackTransportError extends Error {
  readonly code: SlackTransportErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(input: Readonly<{
    code: SlackTransportErrorCode;
    retryable: boolean;
    retryAfterMs?: number;
  }>) {
    super(input.code);
    this.name = "SlackTransportError";
    this.code = input.code;
    this.retryable = input.retryable;
    this.retryAfterMs = input.retryAfterMs;
  }
}

export type SlackClientPort = Readonly<{
  start(input: Readonly<{
    signal: AbortSignal;
    onEnvelope(
      payload: unknown,
      ack: () => Promise<void>,
    ): Promise<void>;
    onError(error: Error): void;
  }>): Promise<Readonly<{
    botUserId: string;
    botId: string | null;
  }>>;
  stop(): Promise<void>;
  postMessage(input: Readonly<{
    channel: string;
    text: string;
    threadTs?: string;
  }>): Promise<Readonly<{ ts: string }>>;
  updateMessage(input: Readonly<{
    channel: string;
    ts: string;
    text: string;
  }>): Promise<void>;
}>;

export type SlackClientFactory = (
  config: SlackConfig,
) => SlackClientPort;

export function createSlackBoltClient(
  config: SlackConfig,
): SlackClientPort {
  const proxy = slackProxyOptions(config);
  const dispatcher = proxy ? new ProxyAgent(proxy) : null;
  const receiver = new SocketModeReceiver({
    appToken: config.app_token,
    autoReconnectEnabled: true,
    ...(dispatcher ? { dispatcher } : {}),
  });
  const app = new App({
    token: config.bot_token,
    receiver,
    ignoreSelf: false,
    tokenVerificationEnabled: true,
    ...(dispatcher
      ? {
          clientOptions: {
            fetch: async (url, init) =>
              fetch(url, {
                ...init,
                dispatcher,
              } as RequestInit & { dispatcher: ProxyAgent }),
          },
        }
      : {}),
  });
  let detachAbort: (() => void) | null = null;
  let stopped = false;
  let onEnvelope:
    | ((
        payload: unknown,
        ack: () => Promise<void>,
      ) => Promise<void>)
    | null = null;
  let onError: ((error: Error) => void) | null = null;
  let authenticatedBotUserId: string | null = null;

  app.event("message", async ({ body, ack }) => {
    if (!onEnvelope) return;
    const acknowledge = ack as
      | (() => Promise<void>)
      | undefined;
    if (!acknowledge) {
      throw new Error("slack_socket_ack_unavailable");
    }
    const event = asRecord(asRecord(body).event);
    if (
      primitiveId(event.bot_id) !== null
      || primitiveId(event.user) === authenticatedBotUserId
    ) {
      await acknowledge();
      return;
    }
    await onEnvelope(body, acknowledge);
  });
  app.error(async (error) => {
    onError?.(mapSlackError(error));
  });

  return {
    async start(input) {
      onEnvelope = input.onEnvelope;
      onError = input.onError;
      const onAbort = () => {
        void stop();
      };
      input.signal.addEventListener("abort", onAbort, {
        once: true,
      });
      detachAbort = () =>
        input.signal.removeEventListener("abort", onAbort);
      input.signal.throwIfAborted();

      try {
        const auth = await app.client.auth.test();
        const botUserId = primitiveId(auth.user_id);
        if (!botUserId) {
          throw new SlackTransportError({
            code: "response_invalid",
            retryable: false,
          });
        }
        authenticatedBotUserId = botUserId;
        await app.start();
        return {
          botUserId,
          botId: primitiveId(auth.bot_id),
        };
      } catch (error) {
        await stop();
        throw mapSlackError(error);
      }
    },

    stop,

    async postMessage(input) {
      try {
        const result = await app.client.chat.postMessage({
          channel: input.channel,
          text: requireSlackText(input.text),
          ...(input.threadTs
            ? { thread_ts: input.threadTs }
            : {}),
          unfurl_links: false,
          unfurl_media: false,
        });
        return {
          ts: requireId(
            primitiveId(result.ts),
            "slack_message_ts_missing",
          ),
        };
      } catch (error) {
        throw mapSlackError(error);
      }
    },

    async updateMessage(input) {
      try {
        await app.client.chat.update({
          channel: input.channel,
          ts: input.ts,
          text: requireSlackText(input.text),
        });
      } catch (error) {
        throw mapSlackError(error);
      }
    },
  };

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    detachAbort?.();
    detachAbort = null;
    onEnvelope = null;
    onError = null;
    authenticatedBotUserId = null;
    await app.stop().catch(() => undefined);
    if (dispatcher) {
      await dispatcher.close().catch(() => undefined);
    }
  }
}

export function slackProxyOptions(
  config: Pick<SlackConfig, "proxy">,
): Readonly<{ uri: string }> | null {
  return config.proxy ? { uri: config.proxy } : null;
}

export function mapSlackError(
  error: unknown,
): SlackTransportError {
  if (error instanceof SlackTransportError) return error;
  const record = asRecord(error);
  const data = asRecord(record.data);
  const sdkCode = primitiveId(record.code);
  const platformCode = primitiveId(data.error) ?? sdkCode;
  if (
    [
      "invalid_auth",
      "not_authed",
      "account_inactive",
      "token_revoked",
      "slack_socket_mode_invalid_auth_error",
    ].includes(platformCode ?? "")
  ) {
    return new SlackTransportError({
      code: "credential_invalid",
      retryable: false,
    });
  }
  if (
    [
      "missing_scope",
      "not_in_channel",
      "channel_not_found",
      "restricted_action",
    ].includes(platformCode ?? "")
  ) {
    return new SlackTransportError({
      code: "permission_denied",
      retryable: false,
    });
  }
  if (
    sdkCode === "slack_webapi_rate_limited_error"
    || numericValue(record.statusCode) === 429
  ) {
    const retryAfter = numericValue(record.retryAfter)
      ?? numericValue(data.retryAfter);
    return new SlackTransportError({
      code: "rate_limited",
      retryable: true,
      ...(retryAfter !== null
        ? { retryAfterMs: Math.ceil(retryAfter * 1_000) }
        : {}),
    });
  }
  return new SlackTransportError({
    code: "network_unreachable",
    retryable: true,
  });
}

export function createSlackAttachmentFetcher(
  config: SlackConfig,
  http?: NonNullable<AdapterDependencies["http"]>,
) {
  const metadata = new Map<string, Readonly<{
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    url: string;
  }>>();
  const client = http ?? slackHttpClient(config);

  return {
    async inspect(
      descriptor: Readonly<{
        externalAttachmentId: string;
        source: Readonly<Record<string, string>>;
      }>,
      signal = new AbortController().signal,
    ) {
      const fileId = descriptor.source.fileId;
      if (!fileId) {
        throw new Error("slack_attachment_file_id_missing");
      }
      const response = await client.request({
        method: "GET",
        url: `https://slack.com/api/files.info?file=${
          encodeURIComponent(fileId)
        }`,
        headers: authorizationHeaders(config),
        signal,
      });
      const payload = asRecord(response.body);
      const file = asRecord(payload.file);
      const fileName = primitiveId(file.name)
        ?? primitiveId(file.title);
      const mimeType = primitiveId(file.mimetype)
        ?? (fileName ? mimeFromName(fileName) : null);
      const sizeBytes = nonNegativeInteger(file.size);
      const url = safeSlackFileUrl(
        file.url_private_download ?? file.url_private,
      );
      if (
        response.status !== 200
        || payload.ok !== true
        || !fileName
        || !mimeType
        || sizeBytes === null
        || !url
      ) {
        throw new Error(
          "slack_attachment_metadata_incomplete",
        );
      }
      const resolved = {
        fileName,
        mimeType,
        sizeBytes,
        url,
      };
      metadata.set(descriptor.externalAttachmentId, resolved);
      return {
        fileName,
        mimeType,
        sizeBytes,
      };
    },

    async download(
      descriptor: Readonly<{
        externalAttachmentId: string;
        source: Readonly<Record<string, string>>;
      }>,
      signal = new AbortController().signal,
    ): Promise<AsyncIterable<Uint8Array>> {
      let resolved = metadata.get(
        descriptor.externalAttachmentId,
      );
      if (!resolved) {
        await this.inspect(descriptor, signal);
        resolved = metadata.get(
          descriptor.externalAttachmentId,
        );
      }
      if (!resolved) {
        throw new Error("slack_attachment_metadata_missing");
      }
      const response = await client.request({
        method: "GET",
        url: resolved.url,
        headers: authorizationHeaders(config),
        responseType: "bytes",
        signal,
      });
      const bytes = toBytes(response.body);
      if (
        response.status < 200
        || response.status >= 300
        || !bytes
      ) {
        throw new Error("slack_attachment_download_failed");
      }
      return singleChunk(bytes);
    },
  };
}

function slackHttpClient(
  config: SlackConfig,
): NonNullable<AdapterDependencies["http"]> {
  return {
    async request(input) {
      const proxy = slackProxyOptions(config);
      const dispatcher = proxy ? new ProxyAgent(proxy) : null;
      try {
        const response = await fetch(input.url, {
          method: input.method,
          headers: input.headers,
          signal: input.signal,
          redirect: "error",
          ...(dispatcher ? { dispatcher } : {}),
        });
        return {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body: input.responseType === "bytes"
            ? new Uint8Array(await response.arrayBuffer())
            : await response.json(),
        };
      } finally {
        if (dispatcher) {
          await dispatcher.close().catch(() => undefined);
        }
      }
    },
  };
}

function authorizationHeaders(
  config: SlackConfig,
): Readonly<Record<string, string>> {
  return {
    authorization: `Bearer ${config.bot_token}`,
  };
}

function safeSlackFileUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 8_192) {
    return null;
  }
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:"
      && url.username.length === 0
      && url.password.length === 0
      && (
        host === "files.slack.com"
        || host.endsWith(".slack.com")
      )
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function requireSlackText(value: string): string {
  const text = value.trim();
  if (text.length === 0 || text.length > 40_000) {
    throw new SlackTransportError({
      code: "response_invalid",
      retryable: false,
    });
  }
  return text;
}

function mimeFromName(fileName: string): string | null {
  switch (fileName.split(".").at(-1)?.toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "pdf":
      return "application/pdf";
    case "txt":
      return "text/plain";
    case "md":
      return "text/markdown";
    case "json":
      return "application/json";
    case "csv":
      return "text/csv";
    default:
      return null;
  }
}

function numericValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (
    typeof value === "string"
    && value.trim().length > 0
  ) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : null;
}

function primitiveId(value: unknown): string | null {
  if (
    typeof value !== "string"
    && typeof value !== "number"
  ) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized.length > 0 && normalized.length <= 1_024
    ? normalized
    : null;
}

function requireId(
  value: string | undefined | null,
  code: string,
): string {
  if (!value) throw new Error(code);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function toBytes(value: unknown): Uint8Array | null {
  if (!ArrayBuffer.isView(value)) return null;
  return new Uint8Array(
    value.buffer,
    value.byteOffset,
    value.byteLength,
  );
}

async function* singleChunk(
  value: Uint8Array,
): AsyncIterable<Uint8Array> {
  yield value;
}
