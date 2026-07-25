import {
  Domain,
  EventDispatcher,
  WSClient,
} from "@larksuiteoapi/node-sdk";
import { randomUUID } from "node:crypto";

import type {
  AdapterDependencies,
} from "@/server/channels/runtime/types";

import type { FeishuConfig } from "./config";

export class FeishuTransportError extends Error {
  readonly code:
    | "credential_invalid"
    | "permission_denied"
    | "rate_limited"
    | "network_unreachable"
    | "response_invalid";
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(input: Readonly<{
    code: FeishuTransportError["code"];
    retryable: boolean;
    retryAfterMs?: number;
  }>) {
    super(input.code);
    this.name = "FeishuTransportError";
    this.code = input.code;
    this.retryable = input.retryable;
    this.retryAfterMs = input.retryAfterMs;
  }
}

export type FeishuClientPort = Readonly<{
  start(input: Readonly<{
    signal: AbortSignal;
    onEvent(payload: unknown): Promise<void>;
    onError(error: Error): void;
  }>): Promise<Readonly<{ botOpenId: string }>>;
  stop(): Promise<void>;
  send(input: Readonly<{
    chatId: string;
    replyToMessageId?: string;
    text: string;
    streaming: boolean;
  }>): Promise<Readonly<{
    messageId: string;
    cardId?: string;
  }>>;
  updateCard(input: Readonly<{
    messageId: string;
    cardId?: string;
    text: string;
    sequence: number;
    final: boolean;
  }>): Promise<void>;
}>;

export type FeishuClientFactory = (
  config: FeishuConfig,
) => FeishuClientPort;

export function feishuBaseUrl(domain: "feishu" | "lark"): string {
  return domain === "lark"
    ? "https://open.larksuite.com/open-apis"
    : "https://open.feishu.cn/open-apis";
}

export function createTenantTokenCache(input: Readonly<{
  load(): Promise<Readonly<{
    token: string;
    expiresInSeconds: number;
  }>>;
  now?: () => Date;
}>) {
  const now = input.now ?? (() => new Date());
  let value: { token: string; expiresAt: number } | null = null;
  let loading: Promise<string> | null = null;
  return {
    async get(): Promise<string> {
      if (value && value.expiresAt - now().getTime() > 300_000) {
        return value.token;
      }
      if (loading) return loading;
      loading = input.load().then((loaded) => {
        if (!loaded.token || loaded.expiresInSeconds <= 0) {
          throw new FeishuTransportError({
            code: "response_invalid",
            retryable: false,
          });
        }
        value = {
          token: loaded.token,
          expiresAt:
            now().getTime() + loaded.expiresInSeconds * 1_000,
        };
        return loaded.token;
      }).finally(() => {
        loading = null;
      });
      return loading;
    },
    clear() {
      value = null;
    },
  };
}

export function createFeishuSdkClient(
  config: FeishuConfig,
  dependencies: Readonly<{ http?: Http }> = {},
): FeishuClientPort {
  const http = dependencies.http ?? defaultHttp();
  const tokenCache = tenantTokenCache(config, http);
  const cards = new Map<string, string>();
  let ws: WSClient | null = null;
  let stopped = false;
  let detachAbort: (() => void) | null = null;
  return {
    async start(input) {
      const bot = await apiJson(
        config,
        http,
        tokenCache,
        "GET",
        "/bot/v3/info",
        undefined,
        input.signal,
      );
      const botOpenId = requireId(
        primitiveId(asRecord(bot.bot).open_id),
        "feishu_bot_open_id_missing",
      );
      const dispatcher = new EventDispatcher({
        encryptKey: config.encrypt_key || undefined,
        verificationToken:
          config.verification_token || undefined,
      });
      dispatcher.register({
        "im.message.receive_v1": async (event: unknown) => {
          await input.onEvent(event);
        },
      });
      let readySettled = false;
      let resolveReady!: () => void;
      let rejectReady!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      ws = new WSClient({
        appId: config.app_id,
        appSecret: config.app_secret,
        domain: config.domain === "lark"
          ? Domain.Lark
          : Domain.Feishu,
        autoReconnect: true,
        handshakeTimeoutMs: 15_000,
        onReady: () => {
          if (readySettled) return;
          readySettled = true;
          resolveReady();
        },
        onError: (error) => {
          if (!readySettled) {
            readySettled = true;
            rejectReady(error);
            return;
          }
          input.onError(error);
        },
      });
      const onAbort = () => {
        void stop();
      };
      input.signal.addEventListener("abort", onAbort, { once: true });
      detachAbort = () =>
        input.signal.removeEventListener("abort", onAbort);
      await ws.start({ eventDispatcher: dispatcher });
      await waitForFeishuReady(ready, input.signal, 15_000);
      return { botOpenId };
    },
    stop,
    async send(input) {
      const signal = new AbortController().signal;
      let msgType = "text";
      let content = JSON.stringify({ text: input.text });
      let cardId: string | null = null;
      if (input.streaming) {
        try {
          const card = await apiJson(
            config,
            http,
            tokenCache,
            "POST",
            "/cardkit/v1/cards",
            {
              type: "card_json",
              data: JSON.stringify(streamingCard(input.text)),
            },
            signal,
          );
          cardId = primitiveId(asRecord(card.data).card_id)
            ?? primitiveId(card.card_id);
          if (cardId) {
            msgType = "interactive";
            content = JSON.stringify({
              type: "card",
              data: { card_id: cardId },
            });
          }
        } catch (error) {
          if (
            error instanceof FeishuTransportError
            && error.code === "credential_invalid"
          ) {
            throw error;
          }
        }
      }
      const path = input.replyToMessageId
        ? `/im/v1/messages/${
            encodeURIComponent(input.replyToMessageId)
          }/reply`
        : "/im/v1/messages?receive_id_type=chat_id";
      const result = await apiJson(
        config,
        http,
        tokenCache,
        "POST",
        path,
        {
          ...(input.replyToMessageId
            ? {}
            : { receive_id: input.chatId }),
          msg_type: msgType,
          content,
        },
        signal,
      );
      const messageId = requireId(
        primitiveId(asRecord(result.data).message_id)
          ?? primitiveId(result.message_id),
        "feishu_message_id_missing",
      );
      if (cardId) cards.set(messageId, cardId);
      return {
        messageId,
        ...(cardId ? { cardId } : {}),
      };
    },
    async updateCard(input) {
      const cardId = input.cardId ?? cards.get(input.messageId);
      if (!cardId) return;
      const signal = new AbortController().signal;
      await apiJson(
        config,
        http,
        tokenCache,
        "PUT",
        `/cardkit/v1/cards/${encodeURIComponent(cardId)
        }/elements/streaming_content/content`,
        {
          content: input.text,
          sequence: input.sequence,
          uuid: randomUUID(),
        },
        signal,
      );
      if (input.final) {
        await apiJson(
          config,
          http,
          tokenCache,
          "PATCH",
          `/cardkit/v1/cards/${encodeURIComponent(cardId)}/settings`,
          {
            settings: JSON.stringify({
              config: {
                streaming_mode: false,
                summary: { content: input.text.slice(0, 80) || "✅" },
              },
            }),
            sequence: input.sequence + 1,
            uuid: randomUUID(),
          },
          signal,
        );
        cards.delete(input.messageId);
      }
    },
  };

  async function stop() {
    if (stopped) return;
    stopped = true;
    detachAbort?.();
    detachAbort = null;
    ws?.close({ force: true });
    ws = null;
    tokenCache.clear();
    cards.clear();
  }
}

export function mapFeishuResponse(response: Readonly<{
  status: number;
  headers?: Readonly<Record<string, string>>;
  body?: unknown;
}>): Record<string, unknown> {
  const body = asRecord(response.body);
  const code = Number(body.code ?? 0);
  if (response.status === 401 || [99991663, 99991664].includes(code)) {
    throw new FeishuTransportError({
      code: "credential_invalid",
      retryable: false,
    });
  }
  if (response.status === 403 || code === 99991672) {
    throw new FeishuTransportError({
      code: "permission_denied",
      retryable: false,
    });
  }
  if (response.status === 429 || code === 99991400) {
    const retryAfter = Number(
      response.headers?.["retry-after"]
      ?? response.headers?.["Retry-After"],
    );
    throw new FeishuTransportError({
      code: "rate_limited",
      retryable: true,
      ...(Number.isFinite(retryAfter) && retryAfter > 0
        ? { retryAfterMs: Math.ceil(retryAfter * 1_000) }
        : {}),
    });
  }
  if (
    response.status < 200
    || response.status >= 300
    || code !== 0
  ) {
    throw new FeishuTransportError({
      code: "response_invalid",
      retryable: false,
    });
  }
  return body;
}

export function createFeishuAttachmentFetcher(
  config: FeishuConfig,
  http?: NonNullable<AdapterDependencies["http"]>,
) {
  const client = http ?? defaultHttp();
  const tokens = tenantTokenCache(config, client);
  const cache = new Map<string, Uint8Array>();
  return {
    async inspect(descriptor: Readonly<{
      externalAttachmentId: string;
      fileName: string | null;
      mimeType: string | null;
      source: Readonly<Record<string, string>>;
    }>, signal = new AbortController().signal) {
      const bytes = await load(descriptor, signal);
      const fileName = descriptor.fileName
        ?? (descriptor.source.resourceType === "image"
          ? "feishu-image.jpg"
          : "feishu-file");
      const mimeType = descriptor.mimeType
        ?? mimeFromName(fileName);
      if (!mimeType) {
        throw new Error("feishu_attachment_mime_missing");
      }
      return { fileName, mimeType, sizeBytes: bytes.byteLength };
    },
    async download(descriptor: Readonly<{
      externalAttachmentId: string;
      fileName: string | null;
      mimeType: string | null;
      source: Readonly<Record<string, string>>;
    }>, signal = new AbortController().signal) {
      return singleChunk(await load(descriptor, signal));
    },
  };

  async function load(
    descriptor: Readonly<{
      externalAttachmentId: string;
      source: Readonly<Record<string, string>>;
    }>,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const existing = cache.get(descriptor.externalAttachmentId);
    if (existing) return existing;
    const messageId = requireId(
      descriptor.source.messageId,
      "feishu_message_id_missing",
    );
    const key = descriptor.source.fileKey
      ?? descriptor.source.imageKey;
    const token = await tokens.get();
    const response = await client.request({
      method: "GET",
      url: `${feishuBaseUrl(config.domain)}/im/v1/messages/${
        encodeURIComponent(messageId)
      }/resources/${encodeURIComponent(requireId(
        key,
        "feishu_resource_key_missing",
      ))}?type=${encodeURIComponent(
        descriptor.source.resourceType ?? "file",
      )}`,
      headers: { authorization: `Bearer ${token}` },
      responseType: "bytes",
      signal,
    });
    const bytes = toBytes(response.body);
    if (response.status !== 200 || !bytes) {
      throw new Error("feishu_attachment_download_failed");
    }
    cache.set(descriptor.externalAttachmentId, bytes);
    return bytes;
  }
}

type Http = NonNullable<AdapterDependencies["http"]>;

function tenantTokenCache(config: FeishuConfig, http: Http) {
  return createTenantTokenCache({
    load: async () => {
      const response = await http.request({
        method: "POST",
        url: `${feishuBaseUrl(config.domain)
        }/auth/v3/tenant_access_token/internal`,
        headers: { "content-type": "application/json" },
        body: {
          app_id: config.app_id,
          app_secret: config.app_secret,
        },
      });
      const body = mapFeishuResponse(response);
      return {
        token: requireId(
          primitiveId(body.tenant_access_token),
          "feishu_tenant_token_missing",
        ),
        expiresInSeconds: Number(body.expire ?? 7_200),
      };
    },
  });
}

async function apiJson(
  config: FeishuConfig,
  http: Http,
  tokens: ReturnType<typeof tenantTokenCache>,
  method: "GET" | "POST" | "PUT" | "PATCH",
  path: string,
  body: unknown,
  signal: AbortSignal,
) {
  const token = await tokens.get();
  const response = await http.request({
    method,
    url: `${feishuBaseUrl(config.domain)}${path}`,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(body !== undefined ? { body } : {}),
    signal,
  });
  return mapFeishuResponse(response);
}

function defaultHttp(): Http {
  return {
    async request(input) {
      const response = await fetch(input.url, {
        method: input.method,
        headers: input.headers,
        body: input.body === undefined
          ? undefined
          : JSON.stringify(input.body),
        signal: input.signal,
      });
      return {
        status: response.status,
        body: input.responseType === "bytes"
          ? new Uint8Array(await response.arrayBuffer())
          : await response.json(),
      };
    },
  };
}

function streamingCard(text: string) {
  return {
    schema: "2.0",
    config: { streaming_mode: true },
    body: {
      elements: [{
        tag: "markdown",
        element_id: "streaming_content",
        content: text,
      }],
    },
  };
}

function mimeFromName(name: string): string | null {
  const ext = name.split(".").at(-1)?.toLowerCase();
  return ext === "txt" ? "text/plain"
    : ext === "pdf" ? "application/pdf"
      : ["jpg", "jpeg"].includes(ext ?? "") ? "image/jpeg"
        : ext === "png" ? "image/png"
          : ext === "webp" ? "image/webp"
            : ext === "md" ? "text/markdown"
              : ext === "json" ? "application/json"
                : ext === "csv" ? "text/csv"
                  : null;
}

function primitiveId(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const id = String(value).trim();
  return id && id.length <= 1_024 ? id : null;
}
function requireId(value: string | null | undefined, code: string) {
  if (!value) throw new Error(code);
  return value;
}
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
function toBytes(value: unknown): Uint8Array | null {
  return ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : null;
}
async function* singleChunk(value: Uint8Array) {
  yield value;
}

function waitForFeishuReady(
  ready: Promise<void>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new FeishuTransportError({
        code: "network_unreachable",
        retryable: true,
      }));
    }, timeoutMs);
    timer.unref?.();
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    ready.then(
      () => {
        cleanup();
        resolve();
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
    function cleanup() {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  });
}
