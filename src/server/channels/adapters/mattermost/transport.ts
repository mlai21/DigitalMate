import {
  WebSocket,
} from "ws";

import type {
  AdapterDependencies,
} from "@/server/channels/runtime/types";

import {
  mattermostBaseUrl,
  type MattermostConfig,
} from "./config";

export type MattermostTransportErrorCode =
  | "credential_invalid"
  | "permission_denied"
  | "rate_limited"
  | "network_unreachable"
  | "response_invalid";

export class MattermostTransportError extends Error {
  readonly code: MattermostTransportErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(input: Readonly<{
    code: MattermostTransportErrorCode;
    retryable: boolean;
    retryAfterMs?: number;
  }>) {
    super(input.code);
    this.name = "MattermostTransportError";
    this.code = input.code;
    this.retryable = input.retryable;
    this.retryAfterMs = input.retryAfterMs;
  }
}

export type MattermostClientPort = Readonly<{
  start(input: Readonly<{
    signal: AbortSignal;
    onEvent(payload: unknown): Promise<void>;
    onError(error: Error): void;
  }>): Promise<Readonly<{
    botUserId: string;
    botUsername: string;
  }>>;
  stop(): Promise<void>;
  post(input: Readonly<{
    channelId: string;
    message: string;
    rootId?: string;
  }>): Promise<Readonly<{ postId: string }>>;
  sendTyping(input: Readonly<{
    userId: string;
    channelId: string;
    parentId?: string;
  }>): Promise<void>;
}>;

export type MattermostClientFactory = (
  config: MattermostConfig,
) => MattermostClientPort;

export function createMattermostClient(
  config: MattermostConfig,
): MattermostClientPort {
  const http = mattermostHttpClient();
  let socket: WebSocket | null = null;
  let stopped = false;
  let detachAbort: (() => void) | null = null;

  return {
    async start(input) {
      const me = await callJson(
        http,
        config,
        "GET",
        "/api/v4/users/me",
        undefined,
        input.signal,
      );
      const botUserId = requireId(
        primitiveId(me.id),
        "mattermost_bot_user_id_missing",
      );
      const botUsername = requireId(
        primitiveId(me.username),
        "mattermost_bot_username_missing",
      );
      const activeSocket = new WebSocket(
        mattermostWebSocketUrl(config.url),
      );
      socket = activeSocket;
      const onAbort = () => {
        void stop();
      };
      input.signal.addEventListener("abort", onAbort, {
        once: true,
      });
      detachAbort = () =>
        input.signal.removeEventListener("abort", onAbort);
      input.signal.throwIfAborted();

      await new Promise<void>((resolve, reject) => {
        let authenticated = false;
        let settled = false;
        const finish = () => {
          if (settled) return false;
          settled = true;
          input.signal.removeEventListener(
            "abort",
            abortAuthentication,
          );
          return true;
        };
        const fail = (error: unknown) => {
          if (!finish()) return;
          reject(mapMattermostError(error));
        };
        const abortAuthentication = () => {
          fail(
            input.signal.reason instanceof Error
              ? input.signal.reason
              : new Error("mattermost_start_aborted"),
          );
        };
        input.signal.addEventListener(
          "abort",
          abortAuthentication,
          { once: true },
        );
        activeSocket.once("error", fail);
        activeSocket.once("open", () => {
          activeSocket.send(JSON.stringify({
            seq: 1,
            action: "authentication_challenge",
            data: { token: config.bot_token },
          }));
        });
        activeSocket.on("message", (data) => {
          const payload = parseSocketPayload(data);
          if (!payload) return;
          const record = asRecord(payload);
          if (
            !authenticated
            && numericValue(record.seq_reply) === 1
          ) {
            if (record.status !== "OK") {
              fail(new MattermostTransportError({
                code: "credential_invalid",
                retryable: false,
              }));
              return;
            }
            authenticated = true;
            activeSocket.off("error", fail);
            if (finish()) resolve();
            return;
          }
          if (!authenticated) return;
          void input.onEvent(payload).catch((error: unknown) => {
            input.onError(asError(error));
          });
        });
        activeSocket.on("error", (error) => {
          if (authenticated) {
            input.onError(mapMattermostError(error));
          }
        });
        activeSocket.on("close", () => {
          if (!authenticated) {
            fail(new MattermostTransportError({
              code: "network_unreachable",
              retryable: true,
            }));
          } else if (!stopped) {
            input.onError(new MattermostTransportError({
              code: "network_unreachable",
              retryable: true,
            }));
          }
        });
      });
      return { botUserId, botUsername };
    },

    stop,

    async post(input) {
      const result = await callJson(
        http,
        config,
        "POST",
        "/api/v4/posts",
        {
          channel_id: input.channelId,
          message: input.message,
          ...(input.rootId ? { root_id: input.rootId } : {}),
        },
        new AbortController().signal,
      );
      return {
        postId: requireId(
          primitiveId(result.id),
          "mattermost_post_id_missing",
        ),
      };
    },

    async sendTyping(input) {
      await callJson(
        http,
        config,
        "POST",
        `/api/v4/users/${
          encodeURIComponent(input.userId)
        }/channels/${
          encodeURIComponent(input.channelId)
        }/typing`,
        {
          ...(input.parentId
            ? { parent_id: input.parentId }
            : {}),
        },
        new AbortController().signal,
      );
    },
  };

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    detachAbort?.();
    detachAbort = null;
    const activeSocket = socket;
    socket = null;
    if (!activeSocket) return;
    activeSocket.removeAllListeners();
    activeSocket.close(1000, "shutdown");
  }
}

export function mattermostWebSocketUrl(
  baseUrl: string,
): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${
    url.pathname.replace(/\/+$/u, "")
  }/api/v4/websocket`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function mapMattermostError(
  error: unknown,
): MattermostTransportError {
  if (error instanceof MattermostTransportError) return error;
  const record = asRecord(error);
  const status = numericValue(record.status)
    ?? numericValue(record.statusCode);
  if (status === 401) {
    return new MattermostTransportError({
      code: "credential_invalid",
      retryable: false,
    });
  }
  if (status === 403) {
    return new MattermostTransportError({
      code: "permission_denied",
      retryable: false,
    });
  }
  if (status === 429) {
    const headers = asRecord(record.headers);
    const seconds = numericValue(
      headers["retry-after"] ?? record.retryAfter,
    );
    return new MattermostTransportError({
      code: "rate_limited",
      retryable: true,
      ...(seconds !== null
        ? { retryAfterMs: Math.ceil(seconds * 1_000) }
        : {}),
    });
  }
  return new MattermostTransportError({
    code: "network_unreachable",
    retryable: true,
  });
}

export function createMattermostAttachmentFetcher(
  config: MattermostConfig,
  http?: NonNullable<AdapterDependencies["http"]>,
) {
  const client = http ?? mattermostHttpClient();
  return {
    async inspect(
      descriptor: Readonly<{
        source: Readonly<Record<string, string>>;
      }>,
      signal = new AbortController().signal,
    ) {
      const fileId = requireId(
        descriptor.source.fileId,
        "mattermost_attachment_file_id_missing",
      );
      const info = await callJson(
        client,
        config,
        "GET",
        `/api/v4/files/${encodeURIComponent(fileId)}/info`,
        undefined,
        signal,
      );
      const fileName = requireId(
        primitiveId(info.name),
        "mattermost_attachment_name_missing",
      );
      const mimeType = primitiveId(info.mime_type)
        ?? mimeFromName(fileName);
      const sizeBytes = nonNegativeInteger(info.size);
      if (!mimeType || sizeBytes === null) {
        throw new Error(
          "mattermost_attachment_metadata_incomplete",
        );
      }
      return { fileName, mimeType, sizeBytes };
    },

    async download(
      descriptor: Readonly<{
        source: Readonly<Record<string, string>>;
      }>,
      signal = new AbortController().signal,
    ): Promise<AsyncIterable<Uint8Array>> {
      const fileId = requireId(
        descriptor.source.fileId,
        "mattermost_attachment_file_id_missing",
      );
      const response = await client.request({
        method: "GET",
        url: `${
          mattermostBaseUrl(config)
        }/api/v4/files/${encodeURIComponent(fileId)}`,
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
        throw new Error("mattermost_attachment_download_failed");
      }
      return singleChunk(bytes);
    },
  };
}

type MattermostHttp = NonNullable<AdapterDependencies["http"]>;

function mattermostHttpClient(): MattermostHttp {
  return {
    async request(input) {
      const response = await fetch(input.url, {
        method: input.method,
        headers: input.headers,
        body: input.body === undefined
          ? undefined
          : JSON.stringify(input.body),
        signal: input.signal,
        redirect: "error",
      });
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: input.responseType === "bytes"
          ? new Uint8Array(await response.arrayBuffer())
          : await response.json(),
      };
    },
  };
}

async function callJson(
  http: MattermostHttp,
  config: MattermostConfig,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await http.request({
    method,
    url: `${mattermostBaseUrl(config)}${path}`,
    headers: {
      ...authorizationHeaders(config),
      "content-type": "application/json",
    },
    ...(body !== undefined ? { body } : {}),
    signal,
  });
  if (response.status < 200 || response.status >= 300) {
    throw mapMattermostError({
      status: response.status,
      headers: response.headers,
    });
  }
  return asRecord(response.body);
}

function authorizationHeaders(
  config: MattermostConfig,
): Readonly<Record<string, string>> {
  return {
    authorization: `Bearer ${config.bot_token}`,
  };
}

function parseSocketPayload(value: unknown): unknown {
  try {
    const text = typeof value === "string"
      ? value
      : Buffer.isBuffer(value)
        ? value.toString("utf8")
        : value instanceof ArrayBuffer
          ? Buffer.from(value).toString("utf8")
          : null;
    return text ? JSON.parse(text) as unknown : null;
  } catch {
    return null;
  }
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

function asError(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error("mattermost_ingress_failed");
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
