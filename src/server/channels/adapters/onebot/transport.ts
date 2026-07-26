import {
  createHash,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { IncomingMessage } from "node:http";

import { WebSocket } from "ws";

import type {
  ChannelGatewayUpgradeRoute,
} from "@/server/channels/gateway/router";
import {
  CHANNEL_GATEWAY_MAX_BODY_BYTES,
} from "@/server/channels/gateway/router";
import type {
  InboundAttachmentFetcher,
  InboundAttachmentMetadata,
} from "@/server/channels/runtime/attachment-ingress";
import type {
  InboundAttachmentDescriptor,
} from "@/server/channels/runtime/types";
import {
  ATTACHMENT_LIMITS,
} from "@/server/attachments/types";

import {
  asRecord,
  isOneBotAction,
  parseOneBotActionResponse,
  type OneBotAction,
  type OneBotActionResponse,
} from "./protocol";

export const ONEBOT_API_TIMEOUT_MS = 30_000;
export const ONEBOT_EVENT_TASK_CAP = 500;
export const ONEBOT_EVENT_WATCHDOG_MS = 10_000;
export const ONEBOT_MAX_INLINE_ATTACHMENT_BYTES = Math.floor(
  (CHANNEL_GATEWAY_MAX_BODY_BYTES - 64 * 1024) * 3 / 4,
);

type OneBotTransportStart = Readonly<{
  connectionId: string;
  accessToken: string;
  signal: AbortSignal;
  onEvent(payload: unknown): Promise<void>;
  onConnected(selfId: string): void;
  onDisconnected(error: Error): void;
}>;

export type OneBotTransportPort = Readonly<{
  start(input: OneBotTransportStart): Promise<void>;
  stop(): Promise<void>;
  request(
    action: OneBotAction,
    params: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<OneBotActionResponse>;
}>;

export class OneBotTransportError extends Error {
  readonly code:
    | "credential_invalid"
    | "permission_denied"
    | "polling_conflict"
    | "network_unreachable"
    | "response_invalid";
  readonly detail: string;
  readonly retryable: boolean;

  constructor(input: Readonly<{
    code: OneBotTransportError["code"];
    detail?: string;
    retryable: boolean;
  }>) {
    super(input.code);
    this.name = "OneBotTransportError";
    this.code = input.code;
    this.detail = input.detail ?? input.code;
    this.retryable = input.retryable;
  }
}

type PendingAction = {
  resolve(value: OneBotActionResponse): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  detachAbort(): void;
};

type Registration = {
  input: OneBotTransportStart;
  socket: WebSocket | null;
  selfId: string | null;
  pending: Map<string, PendingAction>;
  activeTasks: Set<Promise<void>>;
  activeEventKeys: Set<string>;
};

export function createOneBotGatewayHub(options: Readonly<{
  apiTimeoutMs?: number;
  eventTaskCap?: number;
  eventWatchdogMs?: number;
}> = {}) {
  const apiTimeoutMs = positiveInteger(
    options.apiTimeoutMs,
    ONEBOT_API_TIMEOUT_MS,
  );
  const eventTaskCap = positiveInteger(
    options.eventTaskCap,
    ONEBOT_EVENT_TASK_CAP,
  );
  const eventWatchdogMs = positiveInteger(
    options.eventWatchdogMs,
    ONEBOT_EVENT_WATCHDOG_MS,
  );
  const registrations = new Map<string, Registration>();
  const authorizedRequests =
    new WeakMap<IncomingMessage, Registration>();

  const hub = {
    createTransport(): OneBotTransportPort {
      let registration: Registration | null = null;
      let stopPromise: Promise<void> | null = null;
      let detachAbort: (() => void) | null = null;
      const port: OneBotTransportPort = {
        async start(input) {
          input.signal.throwIfAborted();
          if (registration) return;
          if (registrations.has(input.connectionId)) {
            throw new OneBotTransportError({
              code: "polling_conflict",
              retryable: false,
            });
          }
          const created: Registration = {
            input,
            socket: null,
            selfId: null,
            pending: new Map(),
            activeTasks: new Set(),
            activeEventKeys: new Set(),
          };
          registrations.set(input.connectionId, created);
          registration = created;
          const onAbort = () => void port.stop();
          input.signal.addEventListener("abort", onAbort, {
            once: true,
          });
          detachAbort = () =>
            input.signal.removeEventListener("abort", onAbort);
        },

        async stop() {
          if (stopPromise) return stopPromise;
          const active = registration;
          if (!active) return;
          stopPromise = Promise.resolve().then(() => {
            detachAbort?.();
            detachAbort = null;
            unregister(active);
            if (registration === active) registration = null;
          }).finally(() => {
            stopPromise = null;
          });
          return stopPromise;
        },

        request(action, params, signal) {
          if (!registration) {
            return Promise.reject(disconnectedError());
          }
          return request(registration, action, params, signal);
        },
      };
      return port;
    },

    authorize(
      route: ChannelGatewayUpgradeRoute,
      request: IncomingMessage,
    ): boolean | number {
      if (route.type !== "onebot") return 503;
      const registration = registrations.get(route.connectionId);
      if (!registration) return 503;
      const token = bearerToken(request.headers.authorization);
      if (
        !token
        || !secureEqual(token, registration.input.accessToken)
      ) {
        return 401;
      }
      const clientRole = oneBotClientRole(
        request.headers["x-client-role"],
      );
      if (clientRole === "invalid") return 400;
      if (
        clientRole !== null
        && clientRole !== "universal"
      ) {
        return 409;
      }
      authorizedRequests.set(request, registration);
      return true;
    },

    async accept(
      route: ChannelGatewayUpgradeRoute,
      socket: WebSocket,
      request?: IncomingMessage,
    ): Promise<void> {
      if (route.type !== "onebot") {
        socket.close(1008, "unsupported_channel");
        return;
      }
      const registration = registrations.get(route.connectionId);
      if (
        !registration
        || (
          request
          && authorizedRequests.get(request) !== registration
        )
      ) {
        socket.close(1008, "connection_unavailable");
        return;
      }
      if (request) authorizedRequests.delete(request);
      const previous = registration.socket;
      if (previous) {
        rejectPending(registration, disconnectedError());
      }
      registration.socket = socket;
      registration.selfId = null;
      if (previous && previous.readyState !== WebSocket.CLOSED) {
        previous.close(1012, "connection_replaced");
      }
      socket.on("message", (data, isBinary) => {
        if (registration.socket !== socket) return;
        handleFrame(registration, data, isBinary);
      });
      socket.once("close", () => {
        disconnect(registration, socket, disconnectedError());
      });
      socket.once("error", () => {
        disconnect(registration, socket, disconnectedError());
      });
    },

    connectionState(connectionId: string) {
      const registration = registrations.get(connectionId);
      return registration
        ? {
            connected:
              registration.socket?.readyState === WebSocket.OPEN
              && registration.selfId !== null,
            selfId: registration.selfId,
            activeTasks: registration.activeTasks.size,
          }
        : null;
    },
  };
  return hub;

  function unregister(registration: Registration): void {
    if (
      registrations.get(registration.input.connectionId)
      !== registration
    ) {
      return;
    }
    registrations.delete(registration.input.connectionId);
    const socket = registration.socket;
    registration.socket = null;
    registration.selfId = null;
    rejectPending(registration, disconnectedError());
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      socket.close(1001, "connection_stopped");
    }
  }

  function handleFrame(
    registration: Registration,
    data: unknown,
    isBinary: boolean,
  ): void {
    if (
      registrations.get(registration.input.connectionId)
      !== registration
    ) {
      return;
    }
    if (isBinary) {
      registration.socket?.close(1003, "text_frames_only");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      registration.socket?.close(1007, "invalid_json");
      return;
    }
    const response = parseOneBotActionResponse(parsed);
    if (response) {
      settleAction(registration, response);
      return;
    }
    const frame = asRecord(parsed);
    if (
      frame.post_type === "meta_event"
      && frame.meta_event_type === "lifecycle"
      && frame.sub_type === "connect"
    ) {
      const selfId = oneBotId(frame.self_id);
      if (!selfId) {
        registration.socket?.close(1008, "self_id_invalid");
        return;
      }
      registration.selfId = selfId;
      registration.input.onConnected(selfId);
      return;
    }
    if (
      frame.post_type === "meta_event"
      && frame.meta_event_type === "heartbeat"
    ) {
      return;
    }
    if (frame.post_type !== "message") return;
    const frameSelfId = oneBotId(frame.self_id);
    if (
      !registration.selfId
      || frameSelfId !== registration.selfId
    ) {
      registration.socket?.close(1008, "self_id_mismatch");
      return;
    }
    const eventKey = oneBotMessageEventKey(frame);
    if (
      eventKey
      && registration.activeEventKeys.has(eventKey)
    ) {
      return;
    }
    if (registration.activeTasks.size >= eventTaskCap) {
      registration.socket?.close(1013, "event_capacity_exceeded");
      return;
    }
    const socket = registration.socket;
    if (eventKey) registration.activeEventKeys.add(eventKey);
    const task = Promise.resolve()
      .then(() => registration.input.onEvent(parsed));
    registration.activeTasks.add(task);
    const watchdog = setTimeout(() => {
      if (
        registration.activeTasks.has(task)
        && registration.socket === socket
      ) {
        socket?.close(1011, "event_watchdog_timeout");
      }
    }, eventWatchdogMs);
    watchdog.unref?.();
    void task.then(
      () => undefined,
      () => {
        if (registration.socket === socket) {
          socket?.close(1011, "event_handler_failed");
        }
      },
    ).finally(() => {
      clearTimeout(watchdog);
      registration.activeTasks.delete(task);
      if (eventKey) {
        registration.activeEventKeys.delete(eventKey);
      }
    });
  }

  function request(
    registration: Registration,
    action: OneBotAction,
    params: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<OneBotActionResponse> {
    signal.throwIfAborted();
    if (!isOneBotAction(action)) {
      return Promise.reject(new OneBotTransportError({
        code: "permission_denied",
        retryable: false,
      }));
    }
    const socket = registration.socket;
    if (
      !socket
      || socket.readyState !== WebSocket.OPEN
      || !registration.selfId
    ) {
      return Promise.reject(disconnectedError());
    }
    const echo = randomUUID();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        const pending = registration.pending.get(echo);
        if (!pending) return;
        clearTimeout(pending.timer);
        pending.detachAbort();
        registration.pending.delete(echo);
      };
      const fail = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onAbort = () => fail(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("onebot_request_aborted"),
      );
      signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        fail(disconnectedError());
      }, apiTimeoutMs);
      timer.unref?.();
      registration.pending.set(echo, {
        resolve(value) {
          cleanup();
          resolve(value);
        },
        reject: fail,
        timer,
        detachAbort: () =>
          signal.removeEventListener("abort", onAbort),
      });
      try {
        socket.send(JSON.stringify({ action, params, echo }));
      } catch {
        fail(disconnectedError());
      }
    });
  }

  function settleAction(
    registration: Registration,
    response: OneBotActionResponse & { echo: string },
  ): void {
    const pending = registration.pending.get(response.echo);
    if (!pending) return;
    if (response.status === "ok" && response.retcode === 0) {
      pending.resolve({
        status: response.status,
        retcode: response.retcode,
        data: response.data,
        ...(response.wording ? { wording: response.wording } : {}),
      });
      return;
    }
    pending.reject(new OneBotTransportError({
      code: response.retcode === 1401
        ? "credential_invalid"
        : response.retcode === 1403
          ? "permission_denied"
          : "response_invalid",
      retryable: response.retcode >= 1500,
    }));
  }

  function disconnect(
    registration: Registration,
    socket: WebSocket,
    error: OneBotTransportError,
  ): void {
    if (registration.socket !== socket) return;
    registration.socket = null;
    registration.selfId = null;
    rejectPending(registration, error);
    registration.input.onDisconnected(error);
  }
}

export const oneBotGatewayHub = createOneBotGatewayHub();

export type OneBotAttachmentFetcher =
  InboundAttachmentFetcher & Readonly<{
    release(descriptor: InboundAttachmentDescriptor): void;
  }>;

export function createOneBotAttachmentFetcher(
  transport: OneBotTransportPort,
  options: Readonly<{
    cacheTtlMs?: number;
    fetchImpl?: typeof fetch;
  }> = {},
): OneBotAttachmentFetcher {
  const cacheTtlMs = positiveInteger(
    options.cacheTtlMs,
    60_000,
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolved = new Map<
    string,
    Readonly<{
      promise: Promise<Readonly<{
        metadata: InboundAttachmentMetadata;
        bytes: Buffer;
      }>>;
      timer: ReturnType<typeof setTimeout>;
    }>
  >();
  return {
    async inspect(descriptor, signal) {
      return (await load(descriptor, signal)).metadata;
    },
    async download(descriptor, signal) {
      const attachment = await load(descriptor, signal);
      return (async function* () {
        try {
          yield attachment.bytes;
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
  ): Promise<Readonly<{
    metadata: InboundAttachmentMetadata;
    bytes: Buffer;
  }>> {
    const cached = resolved.get(descriptor.externalAttachmentId);
    if (cached) return cached.promise;
    if (resolved.size >= ATTACHMENT_LIMITS.maxCount) {
      return Promise.reject(
        new Error("onebot_attachment_cache_full"),
      );
    }
    const promise = resolve(descriptor, signal).catch((error) => {
      release(descriptor);
      throw error;
    });
    const timer = setTimeout(
      () => release(descriptor),
      cacheTtlMs,
    );
    timer.unref?.();
    resolved.set(descriptor.externalAttachmentId, {
      promise,
      timer,
    });
    return promise;
  }

  function release(
    descriptor: InboundAttachmentDescriptor,
  ): void {
    const cached = resolved.get(descriptor.externalAttachmentId);
    if (!cached) return;
    clearTimeout(cached.timer);
    resolved.delete(descriptor.externalAttachmentId);
  }

  async function resolve(
    descriptor: InboundAttachmentDescriptor,
    signal?: AbortSignal,
  ) {
    const kind = descriptor.source.kind;
    const fileId = descriptor.source.fileId;
    if (
      (kind !== "image" && kind !== "file")
      || !fileId
    ) {
      throw new Error("onebot_attachment_locator_invalid");
    }
    const sourceUrl = safeOneBotMediaUrl(
      descriptor.source.url,
    );
    if (sourceUrl) {
      return downloadTrustedMedia(
        sourceUrl,
        descriptor,
        kind,
        signal,
      );
    }
    const controller = signal
      ? null
      : new AbortController();
    const response = await transport.request(
      kind === "image" ? "get_image" : "get_file",
      kind === "image"
        ? { file: fileId }
        : { file_id: fileId },
      signal ?? controller!.signal,
    );
    const responseUrl = safeOneBotMediaUrl(
      response.data.url,
    );
    if (responseUrl) {
      return downloadTrustedMedia(
        responseUrl,
        descriptor,
        kind,
        signal,
      );
    }
    const encoded = encodedAttachment(response.data);
    if (!encoded) {
      throw new Error("onebot_attachment_content_unavailable");
    }
    const bytes = Buffer.from(encoded, "base64");
    if (
      bytes.byteLength === 0
      || bytes.byteLength > ATTACHMENT_LIMITS.maxFileBytes
    ) {
      throw new Error("onebot_attachment_size_invalid");
    }
    const fileName = safeResponseFileName(
      response.data.file_name
        ?? response.data.filename
        ?? descriptor.fileName,
    ) ?? (kind === "image" ? "image.jpg" : "attachment.txt");
    const metadata = {
      fileName,
      mimeType:
        safeMimeType(
          response.data.mime_type ?? descriptor.mimeType,
        )
        ?? inferMimeType(fileName, kind),
      sizeBytes: bytes.byteLength,
    };
    return { metadata, bytes };
  }

  async function downloadTrustedMedia(
    url: string,
    descriptor: InboundAttachmentDescriptor,
    kind: string,
    signal?: AbortSignal,
  ) {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      signal,
    });
    if (!response.ok || response.redirected) {
      throw new Error("onebot_attachment_download_failed");
    }
    const declaredLength = Number(
      response.headers.get("content-length") ?? NaN,
    );
    if (
      Number.isFinite(declaredLength)
      && (
        declaredLength <= 0
        || declaredLength > ATTACHMENT_LIMITS.maxFileBytes
      )
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("onebot_attachment_size_invalid");
    }
    const bytes = await readBoundedResponse(
      response,
      ATTACHMENT_LIMITS.maxFileBytes,
    );
    const fileName = descriptor.fileName
      ?? (kind === "image" ? "image.jpg" : "attachment.txt");
    return {
      metadata: {
        fileName,
        mimeType:
          safeMimeType(response.headers.get("content-type"))
          ?? descriptor.mimeType
          ?? inferMimeType(fileName, kind),
        sizeBytes: bytes.byteLength,
      },
      bytes,
    };
  }
}

export async function inspectOneBotAttachmentBatch(
  fetcher: OneBotAttachmentFetcher,
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
        || metadata.sizeBytes <= 0
        || metadata.sizeBytes > ATTACHMENT_LIMITS.maxFileBytes
      ) {
        throw new Error("attachment_file_too_large");
      }
      totalBytes += metadata.sizeBytes;
      if (totalBytes > ATTACHMENT_LIMITS.maxMessageBytes) {
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

function rejectPending(
  registration: Registration,
  error: OneBotTransportError,
): void {
  for (const pending of [...registration.pending.values()]) {
    pending.reject(error);
  }
}

function disconnectedError(): OneBotTransportError {
  return new OneBotTransportError({
    code: "network_unreachable",
    retryable: true,
  });
}

function bearerToken(value: string | undefined): string | null {
  if (!value) return null;
  const match = /^Bearer ([^\s]{1,12000})$/u.exec(value);
  return match?.[1] ?? null;
}

function secureEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function oneBotId(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const normalized = String(value).trim();
  return normalized.length > 0
    && normalized.length <= 256
    && /^[A-Za-z0-9_.:-]+$/u.test(normalized)
    ? normalized
    : null;
}

function oneBotMessageEventKey(
  frame: Readonly<Record<string, unknown>>,
): string | null {
  const messageId = oneBotId(frame.message_id);
  return messageId ? `message:${messageId}` : null;
}

function oneBotClientRole(
  value: string | string[] | undefined,
): "universal" | "api" | "event" | "invalid" | null {
  if (value === undefined) return null;
  if (Array.isArray(value)) return "invalid";
  const normalized = value.trim().toLowerCase();
  return normalized === "universal"
    || normalized === "api"
    || normalized === "event"
    ? normalized
    : "invalid";
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error("onebot_transport_limit_invalid");
  }
  return resolved;
}

function encodedAttachment(
  data: Readonly<Record<string, unknown>>,
): string | null {
  const direct = typeof data.base64 === "string"
    ? data.base64
    : null;
  const file = typeof data.file === "string"
    && data.file.startsWith("base64://")
    ? data.file.slice("base64://".length)
    : null;
  const value = direct ?? file;
  return value
    && value.length
      <= Math.ceil(
        ONEBOT_MAX_INLINE_ATTACHMENT_BYTES * 4 / 3,
      ) + 4
    && /^[A-Za-z0-9+/]*={0,2}$/u.test(value)
    ? value
    : null;
}

function safeOneBotMediaUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const trusted = hostname === "qpic.cn"
      || hostname.endsWith(".qpic.cn")
      || hostname === "qq.com"
      || hostname.endsWith(".qq.com")
      || hostname === "qq.com.cn"
      || hostname.endsWith(".qq.com.cn");
    return url.protocol === "https:"
      && url.username === ""
      && url.password === ""
      && url.port === ""
      && trusted
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

async function readBoundedResponse(
  response: Response,
  limit: number,
): Promise<Buffer> {
  if (!response.body) {
    throw new Error("onebot_attachment_body_missing");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  let canceled = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        canceled = true;
        throw new Error("onebot_attachment_size_invalid");
      }
      chunks.push(value);
    }
  } finally {
    if (!completed && !canceled) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
  if (total === 0) {
    throw new Error("onebot_attachment_size_invalid");
  }
  return Buffer.concat(chunks, total);
}

function safeResponseFileName(value: unknown): string | null {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && !value.includes("/")
    && !value.includes("\\")
    && value !== "."
    && value !== ".."
    ? value
    : null;
}

function safeMimeType(value: unknown): string | null {
  return typeof value === "string"
    && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu
      .test(value)
    ? value.toLowerCase()
    : null;
}

function inferMimeType(
  fileName: string,
  kind: string,
): string {
  const extension = fileName.toLowerCase().split(".").pop();
  const byExtension: Readonly<Record<string, string>> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
    json: "application/json",
    csv: "text/csv",
  };
  return byExtension[extension ?? ""]
    ?? (kind === "image" ? "image/jpeg" : "text/plain");
}
