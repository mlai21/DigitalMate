import { hostname as systemHostname } from "node:os";

import WebSocket from "ws";

import type { AgentScope } from "@/server/agents/types";
import {
  ATTACHMENT_LIMITS,
} from "@/server/attachments/types";
import type {
  InboundAttachmentDescriptor,
} from "@/server/channels/runtime/types";
import type {
  InboundAttachmentFetcher,
} from "@/server/channels/runtime/attachment-ingress";

import { generateXiaoYiAuthHeaders } from "./auth";
import type { XiaoYiConfig } from "./config";
import { safeXiaoYiMediaUri } from "./protocol";

export type XiaoYiServerName = "primary" | "backup";

export const XIAOYI_ENDPOINTS = Object.freeze({
  primary:
    "wss://hag.cloud.huawei.com/openclaw/v1/ws/link",
  backup:
    "wss://116.63.174.231/openclaw/v1/ws/link",
} satisfies Record<XiaoYiServerName, string>);

export const XIAOYI_HEARTBEAT_INTERVAL_MS = 30_000;
export const XIAOYI_RECONNECT_DELAYS_MS = Object.freeze([
  1_000,
  2_000,
  5_000,
  10_000,
  30_000,
  60_000,
]);
export const XIAOYI_MAX_RECONNECT_ATTEMPTS = 50;
const CONNECTION_TIMEOUT_MS = 30_000;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;

export class XiaoYiTransportError extends Error {
  readonly code:
    | "credential_invalid"
    | "permission_denied"
    | "network_unreachable"
    | "rate_limited"
    | "runtime_prerequisite_missing"
    | "unknown";
  readonly detail: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(input: Readonly<{
    code: XiaoYiTransportError["code"];
    detail: string;
    retryable: boolean;
    retryAfterMs?: number;
  }>) {
    super(input.code);
    this.name = "XiaoYiTransportError";
    this.code = input.code;
    this.detail = input.detail;
    this.retryable = input.retryable;
    this.retryAfterMs = input.retryAfterMs;
  }
}

export type XiaoYiClientStartInput = Readonly<{
  signal: AbortSignal;
  config: XiaoYiConfig;
  onMessage(
    payload: unknown,
    serverName: XiaoYiServerName,
  ): Promise<void>;
  onServerState(
    serverName: XiaoYiServerName,
    connected: boolean,
  ): void;
  onReconnect(
    serverName: XiaoYiServerName,
    attempt: number,
    delayMs: number,
  ): void;
  onError(error: Error): void;
}>;

export type XiaoYiClientPort = Readonly<{
  start(input: XiaoYiClientStartInput): Promise<void>;
  stop(): Promise<void>;
  send(input: Readonly<{
    preferredServer: XiaoYiServerName;
    payload: Record<string, unknown>;
  }>): Promise<Readonly<{ serverName: XiaoYiServerName }>>;
}>;

export type XiaoYiClientFactory = (
  config: XiaoYiConfig,
) => XiaoYiClientPort;

export interface XiaoYiSocketLike {
  readonly readyState: number;
  on(
    event: string,
    listener: (...args: unknown[]) => void,
  ): this;
  once(
    event: string,
    listener: (...args: unknown[]) => void,
  ): this;
  removeAllListeners(event?: string): this;
  send(
    data: string,
    callback?: (error?: Error) => void,
  ): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export type XiaoYiSocketOptions = Readonly<{
  headers: Readonly<Record<string, string>>;
  handshakeTimeout: number;
  servername?: string;
}>;

export type XiaoYiSocketFactory = (
  url: string,
  options: XiaoYiSocketOptions,
) => XiaoYiSocketLike;

type Timer = ReturnType<typeof setTimeout>;
type Interval = ReturnType<typeof setInterval>;
type LinkState = {
  readonly serverName: XiaoYiServerName;
  readonly url: string;
  socket: XiaoYiSocketLike | null;
  connected: boolean;
  reconnectAttempts: number;
  reconnectTimer: Timer | null;
  heartbeatTimer: Interval | null;
  terminalError: XiaoYiTransportError | null;
  pendingFinish: ((connected: boolean) => void) | null;
};

export function createXiaoYiWebSocketClient(
  config: XiaoYiConfig,
  dependencies: Readonly<{
    socketFactory?: XiaoYiSocketFactory;
    now?: () => number;
    hostname?: () => string;
  }> = {},
): XiaoYiClientPort {
  const socketFactory =
    dependencies.socketFactory ?? defaultSocketFactory;
  const now = dependencies.now ?? Date.now;
  const hostname =
    dependencies.hostname ?? systemHostname;
  const links = new Map<XiaoYiServerName, LinkState>(
    (Object.keys(XIAOYI_ENDPOINTS) as XiaoYiServerName[])
      .map((serverName) => [
        serverName,
        {
          serverName,
          url: XIAOYI_ENDPOINTS[serverName],
          socket: null,
          connected: false,
          reconnectAttempts: 0,
          reconnectTimer: null,
          heartbeatTimer: null,
          terminalError: null,
          pendingFinish: null,
        },
      ]),
  );
  let input: XiaoYiClientStartInput | null = null;
  let started = false;
  let stopping = false;
  let stopPromise: Promise<void> | null = null;
  let detachAbort: (() => void) | null = null;

  return {
    async start(startInput) {
      if (started) return;
      startInput.signal.throwIfAborted();
      started = true;
      stopping = false;
      input = startInput;
      const onAbort = () => {
        void stopInternal();
      };
      startInput.signal.addEventListener(
        "abort",
        onAbort,
        { once: true },
      );
      detachAbort = () =>
        startInput.signal.removeEventListener(
          "abort",
          onAbort,
        );

      const results = await Promise.all(
        Array.from(links.values()).map((link) =>
          connect(link)
        ),
      );
      if (results.some(Boolean)) return;
      const terminalError = Array.from(links.values())
        .map((link) => link.terminalError)
        .find(
          (error): error is XiaoYiTransportError =>
            error !== null,
        );
      if (terminalError) {
        await stopInternal();
        throw terminalError;
      }
    },

    stop: stopInternal,

    async send(sendInput) {
      const ordered = sendInput.preferredServer === "backup"
        ? ["backup", "primary"] as const
        : ["primary", "backup"] as const;
      for (const serverName of ordered) {
        const link = links.get(serverName)!;
        if (
          !link.connected
          || link.socket?.readyState !== WebSocket.OPEN
        ) {
          continue;
        }
        try {
          await sendSocket(
            link.socket,
            JSON.stringify(sendInput.payload),
          );
          return { serverName };
        } catch (error) {
          input?.onError(mapXiaoYiError(error));
        }
      }
      throw new XiaoYiTransportError({
        code: "network_unreachable",
        detail: "xiaoyi_all_sockets_disconnected",
        retryable: true,
      });
    },
  };

  function connect(link: LinkState): Promise<boolean> {
    if (stopping || !input) return Promise.resolve(false);
    clearLinkTimers(link);
    link.socket?.removeAllListeners();
    link.socket = null;
    link.connected = false;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (connected: boolean) => {
        if (settled) return;
        settled = true;
        if (link.pendingFinish === finish) {
          link.pendingFinish = null;
        }
        resolve(connected);
      };
      link.pendingFinish = finish;
      const headers = generateXiaoYiAuthHeaders(
        config.ak,
        config.sk,
        config.agent_id,
        now(),
      );
      let socket: XiaoYiSocketLike;
      try {
        socket = socketFactory(
          link.url,
          {
            headers,
            handshakeTimeout: CONNECTION_TIMEOUT_MS,
            ...(link.serverName === "backup"
              ? { servername: "hag.cloud.huawei.com" }
              : {}),
          },
        );
      } catch (error) {
        const mapped = mapXiaoYiError(error);
        if (!mapped.retryable) {
          link.terminalError = mapped;
        }
        input?.onError(mapped);
        input?.onServerState(link.serverName, false);
        finish(false);
        if (!link.terminalError) scheduleReconnect(link);
        return;
      }
      link.socket = socket;
      link.terminalError = null;

      socket.once("open", () => {
        if (stopping || link.socket !== socket) {
          finish(false);
          return;
        }
        link.connected = true;
        link.reconnectAttempts = 0;
        input?.onServerState(link.serverName, true);
        try {
          sendInitialFrame(
            link,
            hostname(),
            config.agent_id,
          );
          startHeartbeat(link);
          finish(true);
        } catch (error) {
          input?.onError(mapXiaoYiError(error));
          finish(false);
          terminateSocket(socket);
        }
      });
      socket.on("message", (...args) => {
        const payload = parseSocketMessage(args[0], args[1]);
        if (payload === null) {
          input?.onError(new XiaoYiTransportError({
            code: "unknown",
            detail: "xiaoyi_frame_invalid",
            retryable: false,
          }));
          return;
        }
        void input?.onMessage(payload, link.serverName)
          .catch((error: unknown) => {
            input?.onError(mapXiaoYiError(error));
          });
      });
      socket.once("unexpected-response", (...args) => {
        const response = asRecord(args[1]);
        const mapped = mapXiaoYiError({
          statusCode: response.statusCode,
        });
        if (!mapped.retryable) {
          link.terminalError = mapped;
        }
        input?.onError(mapped);
        finish(false);
        terminateSocket(socket);
      });
      socket.once("error", (error) => {
        const mapped = mapXiaoYiError(error);
        if (!mapped.retryable) {
          link.terminalError = mapped;
        }
        input?.onError(mapped);
        finish(false);
        if (socket.readyState !== WebSocket.CLOSED) {
          terminateSocket(socket);
        }
      });
      socket.once("close", () => {
        const wasConnected = link.connected;
        link.connected = false;
        clearHeartbeat(link);
        if (link.socket === socket) {
          link.socket = null;
        }
        if (wasConnected || !stopping) {
          input?.onServerState(link.serverName, false);
        }
        finish(false);
        if (!link.terminalError) scheduleReconnect(link);
      });
    });
  }

  function startHeartbeat(link: LinkState): void {
    clearHeartbeat(link);
    link.heartbeatTimer = setInterval(() => {
      if (
        !link.connected
        || link.socket?.readyState !== WebSocket.OPEN
      ) {
        return;
      }
      try {
        link.socket.send(JSON.stringify({
          msgType: "heartbeat",
          agentId: config.agent_id,
          msgDetail: JSON.stringify({
            timestamp: now(),
          }),
        }));
      } catch (error) {
        input?.onError(mapXiaoYiError(error));
      }
    }, XIAOYI_HEARTBEAT_INTERVAL_MS);
    link.heartbeatTimer.unref?.();
  }

  function scheduleReconnect(link: LinkState): void {
    if (
      stopping
      || !started
      || link.reconnectTimer
      || link.reconnectAttempts
        >= XIAOYI_MAX_RECONNECT_ATTEMPTS
    ) {
      return;
    }
    const attempt = link.reconnectAttempts + 1;
    const delayMs = XIAOYI_RECONNECT_DELAYS_MS[
      Math.min(
        attempt - 1,
        XIAOYI_RECONNECT_DELAYS_MS.length - 1,
      )
    ]!;
    link.reconnectAttempts = attempt;
    input?.onReconnect(link.serverName, attempt, delayMs);
    link.reconnectTimer = setTimeout(() => {
      link.reconnectTimer = null;
      if (stopping || link.connected) return;
      void connect(link);
    }, delayMs);
    link.reconnectTimer.unref?.();
  }

  async function stopInternal(): Promise<void> {
    if (stopPromise) return stopPromise;
    stopPromise = Promise.resolve().then(() => {
      if (!started && stopping) return;
      stopping = true;
      started = false;
      detachAbort?.();
      detachAbort = null;
      for (const link of links.values()) {
        clearLinkTimers(link);
        link.pendingFinish?.(false);
        const socket = link.socket;
        link.socket = null;
        link.connected = false;
        link.terminalError = null;
        if (!socket) continue;
        socket.removeAllListeners();
        socket.on("error", () => undefined);
        try {
          if (socket.readyState === WebSocket.CONNECTING) {
            socket.terminate();
          } else {
            socket.close(1_000, "shutdown");
          }
        } catch {
          terminateSocket(socket);
        }
      }
      input = null;
    }).finally(() => {
      stopPromise = null;
    });
    return stopPromise;
  }
}

export function mapXiaoYiError(
  error: unknown,
): XiaoYiTransportError {
  if (error instanceof XiaoYiTransportError) return error;
  const record = asRecord(error);
  const statusCode = integerValue(
    record.statusCode
    ?? asRecord(record.response).statusCode,
  );
  const code = stringValue(record.code).toUpperCase();
  const message = stringValue(record.message).toLowerCase();
  if (
    statusCode === 401
    || code === "UNAUTHORIZED"
    || code === "INVALID_SIGNATURE"
  ) {
    return new XiaoYiTransportError({
      code: "credential_invalid",
      detail: "xiaoyi_credentials_invalid",
      retryable: false,
    });
  }
  if (
    statusCode === 403
    || code === "AGENT_NOT_ELIGIBLE"
  ) {
    return new XiaoYiTransportError({
      code: "runtime_prerequisite_missing",
      detail: "xiaoyi_agent_eligibility_required",
      retryable: false,
    });
  }
  if (code === "PERMISSION_DENIED") {
    return new XiaoYiTransportError({
      code: "permission_denied",
      detail: "xiaoyi_permission_denied",
      retryable: false,
    });
  }
  if (statusCode === 429 || code === "RATE_LIMITED") {
    return new XiaoYiTransportError({
      code: "rate_limited",
      detail: "xiaoyi_rate_limited",
      retryable: true,
      retryAfterMs: retryAfterMs(record),
    });
  }
  if (
    statusCode !== null && statusCode >= 500
    || /(?:closed|connect|econn|enet|socket|timeout|tls|certificate)/u
      .test(message)
  ) {
    return new XiaoYiTransportError({
      code: "network_unreachable",
      detail: "xiaoyi_network_unreachable",
      retryable: true,
    });
  }
  return new XiaoYiTransportError({
    code: "unknown",
    detail: "xiaoyi_transport_unknown",
    retryable: true,
  });
}

export function createXiaoYiAttachmentFetcher(
  fetchImpl: typeof fetch = fetch,
): XiaoYiAttachmentFetcher {
  const cache = new Map<string, Promise<Readonly<{
    bytes: Uint8Array;
    fileName: string;
    mimeType: string;
  }>>>();

  return {
    async inspect(descriptor, signal) {
      const loaded = await load(descriptor, signal);
      return {
        fileName: loaded.fileName,
        mimeType: loaded.mimeType,
        sizeBytes: loaded.bytes.byteLength,
      };
    },

    async download(descriptor, signal) {
      const loaded = await load(descriptor, signal);
      return (async function* () {
        try {
          yield loaded.bytes;
        } finally {
          release(descriptor);
        }
      })();
    },

    release,
  };

  function load(
    descriptor: InboundAttachmentDescriptor,
    signal?: AbortSignal,
  ) {
    const uri = safeXiaoYiMediaUri(descriptor.source.uri);
    if (!uri) {
      return Promise.reject(
        new Error("xiaoyi_attachment_uri_invalid"),
      );
    }
    const existing = cache.get(uri);
    if (existing) return existing;
    if (cache.size >= ATTACHMENT_LIMITS.maxCount) {
      return Promise.reject(
        new Error("xiaoyi_attachment_cache_full"),
      );
    }
    const pending = fetchAttachment(
      fetchImpl,
      uri,
      descriptor,
      signal,
    ).catch((error: unknown) => {
      cache.delete(uri);
      throw error;
    });
    cache.set(uri, pending);
    return pending;
  }

  function release(
    descriptor: InboundAttachmentDescriptor,
  ): void {
    const uri = safeXiaoYiMediaUri(descriptor.source.uri);
    if (uri) cache.delete(uri);
  }
}

export type XiaoYiAttachmentFetcher =
  InboundAttachmentFetcher
  & Readonly<{
    release(
      descriptor: InboundAttachmentDescriptor,
    ): void;
  }>;

type XiaoYiAttachmentLocatorWriter = Readonly<{
  persist(
    scope: AgentScope,
    eventId: string,
    connectionId: string,
    descriptor: InboundAttachmentDescriptor,
    expiresAt: Date,
    now: Date,
  ): Promise<boolean>;
}>;

export async function prepareXiaoYiAttachmentBatch(
  input: Readonly<{
    scope: AgentScope;
    eventId: string;
    connectionId: string;
    descriptors: readonly InboundAttachmentDescriptor[];
    expiresAt: Date;
    receivedAt: Date;
    locators: XiaoYiAttachmentLocatorWriter;
    fetcher: XiaoYiAttachmentFetcher;
    signal?: AbortSignal;
  }>,
): Promise<readonly InboundAttachmentDescriptor[]> {
  const pending: InboundAttachmentDescriptor[] = [];
  for (const descriptor of input.descriptors) {
    input.signal?.throwIfAborted();
    const persisted = await input.locators.persist(
      input.scope,
      input.eventId,
      input.connectionId,
      descriptor,
      input.expiresAt,
      input.receivedAt,
    );
    if (persisted) pending.push(descriptor);
  }
  if (pending.length === 0) return pending;
  await inspectXiaoYiAttachmentBatch(
    input.fetcher,
    pending,
    input.signal,
  );
  return pending;
}

export async function inspectXiaoYiAttachmentBatch(
  fetcher: XiaoYiAttachmentFetcher,
  descriptors: readonly InboundAttachmentDescriptor[],
  signal?: AbortSignal,
): Promise<void> {
  if (descriptors.length > ATTACHMENT_LIMITS.maxCount) {
    throw new Error("attachment_count_exceeded");
  }
  let totalBytes = 0;
  try {
    for (const descriptor of descriptors) {
      signal?.throwIfAborted();
      const metadata = await fetcher.inspect(
        descriptor,
        signal,
      );
      if (
        !Number.isSafeInteger(metadata.sizeBytes)
        || metadata.sizeBytes < 0
      ) {
        throw new Error("attachment_metadata_invalid");
      }
      if (
        metadata.sizeBytes > ATTACHMENT_LIMITS.maxFileBytes
      ) {
        throw new Error("attachment_file_too_large");
      }
      totalBytes += metadata.sizeBytes;
      if (
        totalBytes > ATTACHMENT_LIMITS.maxMessageBytes
      ) {
        throw new Error("attachment_message_too_large");
      }
    }
  } catch (error) {
    for (const descriptor of descriptors) {
      fetcher.release(descriptor);
    }
    throw error;
  }
}

async function fetchAttachment(
  fetchImpl: typeof fetch,
  uri: string,
  descriptor: InboundAttachmentDescriptor,
  signal?: AbortSignal,
): Promise<Readonly<{
  bytes: Uint8Array;
  fileName: string;
  mimeType: string;
}>> {
  signal?.throwIfAborted();
  const response = await fetchImpl(uri, {
    method: "GET",
    redirect: "error",
    signal,
    headers: {
      accept: "image/jpeg,image/png,image/webp,application/pdf,text/plain,text/markdown,application/json,text/csv",
    },
  });
  if (!response.ok) {
    throw new Error("xiaoyi_attachment_download_failed");
  }
  if (response.redirected) {
    throw new Error("xiaoyi_attachment_redirect_rejected");
  }
  const declaredLength = integerValue(
    response.headers.get("content-length"),
  );
  if (
    declaredLength !== null
    && declaredLength > ATTACHMENT_LIMITS.maxFileBytes
  ) {
    throw new Error("attachment_file_too_large");
  }
  const bytes = await readBoundedResponse(response);
  const fileName = descriptor.fileName;
  const responseMime = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  const mimeType =
    responseMime
    && responseMime !== "application/octet-stream"
      ? responseMime
      : descriptor.mimeType;
  if (!fileName || !mimeType) {
    throw new Error("xiaoyi_attachment_metadata_missing");
  }
  return { bytes, fileName, mimeType };
}

function defaultSocketFactory(
  url: string,
  options: XiaoYiSocketOptions,
): XiaoYiSocketLike {
  return new WebSocket(url, {
    headers: options.headers,
    handshakeTimeout: options.handshakeTimeout,
    rejectUnauthorized: true,
    ...(options.servername
      ? { servername: options.servername }
      : {}),
  }) as unknown as XiaoYiSocketLike;
}

async function readBoundedResponse(
  response: Response,
): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(
      await response.arrayBuffer(),
    );
    if (bytes.byteLength > ATTACHMENT_LIMITS.maxFileBytes) {
      throw new Error("attachment_file_too_large");
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > ATTACHMENT_LIMITS.maxFileBytes) {
        await reader.cancel();
        throw new Error("attachment_file_too_large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function sendInitialFrame(
  link: LinkState,
  hostname: string,
  agentId: string,
): void {
  if (
    !link.connected
    || link.socket?.readyState !== WebSocket.OPEN
  ) {
    return;
  }
  link.socket.send(JSON.stringify({
    msgType: "clawd_bot_init",
    agentId,
    msgDetail: JSON.stringify({
      agentId,
      hostname,
    }),
  }));
}

function parseSocketMessage(
  value: unknown,
  binaryFlag: unknown,
): unknown | null {
  if (binaryFlag === true) return null;
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (
    Buffer.isBuffer(value)
    || value instanceof Uint8Array
  ) {
    if (value.byteLength > MAX_FRAME_BYTES) return null;
    try {
      text = new TextDecoder(
        "utf-8",
        { fatal: true },
      ).decode(value);
    } catch {
      return null;
    }
  } else {
    return null;
  }
  if (Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed !== null
      && typeof parsed === "object"
      && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function terminateSocket(socket: XiaoYiSocketLike): void {
  try {
    socket.terminate();
  } catch {
    // The socket is already closed.
  }
}

function sendSocket(
  socket: XiaoYiSocketLike,
  data: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    try {
      socket.send(data, (error) => {
        if (error) reject(error);
        else resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

function clearLinkTimers(link: LinkState): void {
  clearHeartbeat(link);
  if (link.reconnectTimer) {
    clearTimeout(link.reconnectTimer);
    link.reconnectTimer = null;
  }
}

function clearHeartbeat(link: LinkState): void {
  if (!link.heartbeatTimer) return;
  clearInterval(link.heartbeatTimer);
  link.heartbeatTimer = null;
}

function retryAfterMs(
  record: Record<string, unknown>,
): number | undefined {
  const value = Number(
    record.retryAfterMs ?? record.retry_after_ms,
  );
  return Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function integerValue(value: unknown): number | null {
  const numeric = typeof value === "string"
    && value.trim()
    ? Number(value)
    : value;
  return typeof numeric === "number"
    && Number.isSafeInteger(numeric)
    && numeric >= 0
    ? numeric
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
