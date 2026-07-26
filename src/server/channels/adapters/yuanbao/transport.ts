import { EventEmitter } from "node:events";

import WebSocket, {
  type ClientOptions,
  type RawData,
} from "ws";

import {
  createYuanbaoTokenManager,
  YuanbaoAuthError,
  type YuanbaoTokenManager,
} from "./auth";
import {
  createYuanbaoCodec,
  YUANBAO_COMMANDS,
  YUANBAO_COMMAND_TYPES,
  type YuanbaoCodec,
  type YuanbaoInboundMessage,
} from "./codec";
import type { YuanbaoConfig } from "./config";
import {
  createYuanbaoAttachmentFetcher,
  type YuanbaoAttachmentFetcher,
} from "./media";

export const YUANBAO_WEBSOCKET_URL =
  "wss://bot-wss.yuanbao.tencent.com/wss/connection";
export const YUANBAO_RECONNECT_DELAYS_MS =
  Object.freeze([
    1_000,
    2_000,
    5_000,
    10_000,
    30_000,
    60_000,
  ]);
export const YUANBAO_MAX_RECONNECT_ATTEMPTS = 100;
export const YUANBAO_NO_RECONNECT_CLOSE_CODES =
  Object.freeze(new Set([
    4012,
    4013,
    4014,
    4018,
    4019,
    4021,
  ]));
export const YUANBAO_AUTH_REFRESH_CODES =
  Object.freeze(new Set([
    41103,
    41104,
    41108,
  ]));
export const YUANBAO_TEXT_CHUNK_LIMIT = 2_800;
const AUTH_ALREADY_CODE = 41101;
const CONNECTION_TIMEOUT_MS = 15_000;
const SEND_TIMEOUT_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;

export class YuanbaoTransportError extends Error {
  readonly code:
    | "credential_invalid"
    | "permission_denied"
    | "network_unreachable"
    | "rate_limited"
    | "runtime_prerequisite_missing"
    | "unknown";
  readonly retryable: boolean;
  readonly detail: string;

  constructor(input: Readonly<{
    code: YuanbaoTransportError["code"];
    retryable: boolean;
    detail: string;
  }>) {
    super(input.code);
    this.name = "YuanbaoTransportError";
    this.code = input.code;
    this.retryable = input.retryable;
    this.detail = input.detail;
  }
}

export type YuanbaoConnectionState = Readonly<{
  status: "connected" | "disconnected";
  reconnectAttempts: number;
  nextAttemptAt?: Date;
  retryExhausted?: boolean;
}>;

export type YuanbaoClientStartInput = Readonly<{
  signal: AbortSignal;
  onInbound(
    inbound: YuanbaoInboundMessage,
  ): Promise<void>;
  onState(state: YuanbaoConnectionState): void;
  onError(error: YuanbaoTransportError): void;
  onReconnecting?(
    attempt: number,
    nextAttemptAt: Date,
  ): void;
  onReconnected?(): void;
}>;

export type YuanbaoClientPort = Readonly<{
  start(
    input: YuanbaoClientStartInput,
  ): Promise<Readonly<{ botId: string }>>;
  stop(): Promise<void>;
  sendText(input: Readonly<{
    chatType: "direct" | "group";
    targetId: string;
    text: string;
    signal?: AbortSignal;
  }>): Promise<Readonly<{ messageId: string }>>;
  sendTyping(input: Readonly<{
    chatType: "direct" | "group";
    targetId: string;
    heartbeat: 1 | 2;
    signal?: AbortSignal;
  }>): Promise<void>;
  attachmentFetcher(): YuanbaoAttachmentFetcher;
}>;

export type YuanbaoClientFactory = (
  config: YuanbaoConfig,
) => YuanbaoClientPort;

export type YuanbaoSocketLike = EventEmitter & Readonly<{
  readyState: number;
  send(
    data: Uint8Array,
    callback?: (error?: Error) => void,
  ): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
}>;

export function createYuanbaoWebSocketClient(
  config: YuanbaoConfig,
  dependencies: Readonly<{
    codec?: YuanbaoCodec;
    tokenManager?: YuanbaoTokenManager;
    socketFactory?: (
      url: string,
      options: ClientOptions,
    ) => YuanbaoSocketLike;
    fetchImpl?: typeof fetch;
    now?: () => Date;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
  }> = {},
): YuanbaoClientPort {
  const codec =
    dependencies.codec ?? createYuanbaoCodec();
  const tokenManager =
    dependencies.tokenManager
    ?? createYuanbaoTokenManager(
      {
        appId: config.app_id,
        appSecret: config.app_secret,
        apiDomain: config.api_domain,
      },
      {
        ...(dependencies.fetchImpl
          ? { fetchImpl: dependencies.fetchImpl }
          : {}),
        ...(dependencies.now
          ? { now: dependencies.now }
          : {}),
      },
    );
  const attachmentFetcher =
    createYuanbaoAttachmentFetcher({
      apiDomain: config.api_domain,
      tokenManager,
      ...(dependencies.fetchImpl
        ? { fetchImpl: dependencies.fetchImpl }
        : {}),
    });
  const socketFactory = dependencies.socketFactory
    ?? ((url, options) =>
      new WebSocket(url, options) as YuanbaoSocketLike);
  const now = dependencies.now ?? (() => new Date());
  const setTimer = dependencies.setTimer ?? setTimeout;
  const clearTimer =
    dependencies.clearTimer ?? clearTimeout;
  let socket: YuanbaoSocketLike | null = null;
  let startInput: YuanbaoClientStartInput | null = null;
  let startPromise:
    | Promise<Readonly<{ botId: string }>>
    | null = null;
  let stopPromise: Promise<void> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null =
    null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null =
    null;
  let heartbeatIntervalMs =
    DEFAULT_HEARTBEAT_INTERVAL_MS;
  let heartbeatAcknowledged = true;
  let heartbeatTimeouts = 0;
  let reconnectAttempts = 0;
  let connected = false;
  let stopping = false;
  let nonReconnectable = false;
  let botId = "";
  let detachAbort: (() => void) | null = null;
  let cancelAuthentication:
    | ((error: unknown) => void)
    | null = null;
  const pending = new Map<string, PendingRequest>();

  return {
    start(input) {
      if (connected && botId) {
        return Promise.resolve({ botId });
      }
      if (startPromise) return startPromise;
      startInput = input;
      stopping = false;
      nonReconnectable = false;
      const onAbort = () => void stop();
      input.signal.addEventListener(
        "abort",
        onAbort,
        { once: true },
      );
      detachAbort = () =>
        input.signal.removeEventListener(
          "abort",
          onAbort,
        );
      startPromise = connect(false).finally(() => {
        startPromise = null;
      });
      return startPromise;
    },

    stop,

    async sendText(input) {
      input.signal?.throwIfAborted();
      ensureConnected();
      const built = input.chatType === "group"
        ? codec.encodeGroupText({
            groupCode: input.targetId,
            fromAccount: botId,
            text: input.text,
          })
        : codec.encodeC2CText({
            toAccount: input.targetId,
            fromAccount: botId,
            text: input.text,
          });
      const response = await sendCorrelated(
        built.raw,
        built.correlationId,
        input.signal,
      );
      if (
        response.status !== 0
        || response.code !== 0
      ) {
        const effectiveCode =
          response.code || response.status;
        throw new YuanbaoTransportError({
          code: effectiveCode === 429
            ? "rate_limited"
            : effectiveCode === 401
              || effectiveCode === 403
              ? "credential_invalid"
              : "unknown",
          retryable: effectiveCode === 429
            || effectiveCode >= 500,
          detail: "yuanbao_send_rejected",
        });
      }
      return { messageId: built.correlationId };
    },

    async sendTyping(input) {
      input.signal?.throwIfAborted();
      if (!connected || !socket) return;
      const built = codec.encodeTyping({
        fromAccount: botId,
        toAccount: input.chatType === "direct"
          ? input.targetId
          : "",
        ...(input.chatType === "group"
          ? { groupCode: input.targetId }
          : {}),
        heartbeat: input.heartbeat,
      });
      await sendRaw(built.raw, input.signal);
    },

    attachmentFetcher() {
      return attachmentFetcher;
    },
  };

  async function connect(
    reconnecting: boolean,
  ): Promise<Readonly<{ botId: string }>> {
    if (!startInput) {
      throw transportError(
        "runtime_prerequisite_missing",
        false,
        "yuanbao_start_context_missing",
      );
    }
    startInput.signal.throwIfAborted();
    await closeSocket();
    const token = await tokenManager.getToken().catch(
      (error: unknown) => {
        throw mapYuanbaoError(error);
      },
    );
    botId = token.botId;
    const activeSocket = socketFactory(
      YUANBAO_WEBSOCKET_URL,
      {
        rejectUnauthorized: true,
        handshakeTimeout: CONNECTION_TIMEOUT_MS,
        maxPayload: MAX_FRAME_BYTES,
      },
    );
    socket = activeSocket;
    try {
      const authenticated = await waitForAuthentication(
        activeSocket,
        token,
        startInput.signal,
      );
      if (!authenticated) {
        throw transportError(
          "credential_invalid",
          false,
          "yuanbao_auth_bind_failed",
        );
      }
    } catch (error) {
      if (socket === activeSocket) {
        await closeSocket();
      }
      throw error;
    }
    connected = true;
    reconnectAttempts = 0;
    heartbeatAcknowledged = true;
    heartbeatTimeouts = 0;
    attachRuntimeListeners(activeSocket);
    scheduleHeartbeat();
    startInput.onState({
      status: "connected",
      reconnectAttempts: 0,
    });
    if (reconnecting) startInput.onReconnected?.();
    return { botId };
  }

  function waitForAuthentication(
    activeSocket: YuanbaoSocketLike,
    token: Awaited<ReturnType<
      YuanbaoTokenManager["getToken"]
    >>,
    signal: AbortSignal,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const cancel = (error: unknown) => {
        finish(error);
      };
      cancelAuthentication = cancel;
      const timeout = setTimer(() => {
        finish(
          transportError(
            "network_unreachable",
            true,
            "yuanbao_auth_timeout",
          ),
        );
      }, CONNECTION_TIMEOUT_MS);
      timeout.unref?.();
      const onOpen = () => {
        try {
          activeSocket.send(codec.encodeAuthBind({
            bizId: "ybBot",
            uid: token.botId,
            source: token.source,
            token: token.token,
          }), (error) => {
            if (error) finish(mapYuanbaoError(error));
          });
        } catch (error) {
          finish(mapYuanbaoError(error));
        }
      };
      const onMessage = (
        raw: RawData,
        isBinary = true,
      ) => {
        try {
          if (!isBinary) {
            throw new Error("yuanbao_binary_frame_required");
          }
          const decoded = codec.decodeAuthBindResponse(
            toBytes(raw),
          );
          if (decoded.head.cmd !== YUANBAO_COMMANDS.authBind) {
            throw new Error("yuanbao_auth_response_invalid");
          }
          const code = decoded.response.code
            || decoded.head.status;
          if (code === 0 || code === AUTH_ALREADY_CODE) {
            finish(null, true);
            return;
          }
          if (YUANBAO_AUTH_REFRESH_CODES.has(code)) {
            void tokenManager.forceRefresh().catch(
              (error: unknown) => {
                startInput?.onError(mapYuanbaoError(error));
              },
            );
            finish(transportError(
              "network_unreachable",
              true,
              "yuanbao_auth_refresh_required",
            ));
            return;
          }
          finish(transportError(
            "credential_invalid",
            false,
            "yuanbao_auth_bind_rejected",
          ));
        } catch (error) {
          finish(mapYuanbaoError(error));
        }
      };
      const onError = (error: Error) =>
        finish(mapYuanbaoError(error));
      const onUnexpectedResponse = (
        ...args: unknown[]
      ) => {
        const response = asRecord(args[1]);
        finish(mapYuanbaoError({
          statusCode: response.statusCode,
        }));
      };
      const onClose = (code = 0) => {
        const closeCode = Number(code);
        if (
          YUANBAO_NO_RECONNECT_CLOSE_CODES.has(closeCode)
        ) {
          nonReconnectable = true;
          finish(transportError(
            "permission_denied",
            false,
            "yuanbao_close_not_reconnectable",
          ));
          return;
        }
        if (YUANBAO_AUTH_REFRESH_CODES.has(closeCode)) {
          void tokenManager.forceRefresh().catch(
            (error: unknown) => {
              startInput?.onError(mapYuanbaoError(error));
            },
          );
          finish(transportError(
            "network_unreachable",
            true,
            "yuanbao_auth_refresh_required",
          ));
          return;
        }
        finish(transportError(
          "network_unreachable",
          true,
          "yuanbao_socket_closed_during_auth",
        ));
      };
      const onAbort = () =>
        finish(signal.reason ?? new Error("aborted"));

      activeSocket.once("open", onOpen);
      activeSocket.once("message", onMessage);
      activeSocket.once("error", onError);
      activeSocket.once(
        "unexpected-response",
        onUnexpectedResponse,
      );
      activeSocket.once("close", onClose);
      signal.addEventListener("abort", onAbort, {
        once: true,
      });

      function finish(
        error: unknown,
        value = false,
      ): void {
        if (settled) return;
        settled = true;
        clearTimer(timeout);
        activeSocket.off("open", onOpen);
        activeSocket.off("message", onMessage);
        activeSocket.off("error", onError);
        activeSocket.off(
          "unexpected-response",
          onUnexpectedResponse,
        );
        activeSocket.off("close", onClose);
        signal.removeEventListener("abort", onAbort);
        if (cancelAuthentication === cancel) {
          cancelAuthentication = null;
        }
        if (error) reject(error);
        else resolve(value);
      }
    });
  }

  function attachRuntimeListeners(
    activeSocket: YuanbaoSocketLike,
  ): void {
    let pushQueue = Promise.resolve();
    activeSocket.on("message", (
      raw: RawData,
      isBinary = true,
    ) => {
      try {
        if (!isBinary) return;
        const bytes = toBytes(raw);
        if (bytes.byteLength > MAX_FRAME_BYTES) {
          throw new Error("yuanbao_frame_too_large");
        }
        const frame = codec.decodeFrame(bytes);
        const handle = () =>
          handleMessage(activeSocket, bytes, frame);
        if (
          frame.head.cmdType
          === YUANBAO_COMMAND_TYPES.push
        ) {
          pushQueue = pushQueue
            .then(handle)
            .catch(reportRuntimeError);
        } else {
          void handle().catch(reportRuntimeError);
        }
      } catch (error) {
        reportRuntimeError(error);
      }
    });
    activeSocket.on("error", (error: Error) => {
      startInput?.onError(mapYuanbaoError(error));
    });
    activeSocket.once("close", (
      code = 0,
    ) => {
      void handleClose(activeSocket, Number(code));
    });

    function reportRuntimeError(error: unknown): void {
      startInput?.onError(mapYuanbaoError(error));
    }
  }

  async function handleMessage(
    activeSocket: YuanbaoSocketLike,
    bytes: Uint8Array,
    frame: ReturnType<YuanbaoCodec["decodeFrame"]>,
  ): Promise<void> {
    if (activeSocket !== socket) return;
    if (
      frame.head.cmdType
      === YUANBAO_COMMAND_TYPES.response
    ) {
      if (frame.head.cmd === YUANBAO_COMMANDS.ping) {
        heartbeatAcknowledged = true;
        heartbeatTimeouts = 0;
        const ping = codec.decodePingResponse(bytes);
        if (
          ping.heartInterval >= 1
          && ping.heartInterval <= 300
        ) {
          heartbeatIntervalMs =
            ping.heartInterval * 1_000;
        }
        return;
      }
      if (frame.head.cmd === YUANBAO_COMMANDS.authBind) {
        const response =
          codec.decodeAuthBindResponse(bytes);
        const code =
          response.response.code || frame.head.status;
        if (YUANBAO_AUTH_REFRESH_CODES.has(code)) {
          try {
            await tokenManager.forceRefresh();
          } finally {
            activeSocket.close();
          }
        }
        return;
      }
      const request = pending.get(frame.head.msgId);
      if (request) {
        let response: ReturnType<
          YuanbaoCodec["decodeSendResponse"]
        >;
        try {
          response = codec.decodeSendResponse(bytes);
        } catch {
          pending.delete(frame.head.msgId);
          request.cleanup();
          request.reject(deliveryOutcomeUnknown());
          return;
        }
        pending.delete(frame.head.msgId);
        request.cleanup();
        request.resolve({
          status: frame.head.status,
          code: response.response.code,
        });
      }
      return;
    }
    if (
      frame.head.cmdType
      !== YUANBAO_COMMAND_TYPES.push
    ) {
      return;
    }
    if (frame.head.cmd === YUANBAO_COMMANDS.kickout) {
      if (frame.head.needAck) {
        await sendRawOnSocket(
          activeSocket,
          codec.encodePushAcknowledgement(frame.head),
        );
      }
      nonReconnectable = true;
      const kickout = codec.decodeKickout(bytes);
      startInput?.onError(transportError(
        "permission_denied",
        false,
        kickout.reason
          ? "yuanbao_kicked_out"
          : "yuanbao_kickout",
      ));
      activeSocket.close();
      return;
    }
    if (frame.data.byteLength === 0) return;
    await startInput?.onInbound(
      codec.decodeInbound(frame.data),
    );
    if (activeSocket !== socket) return;
    if (frame.head.needAck) {
      await sendRawOnSocket(
        activeSocket,
        codec.encodePushAcknowledgement(frame.head),
      );
    }
  }

  async function handleClose(
    activeSocket: YuanbaoSocketLike,
    code: number,
  ): Promise<void> {
    if (activeSocket !== socket) return;
    socket = null;
    connected = false;
    clearHeartbeatTimer();
    rejectPending("yuanbao_connection_closed");
    const terminal = (
      stopping
      || nonReconnectable
      || YUANBAO_NO_RECONNECT_CLOSE_CODES.has(code)
    );
    if (terminal) {
      nonReconnectable =
        nonReconnectable
        || YUANBAO_NO_RECONNECT_CLOSE_CODES.has(code);
      if (nonReconnectable) {
        startInput?.onError(transportError(
          "permission_denied",
          false,
          "yuanbao_close_not_reconnectable",
        ));
      }
      startInput?.onState({
        status: "disconnected",
        reconnectAttempts,
        ...(nonReconnectable
          ? { retryExhausted: true }
          : {}),
      });
      return;
    }
    startInput?.onState({
      status: "disconnected",
      reconnectAttempts,
    });
    if (YUANBAO_AUTH_REFRESH_CODES.has(code)) {
      await tokenManager.forceRefresh().catch(
        (error: unknown) => {
          startInput?.onError(mapYuanbaoError(error));
        },
      );
    }
    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    if (
      stopping
      || nonReconnectable
      || reconnectTimer
    ) {
      return;
    }
    if (
      reconnectAttempts
      >= YUANBAO_MAX_RECONNECT_ATTEMPTS
    ) {
      startInput?.onState({
        status: "disconnected",
        reconnectAttempts,
        retryExhausted: true,
      });
      return;
    }
    const delay =
      YUANBAO_RECONNECT_DELAYS_MS[
        Math.min(
          reconnectAttempts,
          YUANBAO_RECONNECT_DELAYS_MS.length - 1,
        )
      ]!;
    reconnectAttempts += 1;
    const nextAttemptAt = new Date(
      now().getTime() + delay,
    );
    startInput?.onReconnecting?.(
      reconnectAttempts,
      nextAttemptAt,
    );
    startInput?.onState({
      status: "disconnected",
      reconnectAttempts,
      nextAttemptAt,
    });
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      if (stopping || connected) return;
      void connect(true).catch((error: unknown) => {
        startInput?.onError(mapYuanbaoError(error));
        scheduleReconnect();
      });
    }, delay);
    reconnectTimer.unref?.();
  }

  function scheduleHeartbeat(): void {
    clearHeartbeatTimer();
    if (stopping || !connected) return;
    heartbeatTimer = setTimer(() => {
      heartbeatTimer = null;
      void heartbeat().finally(() => {
        scheduleHeartbeat();
      });
    }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
  }

  async function heartbeat(): Promise<void> {
    if (!connected || !socket) return;
    if (!heartbeatAcknowledged) {
      heartbeatTimeouts += 1;
      if (heartbeatTimeouts >= 2) {
        socket.close();
        return;
      }
    } else {
      heartbeatTimeouts = 0;
    }
    heartbeatAcknowledged = false;
    await sendRaw(codec.encodePing()).catch(
      (error: unknown) => {
        startInput?.onError(mapYuanbaoError(error));
        socket?.close();
      },
    );
  }

  function sendCorrelated(
    raw: Uint8Array,
    correlationId: string,
    signal?: AbortSignal,
  ): Promise<Readonly<{
    status: number;
    code: number;
  }>> {
    return new Promise((resolve, reject) => {
      if (pending.has(correlationId)) {
        reject(new Error("yuanbao_correlation_conflict"));
        return;
      }
      const timerHolder: {
        value?: ReturnType<typeof setTimeout>;
      } = {};
      const request: PendingRequest = {
        resolve,
        reject,
        cleanup() {
          if (timerHolder.value) {
            clearTimer(timerHolder.value);
          }
          signal?.removeEventListener(
            "abort",
            onAbort,
          );
        },
        writeAttempted: false,
      };
      const timer = setTimer(() => {
        pending.delete(correlationId);
        request.cleanup();
        reject(request.writeAttempted
          ? deliveryOutcomeUnknown()
          : transportError(
              "network_unreachable",
              true,
              "yuanbao_send_timeout",
            ));
      }, SEND_TIMEOUT_MS);
      timerHolder.value = timer;
      timer.unref?.();
      const onAbort = () => {
        pending.delete(correlationId);
        request.cleanup();
        reject(request.writeAttempted
          ? deliveryOutcomeUnknown()
          : signal?.reason ?? new Error("aborted"));
      };
      pending.set(correlationId, request);
      signal?.addEventListener("abort", onAbort, {
        once: true,
      });
      void sendRaw(
        raw,
        signal,
        () => {
          request.writeAttempted = true;
        },
      ).catch((error: unknown) => {
        if (!pending.delete(correlationId)) return;
        request.cleanup();
        reject(request.writeAttempted
          ? deliveryOutcomeUnknown()
          : mapYuanbaoError(error));
      });
    });
  }

  async function sendRaw(
    raw: Uint8Array,
    signal?: AbortSignal,
    onWriteAttempted?: () => void,
  ): Promise<void> {
    signal?.throwIfAborted();
    const active = socket;
    if (!active) {
      throw transportError(
        "network_unreachable",
        true,
        "yuanbao_socket_not_connected",
      );
    }
    await sendRawOnSocket(
      active,
      raw,
      signal,
      onWriteAttempted,
    );
  }

  async function sendRawOnSocket(
    active: YuanbaoSocketLike,
    raw: Uint8Array,
    signal?: AbortSignal,
    onWriteAttempted?: () => void,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (
      active.readyState !== WebSocket.OPEN
    ) {
      throw transportError(
        "network_unreachable",
        true,
        "yuanbao_socket_not_connected",
      );
    }
    await new Promise<void>((resolve, reject) => {
      let callbackFailed = false;
      try {
        active.send(raw, (error) => {
          if (error) {
            callbackFailed = true;
            reject(error);
          } else {
            resolve();
          }
        });
        if (!callbackFailed) onWriteAttempted?.();
      } catch (error) {
        reject(error);
      }
    });
  }

  function ensureConnected(): void {
    if (!connected || !socket || !botId) {
      throw transportError(
        "network_unreachable",
        true,
        "yuanbao_socket_not_connected",
      );
    }
  }

  async function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      stopping = true;
      connected = false;
      detachAbort?.();
      detachAbort = null;
      if (reconnectTimer) clearTimer(reconnectTimer);
      reconnectTimer = null;
      clearHeartbeatTimer();
      rejectPending("yuanbao_client_stopped");
      cancelAuthentication?.(transportError(
        "network_unreachable",
        true,
        "yuanbao_client_stopped",
      ));
      await closeSocket();
      await tokenManager.stop();
      startInput = null;
      botId = "";
    })().finally(() => {
      stopPromise = null;
    });
    return stopPromise;
  }

  async function closeSocket(): Promise<void> {
    const active = socket;
    socket = null;
    connected = false;
    if (!active) return;
    active.removeAllListeners();
    try {
      active.close(1000, "shutdown");
    } catch {
      active.terminate?.();
    }
  }

  function rejectPending(detail: string): void {
    for (const request of pending.values()) {
      request.cleanup();
      request.reject(request.writeAttempted
        ? deliveryOutcomeUnknown()
        : transportError(
            "network_unreachable",
            true,
            detail,
          ));
    }
    pending.clear();
  }

  function clearHeartbeatTimer(): void {
    if (heartbeatTimer) clearTimer(heartbeatTimer);
    heartbeatTimer = null;
  }
}

type PendingRequest = {
  resolve(value: Readonly<{
    status: number;
    code: number;
  }>): void;
  reject(error: unknown): void;
  cleanup(): void;
  writeAttempted: boolean;
};

export function splitYuanbaoText(
  text: string,
  limit = YUANBAO_TEXT_CHUNK_LIMIT,
): string[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("yuanbao_text_limit_invalid");
  }
  const codePoints = Array.from(text);
  const chunks: string[] = [];
  for (
    let index = 0;
    index < codePoints.length;
    index += limit
  ) {
    chunks.push(
      codePoints.slice(index, index + limit).join(""),
    );
  }
  return chunks;
}

export function mapYuanbaoError(
  error: unknown,
): YuanbaoTransportError {
  if (error instanceof YuanbaoTransportError) return error;
  if (error instanceof YuanbaoAuthError) {
    return transportError(
      error.code,
      error.retryable,
      error.detail,
    );
  }
  const record = asRecord(error);
  const code = string(record.code);
  const response = asRecord(record.response);
  const status =
    number(record.status)
    || number(record.statusCode)
    || number(response.status)
    || number(response.statusCode);
  if (
    code === "ECONNREFUSED"
    || code === "ENOTFOUND"
    || code === "ETIMEDOUT"
  ) {
    return transportError(
      "network_unreachable",
      true,
      "yuanbao_network_unreachable",
    );
  }
  if (status === 401) {
    return transportError(
      "credential_invalid",
      false,
      "yuanbao_credential_invalid",
    );
  }
  if (status === 403) {
    return transportError(
      "permission_denied",
      false,
      "yuanbao_eligibility_required",
    );
  }
  if (status === 429) {
    return transportError(
      "rate_limited",
      true,
      "yuanbao_rate_limited",
    );
  }
  return transportError(
    "unknown",
    true,
    "yuanbao_transport_unknown",
  );
}

function transportError(
  code: YuanbaoTransportError["code"],
  retryable: boolean,
  detail: string,
): YuanbaoTransportError {
  return new YuanbaoTransportError({
    code,
    retryable,
    detail,
  });
}

function deliveryOutcomeUnknown(): YuanbaoTransportError {
  return transportError(
    "unknown",
    false,
    "delivery_outcome_unknown",
  );
}

function toBytes(raw: RawData): Uint8Array {
  if (raw instanceof ArrayBuffer) {
    return new Uint8Array(raw);
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw);
  }
  return raw instanceof Uint8Array
    ? raw
    : new Uint8Array(raw as ArrayBuffer);
}

function asRecord(
  value: unknown,
): Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number {
  return typeof value === "number"
    && Number.isFinite(value)
    ? value
    : 0;
}
