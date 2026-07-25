import type {
  AdapterDependencies,
  ChannelDelivery,
  InboundContext,
  IngressResult,
  SendContext,
  SendResult,
} from "@/server/channels/runtime/types";
import type {
  InboundAttachmentFetcher,
  InboundAttachmentMetadata,
} from "@/server/channels/runtime/attachment-ingress";

import {
  telegramApiBaseUrl,
  type TelegramConfig,
} from "./config";

export type TelegramHttpClient =
  NonNullable<AdapterDependencies["http"]>;
type TelegramHttpResponse = Awaited<
  ReturnType<TelegramHttpClient["request"]>
>;

export type TelegramTransportErrorCode =
  | "credential_invalid"
  | "permission_denied"
  | "polling_conflict"
  | "rate_limited"
  | "network_unreachable"
  | "response_invalid";

export class TelegramTransportError extends Error {
  readonly code: TelegramTransportErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(input: Readonly<{
    code: TelegramTransportErrorCode;
    retryable: boolean;
    retryAfterMs?: number;
  }>) {
    super(input.code);
    this.name = "TelegramTransportError";
    this.code = input.code;
    this.retryable = input.retryable;
    this.retryAfterMs = input.retryAfterMs;
  }
}

export function createTelegramTransport(input: Readonly<{
  http?: TelegramHttpClient;
  now?: () => Date;
}> = {}) {
  const now = input.now ?? (() => new Date());
  const httpFor = (config: TelegramConfig) =>
    input.http ?? fetchHttpClient(config);

  return {
    async verify(
      config: TelegramConfig,
      signal: AbortSignal,
    ): Promise<void> {
      await callApi(
        httpFor(config),
        config,
        "getMe",
        {},
        signal,
      );
    },

    async pollOnce(poll: Readonly<{
      config: TelegramConfig;
      offset: number;
      context: InboundContext;
      accept(
        payload: unknown,
        context: InboundContext,
      ): Promise<IngressResult>;
      signal: AbortSignal;
    }>): Promise<number> {
      const result = await callApi(
        httpFor(poll.config),
        poll.config,
        "getUpdates",
        {
          offset: poll.offset,
          timeout: 30,
          allowed_updates: [
            "message",
            "edited_message",
            "callback_query",
          ],
        },
        poll.signal,
        "GET",
      );
      if (!Array.isArray(result)) {
        throw transportError("response_invalid", false);
      }

      let nextOffset = poll.offset;
      for (const update of result) {
        poll.signal.throwIfAborted();
        const updateId = telegramUpdateId(update);
        if (updateId === null || updateId < poll.offset) continue;
        await poll.accept(update, poll.context);
        nextOffset = Math.max(nextOffset, updateId + 1);
      }
      return nextOffset;
    },

    async send(
      delivery: ChannelDelivery,
      context: SendContext<TelegramConfig>,
    ): Promise<SendResult> {
      const address = deliveryAddress(delivery);
      const result = await callApi(
        httpFor(context.config),
        context.config,
        "sendMessage",
        {
          chat_id: address.chatId,
          text: escapeTelegramHtml(delivery.body),
          parse_mode: "HTML",
          ...(address.messageThreadId !== null
            ? { message_thread_id: address.messageThreadId }
            : {}),
          ...(address.replyToMessageId !== null
            ? { reply_to_message_id: address.replyToMessageId }
            : {}),
        },
        context.signal,
      );
      return sendResult(result, context.now());
    },

    async edit(
      delivery: ChannelDelivery,
      config: TelegramConfig,
      messageId: string,
      signal: AbortSignal,
    ): Promise<SendResult> {
      const address = deliveryAddress(delivery);
      await callApi(
        httpFor(config),
        config,
        "editMessageText",
        {
          chat_id: address.chatId,
          message_id: numericId(messageId) ?? messageId,
          text: escapeTelegramHtml(delivery.body),
          parse_mode: "HTML",
        },
        signal,
      );
      return {
        externalMessageId: messageId,
        sentAt: now(),
        rawSummary: { ok: true, edited: true },
      };
    },

    async typing(
      config: TelegramConfig,
      chatId: string,
      messageThreadId: string | undefined,
      signal: AbortSignal,
    ): Promise<void> {
      await callApi(
        httpFor(config),
        config,
        "sendChatAction",
        {
          chat_id: chatId,
          action: "typing",
          ...(messageThreadId
            ? {
                message_thread_id:
                  numericId(messageThreadId) ?? messageThreadId,
              }
            : {}),
        },
        signal,
      );
    },

    attachmentFetcher(
      config: TelegramConfig,
    ): InboundAttachmentFetcher {
      const resolved = new Map<string, string>();
      return {
        async inspect(
          descriptor,
          signal = new AbortController().signal,
        ): Promise<InboundAttachmentMetadata> {
          const fileId = descriptor.source.fileId;
          if (!fileId) {
            throw new Error("telegram_attachment_file_id_missing");
          }
          const result = asRecord(
            await callApi(
              httpFor(config),
              config,
              "getFile",
              { file_id: fileId },
              signal,
            ),
          );
          const filePath = safeTelegramFilePath(
            primitiveId(result.file_path),
          );
          if (!filePath) {
            throw new Error("telegram_attachment_path_invalid");
          }
          resolved.set(descriptor.externalAttachmentId, filePath);
          const fileName = descriptor.fileName
            ?? filePath.split("/").at(-1)
            ?? "telegram-file";
          const mimeType = descriptor.mimeType
            ?? mimeFromName(fileName);
          const sizeBytes = descriptor.sizeBytes
            ?? nonNegativeInteger(result.file_size);
          if (!mimeType || sizeBytes === null) {
            throw new Error(
              "telegram_attachment_metadata_incomplete",
            );
          }
          return { fileName, mimeType, sizeBytes };
        },

        async download(
          descriptor,
          signal = new AbortController().signal,
        ): Promise<AsyncIterable<Uint8Array>> {
          let filePath = resolved.get(
            descriptor.externalAttachmentId,
          );
          if (!filePath) {
            const metadata = await this.inspect(
              descriptor,
              signal,
            );
            void metadata;
            filePath = resolved.get(
              descriptor.externalAttachmentId,
            );
          }
          if (!filePath) {
            throw new Error("telegram_attachment_path_invalid");
          }
          const response = await requestTelegramFile(
            httpFor(config),
            config,
            filePath,
            signal,
          );
          const bytes = toBytes(response.body);
          if (!bytes) {
            throw new Error("telegram_attachment_download_invalid");
          }
          return oneChunk(bytes);
        },
      };
    },
  };
}

async function callApi(
  http: TelegramHttpClient,
  config: TelegramConfig,
  methodName: string,
  body: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
  method: "GET" | "POST" = "POST",
): Promise<unknown> {
  signal.throwIfAborted();
  const endpoint = `${
    telegramApiBaseUrl(config)
  }/bot${config.bot_token}/${methodName}`;
  const request = method === "GET"
    ? {
        method,
        url: withQuery(endpoint, body),
        headers: {} as Readonly<Record<string, string>>,
        signal,
      } as const
    : {
        method,
        url: endpoint,
        headers: { "content-type": "application/json" },
        body,
        signal,
      } as const;

  let response: TelegramHttpResponse;
  try {
    response = await http.request(request);
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof TelegramTransportError) throw error;
    throw transportError("network_unreachable", true);
  }
  signal.throwIfAborted();
  const payload = asRecord(response.body);
  if (response.status === 401) {
    throw transportError("credential_invalid", false);
  }
  if (response.status === 403) {
    throw transportError("permission_denied", false);
  }
  if (response.status === 409) {
    throw transportError("polling_conflict", true);
  }
  if (response.status === 429) {
    throw transportError(
      "rate_limited",
      true,
      retryAfterMs(response, payload),
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw transportError("network_unreachable", true);
  }
  if (payload.ok !== true || !("result" in payload)) {
    throw transportError("response_invalid", false);
  }
  return payload.result;
}

function fetchHttpClient(
  config: TelegramConfig,
): TelegramHttpClient {
  return {
    async request(input) {
      const proxyOptions = telegramProxyOptions(config);
      const dispatcher = proxyOptions
        ? new ProxyAgent(proxyOptions)
        : null;
      try {
        const response = await fetch(input.url, {
          method: input.method,
          headers: input.headers,
          ...(input.body === undefined
            ? {}
            : { body: JSON.stringify(input.body) }),
          signal: input.signal,
          ...(dispatcher ? { dispatcher } : {}),
        } as RequestInit & { dispatcher?: Dispatcher });
        let body: unknown = null;
        if (input.responseType === "bytes") {
          body = new Uint8Array(await response.arrayBuffer());
        } else {
          try {
            body = await response.json() as unknown;
          } catch {
            body = null;
          }
        }
        return {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body,
        };
      } finally {
        await dispatcher?.close().catch(() => undefined);
      }
    },
  };
}

export function telegramProxyOptions(
  config: Pick<
    TelegramConfig,
    "http_proxy" | "http_proxy_auth"
  >,
): Readonly<{
  uri: string;
  token?: string;
}> | null {
  if (!config.http_proxy) return null;
  const authorization = config.http_proxy_auth.trim();
  return {
    uri: config.http_proxy,
    ...(authorization
      ? {
          token: /^(?:basic|bearer)\s/iu.test(authorization)
            ? authorization
            : `Basic ${
                Buffer.from(authorization, "utf8")
                  .toString("base64")
              }`,
        }
      : {}),
  };
}

async function requestTelegramFile(
  http: TelegramHttpClient,
  config: TelegramConfig,
  filePath: string,
  signal: AbortSignal,
): Promise<TelegramHttpResponse> {
  signal.throwIfAborted();
  const encodedPath = filePath
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  let response: TelegramHttpResponse;
  try {
    response = await http.request({
      method: "GET",
      url: `${
        telegramApiBaseUrl(config)
      }/file/bot${config.bot_token}/${encodedPath}`,
      headers: {},
      responseType: "bytes",
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw transportError("network_unreachable", true);
  }
  if (response.status === 401) {
    throw transportError("credential_invalid", false);
  }
  if (response.status === 403) {
    throw transportError("permission_denied", false);
  }
  if (response.status === 429) {
    throw transportError(
      "rate_limited",
      true,
      retryAfterMs(response, asRecord(response.body)),
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw transportError("network_unreachable", true);
  }
  return response;
}

function deliveryAddress(delivery: ChannelDelivery) {
  const fields = delivery.replyHandle?.publicFields ?? {};
  const chatId = fields.chatId
    ?? delivery.recipient.externalConversationId;
  const thread = fields.messageThreadId
    ?? delivery.recipient.externalThreadId;
  const reply = fields.replyToMessageId;
  return {
    chatId,
    messageThreadId: numericId(thread),
    replyToMessageId: numericId(reply),
  };
}

function sendResult(value: unknown, sentAt: Date): SendResult {
  const result = asRecord(value);
  const messageId = primitiveId(result.message_id);
  if (!messageId) {
    throw transportError("response_invalid", false);
  }
  return {
    externalMessageId: messageId,
    sentAt,
    rawSummary: { ok: true },
  };
}

function telegramUpdateId(value: unknown): number | null {
  const update = asRecord(value);
  return typeof update.update_id === "number"
    && Number.isSafeInteger(update.update_id)
    && update.update_id >= 0
    ? update.update_id
    : null;
}

function withQuery(
  endpoint: string,
  values: Readonly<Record<string, unknown>>,
): string {
  const url = new URL(endpoint);
  for (const [name, value] of Object.entries(values)) {
    url.searchParams.set(
      name,
      Array.isArray(value) ? JSON.stringify(value) : String(value),
    );
  }
  return url.toString();
}

function retryAfterMs(
  response: TelegramHttpResponse,
  payload: Readonly<Record<string, unknown>>,
): number | undefined {
  const parameters = asRecord(payload.parameters);
  const seconds = positiveNumber(parameters.retry_after)
    ?? positiveNumber(response.headers?.["retry-after"]);
  return seconds === null ? undefined : Math.ceil(seconds * 1_000);
}

function positiveNumber(value: unknown): number | null {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number"
    && Number.isFinite(number)
    && number > 0
    ? number
    : null;
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
  return normalized.length > 0 ? normalized : null;
}

function numericId(value: string | undefined): number | null {
  if (!value || !/^-?\d+$/u.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function transportError(
  code: TelegramTransportErrorCode,
  retryable: boolean,
  retryAfterMs?: number,
): TelegramTransportError {
  return new TelegramTransportError({
    code,
    retryable,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

function escapeTelegramHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function safeTelegramFilePath(
  value: string | null,
): string | null {
  if (
    !value
    || value.startsWith("/")
    || value.includes("\\")
    || value.split("/").some((part) =>
      part.length === 0
      || part === "."
      || part === ".."
    )
  ) {
    return null;
  }
  return value;
}

function mimeFromName(fileName: string): string | null {
  const extension = fileName.split(".").at(-1)?.toLowerCase();
  switch (extension) {
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

function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    );
  }
  return null;
}

async function* oneChunk(
  bytes: Uint8Array,
): AsyncIterable<Uint8Array> {
  yield bytes;
}
import {
  ProxyAgent,
  type Dispatcher,
} from "undici";
