import { randomUUID } from "node:crypto";

import WebSocket from "ws";

import type {
  AdapterDependencies,
} from "@/server/channels/runtime/types";

import type { QQConfig } from "./config";

const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const API_BASE = "https://api.sgroup.qq.com";
const MESSAGE_EVENTS = new Set([
  "C2C_MESSAGE_CREATE",
  "GROUP_AT_MESSAGE_CREATE",
  "AT_MESSAGE_CREATE",
  "DIRECT_MESSAGE_CREATE",
]);
const INTENTS = (1 << 30) | (1 << 12) | (1 << 25);
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];

type Http = NonNullable<AdapterDependencies["http"]>;

export type QQResumeState = Readonly<{
  sessionId: string;
  sequence: number;
}>;

export type QQGatewayState = Readonly<{
  sessionId: string | null;
  sequence: number | null;
}>;

export type QQConnectionState = Readonly<{
  sessionId: string | null;
  sequence: number | null;
  reconnectAttempts: number;
  exhausted: boolean;
}>;

export type QQClientPort = Readonly<{
  start(input: Readonly<{
    signal: AbortSignal;
    resumeState?: QQResumeState;
    onEvent(payload: unknown): Promise<void>;
    onState?(state: QQConnectionState): void;
    onError(error: Error): void;
    onReconnecting?(): void;
    onReconnected?(): void;
  }>): Promise<QQResumeState>;
  stop(): Promise<void>;
  sendMessage(input: Readonly<{
    messageType: "c2c" | "group" | "guild" | "dm";
    conversationId: string;
    senderId: string;
    messageId?: string;
    content: string;
    markdown: boolean;
    msgSeq: number;
    signal?: AbortSignal;
  }>): Promise<Readonly<{ messageId: string }>>;
}>;

export type QQClientFactory = (config: QQConfig) => QQClientPort;

export class QQTransportError extends Error {
  readonly code:
    | "credential_invalid"
    | "permission_denied"
    | "rate_limited"
    | "network_unreachable"
    | "response_invalid";
  readonly detail: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(input: Readonly<{
    code: QQTransportError["code"];
    detail?: string;
    retryable: boolean;
    retryAfterMs?: number;
  }>) {
    super(input.code);
    this.name = "QQTransportError";
    this.code = input.code;
    this.detail = input.detail ?? input.code;
    this.retryable = input.retryable;
    this.retryAfterMs = input.retryAfterMs;
  }
}

export function reduceQQGatewayFrame(
  current: QQGatewayState,
  input: unknown,
  accessToken: string,
) {
  const frame = asRecord(input);
  const sequence = safeSequence(frame.s) ?? current.sequence;
  let state: QQGatewayState = {
    sessionId: current.sessionId,
    sequence,
  };
  const op = Number(frame.op);
  const outbound: Array<Readonly<Record<string, unknown>>> = [];
  let ready = false;
  let event: unknown;
  let reconnect = false;
  let refreshToken = false;
  let heartbeatIntervalMs: number | undefined;
  let heartbeatAcknowledged = false;

  if (op === 10) {
    const interval = Number(asRecord(frame.d).heartbeat_interval);
    heartbeatIntervalMs = Number.isFinite(interval) && interval >= 1_000
      ? interval
      : 45_000;
    outbound.push(
      state.sessionId && state.sequence !== null
        ? {
            op: 6,
            d: {
              token: `QQBot ${accessToken}`,
              session_id: state.sessionId,
              seq: state.sequence,
            },
          }
        : {
            op: 2,
            d: {
              token: `QQBot ${accessToken}`,
              intents: INTENTS,
              shard: [0, 1],
            },
          },
    );
  } else if (op === 0) {
    const type = readId(frame.t);
    if (type === "READY") {
      const sessionId = readId(asRecord(frame.d).session_id);
      if (sessionId) {
        state = { ...state, sessionId };
        ready = true;
      }
    } else if (type === "RESUMED") {
      ready = Boolean(state.sessionId && state.sequence !== null);
    } else if (type && MESSAGE_EVENTS.has(type)) {
      event = {
        frame,
        ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      };
    }
  } else if (op === 7) {
    reconnect = true;
  } else if (op === 9) {
    reconnect = true;
    if (frame.d !== true) {
      state = { sessionId: null, sequence: null };
      refreshToken = true;
    }
  } else if (op === 11) {
    heartbeatAcknowledged = true;
  }

  return {
    state,
    outbound,
    ...(ready ? { ready } : {}),
    ...(event ? { event } : {}),
    ...(reconnect ? { reconnect } : {}),
    ...(refreshToken ? { refreshToken } : {}),
    ...(heartbeatIntervalMs !== undefined
      ? { heartbeatIntervalMs }
      : {}),
    ...(heartbeatAcknowledged
      ? { heartbeatAcknowledged }
      : {}),
  };
}

export function heartbeatFrame(
  state: QQGatewayState,
): Readonly<{ op: 1; d: number | null }> {
  return { op: 1, d: state.sequence };
}

export function createQQGatewayClient(
  config: QQConfig,
  dependencies: Readonly<{
    http?: Http;
    socketFactory?: (url: string) => WebSocket;
  }> = {},
): QQClientPort {
  const http = dependencies.http ?? defaultHttp();
  const socketFactory = dependencies.socketFactory
    ?? ((url: string) =>
      new WebSocket(url, {
        rejectUnauthorized: true,
        handshakeTimeout: 15_000,
        maxPayload: 2 * 1024 * 1024,
      }));
  const tokens = qqTokenCache(config, http);
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let callbacks: Parameters<QQClientPort["start"]>[0] | null = null;
  let state: QQGatewayState = {
    sessionId: null,
    sequence: null,
  };
  let reconnectAttempts = 0;
  let stopping = false;
  let started = false;
  let accessToken = "";

  return {
    async start(input) {
      if (started && state.sessionId && state.sequence !== null) {
        return {
          sessionId: state.sessionId,
          sequence: state.sequence,
        };
      }
      callbacks = input;
      stopping = false;
      state = input.resumeState
        ? {
            sessionId: input.resumeState.sessionId,
            sequence: input.resumeState.sequence,
          }
        : { sessionId: null, sequence: null };
      const readyState = await connect(true);
      started = true;
      return readyState;
    },
    async stop() {
      if (stopping) return;
      stopping = true;
      callbacks = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      reconnectTimer = null;
      heartbeatTimer = null;
      socket?.removeAllListeners();
      socket?.close();
      socket = null;
      tokens.clear();
      accessToken = "";
      reconnectAttempts = 0;
      started = false;
    },
    async sendMessage(input) {
      const token = await tokens.get(input.signal);
      const path = messagePath(input);
      const withSequence = input.messageType === "c2c"
        || input.messageType === "group";
      const body = messageBody(input, withSequence);
      try {
        const response = await apiRequest(
          http,
          token,
          "POST",
          path,
          body,
          input.signal,
        );
        return {
          messageId:
            readId(response.id ?? response.message_id)
            ?? `qq:${randomUUID()}`,
        };
      } catch (error) {
        if (
          !input.markdown
          || !(error instanceof QQTransportError)
          || error.detail !== "qq_markdown_not_allowed"
        ) {
          throw error;
        }
        const response = await apiRequest(
          http,
          token,
          "POST",
          path,
          messageBody({ ...input, markdown: false }, withSequence),
          input.signal,
        );
        return {
          messageId:
            readId(response.id ?? response.message_id)
            ?? `qq:${randomUUID()}`,
        };
      }
    },
  };

  async function connect(initial: boolean): Promise<QQResumeState> {
    const activeCallbacks = callbacks;
    if (!activeCallbacks) {
      throw new Error("qq_gateway_not_started");
    }
    activeCallbacks.signal.throwIfAborted();
    accessToken = await tokens.get(activeCallbacks.signal);
    const gateway = await loadGateway(
      http,
      accessToken,
      activeCallbacks.signal,
    );
    return new Promise((resolve, reject) => {
      const active = socketFactory(gateway);
      socket = active;
      let settled = false;
      const timeout = setTimeout(() => {
        finish(new QQTransportError({
          code: "network_unreachable",
          retryable: true,
        }));
        active.terminate();
      }, 20_000);
      timeout.unref?.();
      const abort = () => {
        finish(activeCallbacks.signal.reason);
        active.close();
      };
      activeCallbacks.signal.addEventListener(
        "abort",
        abort,
        { once: true },
      );
      const cleanupWaiter = () => {
        clearTimeout(timeout);
        activeCallbacks.signal.removeEventListener("abort", abort);
      };
      const finish = (
        error?: unknown,
        readyState?: QQResumeState,
      ) => {
        if (settled) return;
        settled = true;
        cleanupWaiter();
        if (error) {
          reject(normalizeError(error));
        } else if (readyState) {
          resolve(readyState);
        }
      };
      active.on("message", (data) => {
        const frame = parseGatewayFrame(data);
        if (!frame) return;
        const reduced = reduceQQGatewayFrame(
          state,
          frame,
          accessToken,
        );
        state = reduced.state;
        for (const outbound of reduced.outbound) {
          safeSocketSend(active, outbound);
        }
        if (reduced.heartbeatIntervalMs) {
          installHeartbeat(active, reduced.heartbeatIntervalMs);
        }
        notifyState(false);
        if (
          reduced.ready
          && state.sessionId
          && state.sequence !== null
        ) {
          reconnectAttempts = 0;
          const readyState = {
            sessionId: state.sessionId,
            sequence: state.sequence,
          };
          finish(undefined, readyState);
          if (!initial) activeCallbacks.onReconnected?.();
        }
        if (reduced.event) {
          void activeCallbacks.onEvent(reduced.event)
            .catch((error: unknown) => {
              activeCallbacks.onError(normalizeError(error));
            });
        }
        if (reduced.refreshToken) tokens.clear();
        if (reduced.reconnect) active.close();
      });
      active.once("error", () => {
        finish(new QQTransportError({
          code: "network_unreachable",
          retryable: true,
        }));
        active.terminate();
      });
      active.once("close", () => {
        cleanupWaiter();
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        if (socket === active) socket = null;
        if (!settled) {
          finish(new QQTransportError({
            code: "network_unreachable",
            retryable: true,
          }));
        }
        if (!stopping) {
          scheduleReconnect();
        }
      });
    });
  }

  function installHeartbeat(active: WebSocket, intervalMs: number) {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (active.readyState !== WebSocket.OPEN) return;
      safeSocketSend(active, heartbeatFrame(state));
    }, intervalMs);
    heartbeatTimer.unref?.();
  }

  function scheduleReconnect() {
    if (stopping || reconnectTimer) return;
    reconnectAttempts += 1;
    const maximum = config.max_reconnect_attempts;
    if (maximum !== -1 && reconnectAttempts >= maximum) {
      notifyState(true);
      return;
    }
    callbacks?.onReconnecting?.();
    notifyState(false);
    const delay = RECONNECT_DELAYS_MS[
      Math.min(reconnectAttempts - 1, RECONNECT_DELAYS_MS.length - 1)
    ]!;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect(false).catch((error: unknown) => {
        callbacks?.onError(normalizeError(error));
        scheduleReconnect();
      });
    }, delay);
    reconnectTimer.unref?.();
  }

  function notifyState(exhausted: boolean) {
    callbacks?.onState?.({
      sessionId: state.sessionId,
      sequence: state.sequence,
      reconnectAttempts,
      exhausted,
    });
  }
}

export function createQQTokenCache(input: Readonly<{
  load(signal?: AbortSignal): Promise<Readonly<{
    token: string;
    expiresInSeconds: number;
  }>>;
  now?: () => Date;
}>) {
  const now = input.now ?? (() => new Date());
  let value: { token: string; expiresAt: number } | null = null;
  let loading: Promise<string> | null = null;
  return {
    async get(signal?: AbortSignal) {
      signal?.throwIfAborted();
      if (value && value.expiresAt - now().getTime() > 300_000) {
        return value.token;
      }
      if (loading) return loading;
      loading = input.load(signal).then((loaded) => {
        if (
          !loaded.token
          || !Number.isFinite(loaded.expiresInSeconds)
          || loaded.expiresInSeconds <= 0
        ) {
          throw new QQTransportError({
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

export function mapQQResponse(response: Readonly<{
  status: number;
  headers?: Readonly<Record<string, string>>;
  body?: unknown;
}>): Record<string, unknown> {
  if (response.status < 200 || response.status >= 300) {
    throw mapQQError(response);
  }
  const body = asRecord(response.body);
  const code = readId(body.code);
  if (code && code !== "0") throw mapQQError(response);
  return body;
}

export function createQQAttachmentFetcher(
  _config: QQConfig,
  http?: Http,
) {
  const client = http ?? defaultHttp();
  const cache = new Map<string, Uint8Array>();
  return {
    async inspect(descriptor: AttachmentDescriptor) {
      requireQQAttachmentUrl(descriptor.source.url);
      if (
        !descriptor.fileName
        || !descriptor.mimeType
        || descriptor.sizeBytes === null
      ) {
        throw new Error("qq_attachment_metadata_incomplete");
      }
      return {
        fileName: descriptor.fileName,
        mimeType: descriptor.mimeType,
        sizeBytes: descriptor.sizeBytes,
      };
    },
    async download(
      descriptor: AttachmentDescriptor,
      signal = new AbortController().signal,
    ) {
      const existing = cache.get(descriptor.externalAttachmentId);
      if (existing) return singleChunk(existing);
      const response = await client.request({
        method: "GET",
        url: requireQQAttachmentUrl(descriptor.source.url),
        headers: {},
        responseType: "bytes",
        signal,
      });
      const bytes = toBytes(response.body);
      if (
        response.status < 200
        || response.status >= 300
        || !bytes
      ) {
        throw new Error("qq_attachment_download_failed");
      }
      cache.set(descriptor.externalAttachmentId, bytes);
      return singleChunk(bytes);
    },
  };
}

type AttachmentDescriptor = Readonly<{
  externalAttachmentId: string;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  source: Readonly<Record<string, string>>;
}>;

function qqTokenCache(config: QQConfig, http: Http) {
  return createQQTokenCache({
    load: async (signal) => {
      const response = await http.request({
        method: "POST",
        url: TOKEN_URL,
        headers: { "content-type": "application/json" },
        body: {
          appId: config.app_id,
          clientSecret: config.client_secret,
        },
        signal,
      });
      const body = mapQQResponse(response);
      return {
        token: requireId(
          readId(body.access_token),
          "qq_access_token_missing",
        ),
        expiresInSeconds: Number(body.expires_in ?? 7_200),
      };
    },
  });
}

async function loadGateway(
  http: Http,
  token: string,
  signal: AbortSignal,
) {
  const body = await apiRequest(
    http,
    token,
    "GET",
    "/gateway",
    undefined,
    signal,
  );
  const url = safeGatewayUrl(body.url);
  if (!url) {
    throw new QQTransportError({
      code: "response_invalid",
      retryable: false,
    });
  }
  return url;
}

async function apiRequest(
  http: Http,
  token: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
) {
  return mapQQResponse(await http.request({
    method,
    url: `${API_BASE}${path}`,
    headers: {
      authorization: `QQBot ${token}`,
      "content-type": "application/json",
    },
    body,
    signal,
  }));
}

function messagePath(
  input: Parameters<QQClientPort["sendMessage"]>[0],
): string {
  const id = encodeURIComponent(input.conversationId);
  switch (input.messageType) {
    case "group":
      return `/v2/groups/${id}/messages`;
    case "guild":
      return `/channels/${id}/messages`;
    case "dm":
      return `/dms/${id}/messages`;
    case "c2c":
      return `/v2/users/${id}/messages`;
  }
}

function messageBody(
  input: Parameters<QQClientPort["sendMessage"]>[0],
  withSequence: boolean,
) {
  return {
    ...(input.markdown
      ? { markdown: { content: input.content } }
      : { content: input.content }),
    ...(withSequence
      ? {
          msg_type: input.markdown ? 2 : 0,
          msg_seq: input.msgSeq,
        }
      : {}),
    ...(input.messageId ? { msg_id: input.messageId } : {}),
  };
}

function mapQQError(response: Readonly<{
  status: number;
  headers?: Readonly<Record<string, string>>;
  body?: unknown;
}>): QQTransportError {
  const body = asRecord(response.body);
  const combined = String(
    `${body.code ?? ""} ${body.message ?? body.msg ?? ""}`,
  ).toLowerCase();
  if (
    /markdown|msg.?type|50056|40034012|不允许发送原生/.test(combined)
    && response.status >= 400
    && response.status < 500
  ) {
    return new QQTransportError({
      code: "response_invalid",
      detail: "qq_markdown_not_allowed",
      retryable: false,
    });
  }
  if (
    response.status === 401
    || /invalid.*(?:token|secret)|11251|11254/.test(combined)
  ) {
    return new QQTransportError({
      code: "credential_invalid",
      retryable: false,
    });
  }
  if (
    response.status === 403
    || /permission|intent|forbidden|11281/.test(combined)
  ) {
    return new QQTransportError({
      code: "permission_denied",
      detail: /intent/.test(combined)
        ? "qq_intent_not_allowed"
        : "permission_denied",
      retryable: false,
    });
  }
  if (response.status === 429 || /rate|frequency|304023/.test(combined)) {
    const seconds = Number(
      response.headers?.["retry-after"]
      ?? response.headers?.["Retry-After"],
    );
    return new QQTransportError({
      code: "rate_limited",
      retryable: true,
      ...(Number.isFinite(seconds) && seconds > 0
        ? { retryAfterMs: Math.ceil(seconds * 1_000) }
        : {}),
    });
  }
  return new QQTransportError({
    code: response.status >= 500
      ? "network_unreachable"
      : "response_invalid",
    retryable: response.status >= 500,
  });
}

function safeGatewayUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 8_192) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "wss:"
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && (
        host === "qq.com"
        || host.endsWith(".qq.com")
      )
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function requireQQAttachmentUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 16_384) {
    throw new Error("qq_attachment_url_invalid");
  }
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || !(
        host === "qq.com"
        || host.endsWith(".qq.com")
        || host === "qq.com.cn"
        || host.endsWith(".qq.com.cn")
        || host === "qpic.cn"
        || host.endsWith(".qpic.cn")
        || host === "gtimg.cn"
        || host.endsWith(".gtimg.cn")
      )
    ) {
      throw new Error("qq_attachment_url_invalid");
    }
    return url.toString();
  } catch {
    throw new Error("qq_attachment_url_invalid");
  }
}

function parseGatewayFrame(value: WebSocket.RawData): unknown | null {
  const text = typeof value === "string"
    ? value
    : Buffer.isBuffer(value)
      ? value.toString("utf8")
      : Array.isArray(value)
        ? Buffer.concat(value).toString("utf8")
        : Buffer.from(value).toString("utf8");
  if (!text || text.length > 2 * 1024 * 1024) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return Object.keys(asRecord(parsed)).length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function safeSocketSend(
  socket: WebSocket,
  value: Readonly<Record<string, unknown>>,
) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(value));
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
        redirect: "error",
      });
      if (input.responseType === "bytes") {
        return {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body: new Uint8Array(await response.arrayBuffer()),
        };
      }
      const text = await response.text();
      let body: unknown = {};
      if (text) {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          body = {};
        }
      }
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body,
      };
    },
  };
}

function normalizeError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new QQTransportError({
        code: "network_unreachable",
        retryable: true,
      });
}

function safeSequence(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0
    ? numeric
    : null;
}

function readId(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const id = String(value).trim();
  return id && id.length <= 16_384 ? id : null;
}

function requireId(value: string | null, code: string): string {
  if (!value) throw new Error(code);
  return value;
}

function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    );
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

async function* singleChunk(bytes: Uint8Array) {
  yield bytes;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
