import { randomUUID } from "node:crypto";

import {
  createWechatHeaders,
} from "./auth";
import {
  normalizeWechatBaseUrl,
} from "./config";

const CHANNEL_VERSION = "2.0.1";
const DEFAULT_TIMEOUT_MS = 15_000;
const LONG_POLL_TIMEOUT_MS = 45_000;
const QR_POLL_TIMEOUT_MS = 60_000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;

export class WechatTransportError extends Error {
  readonly code:
    | "credential_invalid"
    | "permission_denied"
    | "network_unreachable"
    | "rate_limited"
    | "runtime_prerequisite_missing"
    | "unknown";
  readonly retryable: boolean;
  readonly detail: string;
  readonly retryAfterMs?: number;

  constructor(input: Readonly<{
    code: WechatTransportError["code"];
    retryable: boolean;
    detail: string;
    retryAfterMs?: number;
  }>) {
    super(input.detail);
    this.name = "WechatTransportError";
    this.code = input.code;
    this.retryable = input.retryable;
    this.detail = input.detail;
    this.retryAfterMs = input.retryAfterMs;
  }
}

export type WechatInboundMessage =
  Readonly<Record<string, unknown>>;

export type WechatUpdatesResponse = Readonly<{
  ret: number;
  errcode?: number;
  errmsg?: string;
  msgs: readonly WechatInboundMessage[];
  get_updates_buf: string;
  longpolling_timeout_ms?: number;
}>;

export type WechatIlinkClientPort = Readonly<{
  start(): Promise<void>;
  stop(): Promise<void>;
  getQrCode(signal?: AbortSignal): Promise<
    Readonly<Record<string, unknown>>
  >;
  getQrCodeStatus(
    qrcode: string,
    signal?: AbortSignal,
  ): Promise<Readonly<Record<string, unknown>>>;
  getUpdates(
    cursor: string,
    signal?: AbortSignal,
  ): Promise<WechatUpdatesResponse>;
  sendText(input: Readonly<{
    toUserId: string;
    text: string;
    contextToken: string;
    signal?: AbortSignal;
  }>): Promise<Readonly<Record<string, unknown>>>;
  getConfig(input: Readonly<{
    ilinkUserId: string;
    contextToken: string;
    signal?: AbortSignal;
  }>): Promise<Readonly<Record<string, unknown>>>;
  sendTyping(input: Readonly<{
    toUserId: string;
    typingTicket: string;
    status: 1 | 2;
    signal?: AbortSignal;
  }>): Promise<Readonly<Record<string, unknown>>>;
}>;

export type WechatIlinkClientFactory = (
  config: Readonly<{
    botToken: string;
    baseUrl: string;
  }>,
) => WechatIlinkClientPort;

export function createWechatIlinkClient(
  input: Readonly<{
    botToken?: string;
    baseUrl: string;
    fetchImpl?: typeof fetch;
    randomUint32?: () => number;
    nextClientId?: () => string;
  }>,
): WechatIlinkClientPort {
  const botToken = input.botToken?.trim() ?? "";
  const baseUrl = normalizeWechatBaseUrl(input.baseUrl);
  const fetchImpl = input.fetchImpl ?? fetch;
  const randomUint32 = input.randomUint32;
  const nextClientId = input.nextClientId ?? randomUUID;
  let stopped = false;

  return {
    async start() {
      stopped = false;
    },

    async stop() {
      stopped = true;
    },

    getQrCode(signal) {
      return get(
        "/ilink/bot/get_bot_qrcode?bot_type=3",
        signal,
      );
    },

    getQrCodeStatus(qrcode, signal) {
      if (!safeToken(qrcode)) {
        return Promise.reject(
          new Error("wechat_qrcode_invalid"),
        );
      }
      return get(
        `/ilink/bot/get_qrcode_status?qrcode=${
          encodeURIComponent(qrcode)
        }`,
        signal,
        QR_POLL_TIMEOUT_MS,
      );
    },

    async getUpdates(cursor, signal) {
      const response = await post(
        "/ilink/bot/getupdates",
        {
          get_updates_buf: safeCursor(cursor),
          base_info: {
            channel_version: CHANNEL_VERSION,
          },
        },
        signal,
        LONG_POLL_TIMEOUT_MS,
        false,
      );
      return normalizeUpdates(response);
    },

    sendText({ toUserId, text, contextToken, signal }) {
      if (
        !safeIdentifier(toUserId)
        || !text
        || !safeToken(contextToken)
      ) {
        return Promise.reject(
          new Error("wechat_send_input_invalid"),
        );
      }
      return post(
        "/ilink/bot/sendmessage",
        {
          msg: {
            from_user_id: "",
            to_user_id: toUserId,
            client_id: nextClientId(),
            message_type: 2,
            message_state: 2,
            context_token: contextToken,
            item_list: [{
              type: 1,
              text_item: { text },
            }],
          },
          base_info: {
            channel_version: CHANNEL_VERSION,
          },
        },
        signal,
        DEFAULT_TIMEOUT_MS,
        true,
      );
    },

    getConfig({
      ilinkUserId,
      contextToken,
      signal,
    }) {
      return post(
        "/ilink/bot/getconfig",
        {
          ilink_user_id: ilinkUserId,
          context_token: contextToken,
          base_info: {
            channel_version: CHANNEL_VERSION,
          },
        },
        signal,
        DEFAULT_TIMEOUT_MS,
        false,
      );
    },

    sendTyping({
      toUserId,
      typingTicket,
      status,
      signal,
    }) {
      return post(
        "/ilink/bot/sendtyping",
        {
          ilink_user_id: toUserId,
          typing_ticket: typingTicket,
          status,
          base_info: {
            channel_version: CHANNEL_VERSION,
          },
        },
        signal,
        DEFAULT_TIMEOUT_MS,
        false,
      );
    },
  };

  async function get(
    pathname: string,
    signal?: AbortSignal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    return request(
      pathname,
      { method: "GET" },
      signal,
      timeoutMs,
      false,
    );
  }

  async function post(
    pathname: string,
    body: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    outcomeSensitive: boolean,
  ) {
    return request(
      pathname,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      signal,
      timeoutMs,
      outcomeSensitive,
    );
  }

  async function request(
    pathname: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    outcomeSensitive: boolean,
  ): Promise<Readonly<Record<string, unknown>>> {
    if (stopped) {
      throw new WechatTransportError({
        code: "network_unreachable",
        retryable: true,
        detail: "wechat_client_stopped",
      });
    }
    signal?.throwIfAborted();
    const lifecycle = linkedSignal(signal, timeoutMs);
    let attempted = false;
    try {
      const responsePromise = fetchImpl(
        `${baseUrl}${pathname}`,
        {
          ...init,
          headers: createWechatHeaders(
            botToken,
            randomUint32,
          ),
          redirect: "error",
          signal: lifecycle.signal,
        },
      );
      attempted = true;
      const response = await responsePromise;
      if (!response.ok || response.redirected) {
        throw httpError(response);
      }
      const text = await readBoundedText(
        response,
        MAX_JSON_BYTES,
      );
      const parsed = JSON.parse(text) as unknown;
      if (!isRecord(parsed)) {
        throw new Error("wechat_response_invalid");
      }
      return parsed;
    } catch (error) {
      if (error instanceof WechatTransportError) {
        if (
          outcomeSensitive
          && attempted
          && error.code === "network_unreachable"
        ) {
          throw new WechatTransportError({
            code: "unknown",
            retryable: false,
            detail: "delivery_outcome_unknown",
          });
        }
        throw error;
      }
      if (outcomeSensitive && attempted) {
        throw new WechatTransportError({
          code: "unknown",
          retryable: false,
          detail: "delivery_outcome_unknown",
        });
      }
      if (signal?.aborted) throw signal.reason ?? error;
      throw mapWechatError(error);
    } finally {
      lifecycle.dispose();
    }
  }
}

export function mapWechatError(
  error: unknown,
): WechatTransportError {
  if (error instanceof WechatTransportError) return error;
  return new WechatTransportError({
    code: "network_unreachable",
    retryable: true,
    detail: "wechat_network_unreachable",
  });
}

function httpError(response: Response): WechatTransportError {
  const status = response.status;
  return new WechatTransportError({
    code: status === 401
      ? "credential_invalid"
      : status === 403
        ? "permission_denied"
        : status === 429
          ? "rate_limited"
          : status >= 500
            ? "network_unreachable"
            : "unknown",
    retryable: status === 429 || status >= 500,
    detail: `wechat_http_${status}`,
    ...(retryAfterMs(response)
      ? { retryAfterMs: retryAfterMs(response) }
      : {}),
  });
}

function retryAfterMs(response: Response): number | undefined {
  const value = Number(response.headers.get("retry-after"));
  return Number.isFinite(value) && value >= 0
    ? value * 1_000
    : undefined;
}

function normalizeUpdates(
  input: Readonly<Record<string, unknown>>,
): WechatUpdatesResponse {
  return {
    ret: integer(input.ret, -999),
    errcode: integer(input.errcode, 0),
    errmsg: string(input.errmsg),
    msgs: Array.isArray(input.msgs)
      ? input.msgs.filter(isRecord)
      : [],
    get_updates_buf: safeCursor(
      string(input.get_updates_buf),
    ),
    longpolling_timeout_ms: integer(
      input.longpolling_timeout_ms,
      0,
    ),
  };
}

function linkedSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error("wechat_request_timeout"));
  }, timeoutMs);
  timer.unref?.();
  const onAbort = () =>
    controller.abort(parent?.reason);
  parent?.addEventListener("abort", onAbort, {
    once: true,
  });
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

async function readBoundedText(
  response: Response,
  limit: number,
): Promise<string> {
  if (!response.body) {
    throw new Error("wechat_response_body_missing");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        const error = new WechatTransportError({
          code: "unknown",
          retryable: false,
          detail: "wechat_response_too_large",
        });
        await reader.cancel(error).catch(() => undefined);
        throw error;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function safeCursor(value: string): string {
  if (
    value.length > 128 * 1024
    || /[\u0000]/u.test(value)
  ) {
    throw new Error("wechat_cursor_invalid");
  }
  return value;
}

function safeToken(value: string): boolean {
  return value.length > 0
    && value.length <= 128 * 1024
    && !/[\u0000]/u.test(value);
}

function safeIdentifier(value: string): boolean {
  return value.length > 0
    && value.length <= 512
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function integer(value: unknown, fallback: number): number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    ? value
    : fallback;
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value);
}
