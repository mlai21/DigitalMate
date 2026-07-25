import { randomUUID } from "node:crypto";

import {
  DWClient,
  EventAck,
  TOPIC_ROBOT,
  type DWClientDownStream,
} from "dingtalk-stream-sdk-nodejs";
import WebSocket from "ws";

import type {
  AdapterDependencies,
} from "@/server/channels/runtime/types";

import type { DingTalkConfig } from "./config";

export class DingTalkTransportError extends Error {
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
    code: DingTalkTransportError["code"];
    detail?: string;
    retryable: boolean;
    retryAfterMs?: number;
  }>) {
    super(input.code);
    this.name = "DingTalkTransportError";
    this.code = input.code;
    this.detail = input.detail ?? input.code;
    this.retryable = input.retryable;
    this.retryAfterMs = input.retryAfterMs;
  }
}

export type DingTalkClientPort = Readonly<{
  start(input: Readonly<{
    signal: AbortSignal;
    onEvent(
      payload: unknown,
      acknowledge: () => Promise<void>,
    ): Promise<void>;
    onError(error: Error): void;
    onReconnecting?(): void;
    onReconnected?(): void;
  }>): Promise<void>;
  stop(): Promise<void>;
  sendSessionWebhook(input: Readonly<{
    sessionWebhook: string;
    payload: Readonly<Record<string, unknown>>;
    signal?: AbortSignal;
  }>): Promise<Readonly<{ messageId: string }>>;
  sendOpenApi(input: Readonly<{
    conversationId: string;
    chatType: "direct" | "group";
    senderStaffId: string;
    robotCode: string;
    text: string;
    format: "text" | "markdown";
    signal?: AbortSignal;
  }>): Promise<Readonly<{ messageId: string }>>;
  createCard(input: Readonly<{
    conversationId: string;
    chatType: "direct" | "group";
    senderStaffId: string;
    robotCode: string;
    templateId: string;
    templateKey: string;
    text: string;
    autoLayout: boolean;
    atSender: boolean;
    signal?: AbortSignal;
  }>): Promise<Readonly<{ cardInstanceId: string }>>;
  updateCard(input: Readonly<{
    cardInstanceId: string;
    templateKey: string;
    text: string;
    final: boolean;
    signal?: AbortSignal;
  }>): Promise<void>;
}>;

export type DingTalkClientFactory = (
  config: DingTalkConfig,
) => DingTalkClientPort;

type Http = NonNullable<AdapterDependencies["http"]>;

export function createDingTalkSdkClient(
  config: DingTalkConfig,
  dependencies: Readonly<{ http?: Http }> = {},
): DingTalkClientPort {
  const http = dependencies.http ?? defaultHttp();
  const tokens = dingTalkTokenCache(config, http);
  let sdk: DWClient | null = null;
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectAttempts = 0;
  let stopping = false;
  let started = false;
  let runtimeCallbacks: Parameters<DingTalkClientPort["start"]>[0]
    | null = null;

  return {
    async start(input) {
      runtimeCallbacks = input;
      stopping = false;
      const client = new DWClient({
        clientId: config.client_id,
        clientSecret: config.client_secret,
        keepAlive: false,
      });
      client.debug = false;
      sdk = client;
      installSecureTransport(client);
      client.registerCallbackListener(
        TOPIC_ROBOT,
        (message) => {
          void handleCallback(message);
        },
      );
      client.config.subscriptions.splice(
        0,
        client.config.subscriptions.length,
        { type: "CALLBACK", topic: TOPIC_ROBOT },
      );
      await client.connect();
      await registrationWaiter(input.signal, 15_000);
      started = true;
    },
    async stop() {
      if (stopping) return;
      stopping = true;
      runtimeCallbacks = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      socket?.removeAllListeners();
      socket?.close();
      socket = null;
      if (sdk) {
        sdk.connected = false;
        sdk.registered = false;
      }
      sdk = null;
      tokens.clear();
      started = false;
      reconnectAttempts = 0;
    },
    async sendSessionWebhook(input) {
      const response = await http.request({
        method: "POST",
        url: requireSessionWebhook(input.sessionWebhook),
        headers: { "content-type": "application/json" },
        body: input.payload,
        signal: input.signal,
      });
      const body = asRecord(response.body);
      if (
        response.status < 200
        || response.status >= 300
        || Number(body.errcode ?? 0) !== 0
      ) {
        throw mapDingTalkError(response);
      }
      return { messageId: `session:${randomUUID()}` };
    },
    async sendOpenApi(input) {
      const token = await tokens.get();
      const markdown = input.format === "markdown";
      const path = input.chatType === "group"
        ? "/v1.0/robot/groupMessages/send"
        : "/v1.0/robot/oToMessages/batchSend";
      const response = await http.request({
        method: "POST",
        url: `${config.endpoint}${path}`,
        headers: apiHeaders(token),
        body: {
          robotCode: input.robotCode,
          msgKey: markdown ? "sampleMarkdown" : "sampleText",
          msgParam: JSON.stringify(
            markdown
              ? {
                  title: messageTitle(input.text),
                  text: input.text,
                }
              : { content: input.text },
          ),
          ...(input.chatType === "group"
            ? { openConversationId: input.conversationId }
            : { userIds: [input.senderStaffId] }),
        },
        signal: input.signal,
      });
      const body = mapDingTalkResponse(response);
      return {
        messageId:
          readId(body.processQueryKey)
          ?? readId(asRecord(body.result).processQueryKey)
          ?? `openapi:${randomUUID()}`,
      };
    },
    async createCard(input) {
      const token = await tokens.get();
      const cardInstanceId = `card_${randomUUID()}`;
      const cardParamMap: Record<string, string> = {
        [input.templateKey]: input.text,
      };
      if (input.autoLayout) {
        cardParamMap.config = JSON.stringify({ autoLayout: true });
      }
      await apiRequest(
        http,
        config,
        token,
        "POST",
        "/v1.0/card/instances",
        {
          cardTemplateId: input.templateId,
          outTrackId: cardInstanceId,
          cardData: { cardParamMap },
          callbackType: "STREAM",
          imGroupOpenSpaceModel: { supportForward: true },
          imRobotOpenSpaceModel: { supportForward: true },
          ...(input.atSender && input.chatType === "group"
            ? {
                cardAtUserIds: [input.senderStaffId],
                userIdType: 1,
              }
            : {}),
        },
        input.signal,
      );
      const group = input.chatType === "group";
      const deliver = await apiRequest(
        http,
        config,
        token,
        "POST",
        "/v1.0/card/instances/deliver",
        {
          outTrackId: cardInstanceId,
          userIdType: 1,
          openSpaceId: group
            ? `dtv1.card//IM_GROUP.${input.conversationId}`
            : `dtv1.card//IM_ROBOT.${input.senderStaffId}`,
          ...(group
            ? {
                imGroupOpenDeliverModel: {
                  robotCode: input.robotCode,
                },
              }
            : {
                imRobotOpenDeliverModel: {
                  spaceType: "IM_ROBOT",
                },
              }),
        },
        input.signal,
      );
      assertCardDelivery(deliver);
      return { cardInstanceId };
    },
    async updateCard(input) {
      const token = await tokens.get();
      await apiRequest(
        http,
        config,
        token,
        "PUT",
        "/v1.0/card/streaming",
        {
          outTrackId: input.cardInstanceId,
          guid: randomUUID(),
          key: input.templateKey,
          content: input.text,
          isFull: true,
          isFinalize: input.final,
          isError: false,
        },
        input.signal,
      );
    },
  };

  function installSecureTransport(client: DWClient) {
    const mutable = client as unknown as MutableDingTalkClient;
    mutable.printDebug = () => undefined;
    mutable.getEndpoint = async () => {
      const token = await tokens.get();
      const response = await http.request({
        method: "POST",
        url: `${config.endpoint}/v1.0/gateway/connections/open`,
        headers: {
          ...apiHeaders(token),
          "access-token": token,
        },
        body: {
          clientId: config.client_id,
          clientSecret: config.client_secret,
          ua: "DigitalMate",
          subscriptions: client.getConfig().subscriptions,
        },
      });
      const body = mapDingTalkResponse(response);
      const data = Object.keys(asRecord(body.data)).length > 0
        ? asRecord(body.data)
        : body;
      const endpoint = safeGatewayEndpoint(data.endpoint);
      const ticket = readId(data.ticket);
      if (!endpoint || !ticket) {
        throw new DingTalkTransportError({
          code: "response_invalid",
          retryable: false,
        });
      }
      mutable.dw_url = `${endpoint}?ticket=${encodeURIComponent(ticket)}`;
      return client;
    };
    mutable._connect = async () => {
      const url = mutable.dw_url;
      if (!url) {
        throw new DingTalkTransportError({
          code: "response_invalid",
          retryable: false,
        });
      }
      await openSecureSocket(client, url);
    };
    mutable.onDownStream = (data: string | Buffer) => {
      const message = parseDownstream(data);
      if (!message) return;
      if (message.type === "SYSTEM") {
        client.onSystem(message);
        if (message.headers.topic === "REGISTERED") {
          reconnectAttempts = 0;
          if (started) {
            runtimeCallbacks?.onReconnected?.();
          }
        } else if (message.headers.topic === "disconnect") {
          socket?.close();
        }
        return;
      }
      if (message.type === "CALLBACK") {
        client.onCallback(message);
      }
    };
  }

  function openSecureSocket(
    client: DWClient,
    url: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const active = new WebSocket(url, {
        rejectUnauthorized: true,
        handshakeTimeout: 15_000,
      });
      socket = active;
      (client as unknown as MutableDingTalkClient).socket = active;
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
      active.once("open", () => {
        client.connected = true;
        installHeartbeat(active);
        settle();
      });
      active.on("pong", () => {
        active.isAlive = true;
      });
      active.on("message", (data) => {
        (client as unknown as MutableDingTalkClient)
          .onDownStream(data as Buffer);
      });
      active.once("error", () => {
        settle(new DingTalkTransportError({
          code: "network_unreachable",
          retryable: true,
        }));
      });
      active.once("close", () => {
        client.connected = false;
        client.registered = false;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        if (!stopping) scheduleReconnect(client);
      });
    });
  }

  function installHeartbeat(active: WebSocket) {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    active.isAlive = true;
    heartbeatTimer = setInterval(() => {
      if (active.readyState !== WebSocket.OPEN) return;
      if (!active.isAlive) {
        active.terminate();
        return;
      }
      active.isAlive = false;
      active.ping();
    }, 8_000);
    heartbeatTimer.unref?.();
  }

  function scheduleReconnect(client: DWClient) {
    if (reconnectTimer || stopping) return;
    runtimeCallbacks?.onReconnecting?.();
    reconnectAttempts += 1;
    const delay = Math.min(
      1_000 * (2 ** Math.min(reconnectAttempts - 1, 5)),
      30_000,
    );
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void client.connect()
        .then(() =>
          registrationWaiter(
            runtimeCallbacks?.signal
              ?? new AbortController().signal,
            15_000,
          )
        )
        .catch((error: unknown) => {
          runtimeCallbacks?.onError(normalizeTransportError(error));
          if (socket) socket.terminate();
          else scheduleReconnect(client);
        });
    }, delay);
    reconnectTimer.unref?.();
  }

  function registrationWaiter(
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        if (sdk?.registered) {
          cleanup();
          resolve();
          return;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          cleanup();
          reject(new DingTalkTransportError({
            code: "network_unreachable",
            retryable: true,
          }));
        }
      }, 25);
      timer.unref?.();
      const abort = () => {
        cleanup();
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      function cleanup() {
        clearInterval(timer);
        signal.removeEventListener("abort", abort);
      }
    });
  }

  async function handleCallback(message: DWClientDownStream) {
    const callbacks = runtimeCallbacks;
    const client = sdk;
    if (!callbacks || !client) return;
    const messageId = readId(message.headers?.messageId);
    if (!messageId) return;
    let acknowledged = false;
    const acknowledge = async () => {
      if (acknowledged) return;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new DingTalkTransportError({
          code: "network_unreachable",
          retryable: true,
        });
      }
      client.send(messageId, {
        status: EventAck.SUCCESS,
        message: "OK",
      });
      acknowledged = true;
    };
    try {
      await callbacks.onEvent(message, acknowledge);
      await acknowledge();
    } catch (error) {
      if (!acknowledged) {
        try {
          if (socket?.readyState === WebSocket.OPEN) {
            client.send(messageId, {
              status: EventAck.LATER,
              message: "RETRY",
            });
          }
        } catch {
          // The platform will redeliver after the connection recovers.
        }
      }
      callbacks.onError(normalizeTransportError(error));
    }
  }
}

export function createDingTalkTokenCache(input: Readonly<{
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
    async get() {
      if (value && value.expiresAt - now().getTime() > 300_000) {
        return value.token;
      }
      if (loading) return loading;
      loading = input.load().then((loaded) => {
        if (!loaded.token || loaded.expiresInSeconds <= 0) {
          throw new DingTalkTransportError({
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

export function mapDingTalkResponse(response: Readonly<{
  status: number;
  headers?: Readonly<Record<string, string>>;
  body?: unknown;
}>): Record<string, unknown> {
  if (response.status < 200 || response.status >= 300) {
    throw mapDingTalkError(response);
  }
  const body = asRecord(response.body);
  const code = readId(
    body.code ?? body.errcode ?? body.errorCode,
  );
  if (
    code
    && code !== "0"
    && code.toLowerCase() !== "success"
  ) {
    throw mapDingTalkError(response);
  }
  if (body.success === false) throw mapDingTalkError(response);
  return body;
}

export function createDingTalkAttachmentFetcher(
  config: DingTalkConfig,
  http?: Http,
) {
  const client = http ?? defaultHttp();
  const tokens = dingTalkTokenCache(config, client);
  const cache = new Map<string, {
    bytes: Uint8Array;
    fileName: string;
    mimeType: string;
  }>();
  return {
    async inspect(
      descriptor: AttachmentDescriptor,
      signal = new AbortController().signal,
    ) {
      const value = await load(descriptor, signal);
      return {
        fileName: value.fileName,
        mimeType: value.mimeType,
        sizeBytes: value.bytes.byteLength,
      };
    },
    async download(
      descriptor: AttachmentDescriptor,
      signal = new AbortController().signal,
    ) {
      return singleChunk((await load(descriptor, signal)).bytes);
    },
  };

  async function load(
    descriptor: AttachmentDescriptor,
    signal: AbortSignal,
  ) {
    const existing = cache.get(descriptor.externalAttachmentId);
    if (existing) return existing;
    const token = await tokens.get();
    const response = await client.request({
      method: "POST",
      url: `${config.endpoint}/v1.0/robot/messageFiles/download`,
      headers: apiHeaders(token),
      body: {
        downloadCode: requireId(
          descriptor.source.downloadCode,
          "dingtalk_download_code_missing",
        ),
        robotCode: requireId(
          descriptor.source.robotCode,
          "dingtalk_robot_code_missing",
        ),
      },
      signal,
    });
    const body = mapDingTalkResponse(response);
    const url = safeDownloadUrl(
      body.downloadUrl
      ?? body.download_url
      ?? asRecord(body.result).downloadUrl,
    );
    if (!url) {
      throw new Error("dingtalk_attachment_url_invalid");
    }
    const downloaded = await client.request({
      method: "GET",
      url,
      headers: {},
      responseType: "bytes",
      signal,
    });
    const bytes = toBytes(downloaded.body);
    if (
      downloaded.status < 200
      || downloaded.status >= 300
      || !bytes
    ) {
      throw new Error("dingtalk_attachment_download_failed");
    }
    const fileName = descriptor.fileName
      ?? "dingtalk-file";
    const mimeType = descriptor.mimeType
      ?? mimeFromName(fileName);
    if (!mimeType) {
      throw new Error("dingtalk_attachment_mime_missing");
    }
    const value = { bytes, fileName, mimeType };
    cache.set(descriptor.externalAttachmentId, value);
    return value;
  }
}

type AttachmentDescriptor = Readonly<{
  externalAttachmentId: string;
  fileName: string | null;
  mimeType: string | null;
  source: Readonly<Record<string, string>>;
}>;

type MutableDingTalkClient = {
  dw_url?: string;
  socket?: WebSocket;
  registered: boolean;
  connected: boolean;
  getEndpoint(): Promise<DWClient>;
  _connect(): Promise<void>;
  onDownStream(data: string | Buffer): void;
  printDebug(message: string): void;
};

declare module "ws" {
  interface WebSocket {
    isAlive?: boolean;
  }
}

function dingTalkTokenCache(config: DingTalkConfig, http: Http) {
  return createDingTalkTokenCache({
    load: async () => {
      const response = await http.request({
        method: "POST",
        url: `${config.endpoint}/v1.0/oauth2/accessToken`,
        headers: { "content-type": "application/json" },
        body: {
          appKey: config.client_id,
          appSecret: config.client_secret,
        },
      });
      const body = mapDingTalkResponse(response);
      return {
        token: requireId(
          readId(body.accessToken ?? body.access_token),
          "dingtalk_access_token_missing",
        ),
        expiresInSeconds:
          Number(body.expireIn ?? body.expires_in ?? 7_200),
      };
    },
  });
}

async function apiRequest(
  http: Http,
  config: DingTalkConfig,
  token: string,
  method: "POST" | "PUT",
  path: string,
  body: unknown,
  signal?: AbortSignal,
) {
  return mapDingTalkResponse(await http.request({
    method,
    url: `${config.endpoint}${path}`,
    headers: apiHeaders(token),
    body,
    signal,
  }));
}

function mapDingTalkError(response: Readonly<{
  status: number;
  headers?: Readonly<Record<string, string>>;
  body?: unknown;
}>): DingTalkTransportError {
  const body = asRecord(response.body);
  const code = String(
    body.code ?? body.errcode ?? body.errorCode ?? "",
  );
  const message = String(
    body.message ?? body.errmsg ?? body.errorMessage ?? "",
  );
  const combined = `${code} ${message}`;
  if (/ip.*(?:white|allow)|notinwhitelist/i.test(combined)) {
    return new DingTalkTransportError({
      code: "permission_denied",
      detail: "dingtalk_outbound_ip_not_allowed",
      retryable: false,
    });
  }
  if (
    response.status === 401
    || /invalid.*(?:token|credential|appkey|secret)/i.test(combined)
  ) {
    return new DingTalkTransportError({
      code: "credential_invalid",
      retryable: false,
    });
  }
  if (response.status === 403 || /forbidden|permission/i.test(combined)) {
    return new DingTalkTransportError({
      code: "permission_denied",
      retryable: false,
    });
  }
  if (response.status === 429 || /throttl|rate.?limit/i.test(combined)) {
    const seconds = Number(
      response.headers?.["retry-after"]
      ?? response.headers?.["Retry-After"],
    );
    return new DingTalkTransportError({
      code: "rate_limited",
      retryable: true,
      ...(Number.isFinite(seconds) && seconds > 0
        ? { retryAfterMs: Math.ceil(seconds * 1_000) }
        : {}),
    });
  }
  return new DingTalkTransportError({
    code: response.status >= 500
      ? "network_unreachable"
      : "response_invalid",
    retryable: response.status >= 500,
  });
}

function normalizeTransportError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new DingTalkTransportError({
        code: "network_unreachable",
        retryable: true,
      });
}

function parseDownstream(
  data: string | Buffer,
): DWClientDownStream | null {
  const text = typeof data === "string"
    ? data
    : data.toString("utf8");
  if (!text || text.length > 2 * 1024 * 1024) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    const record = asRecord(parsed);
    if (
      !["SYSTEM", "CALLBACK", "EVENT"].includes(
        String(record.type),
      )
      || !record.headers
      || typeof record.data !== "string"
    ) {
      return null;
    }
    return parsed as DWClientDownStream;
  } catch {
    return null;
  }
}

function safeGatewayEndpoint(value: unknown): string | null {
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
        host === "dingtalk.com"
        || host.endsWith(".dingtalk.com")
      )
      ? url.toString().replace(/\?$/, "")
      : null;
  } catch {
    return null;
  }
}

function safeDownloadUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 8_192) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && (
        host === "dingtalk.com"
        || host.endsWith(".dingtalk.com")
        || host === "alicdn.com"
        || host.endsWith(".alicdn.com")
        || host === "aliyuncs.com"
        || host.endsWith(".aliyuncs.com")
        || host === "aliyuncs.com.cn"
        || host.endsWith(".aliyuncs.com.cn")
      )
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function requireSessionWebhook(value: string): string {
  const url = safeSessionWebhook(value);
  if (!url) throw new Error("dingtalk_reply_handle_invalid");
  return url;
}

function safeSessionWebhook(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 16_384) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && (
        host === "dingtalk.com"
        || host.endsWith(".dingtalk.com")
      )
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function assertCardDelivery(body: Record<string, unknown>) {
  const result = asRecord(body.result);
  const entries = Array.isArray(result.deliverResults)
    ? result.deliverResults.map(asRecord)
    : Array.isArray(result.deliver_results)
      ? result.deliver_results.map(asRecord)
      : [];
  if (entries.some((entry) => entry.success === false)) {
    throw new DingTalkTransportError({
      code: "permission_denied",
      detail: "dingtalk_card_delivery_failed",
      retryable: false,
    });
  }
}

function apiHeaders(token: string) {
  return {
    "content-type": "application/json",
    "x-acs-dingtalk-access-token": token,
  };
}

function messageTitle(text: string) {
  const title = text.trim().split(/\s+/u).join(" ").slice(0, 20);
  return title || "DigitalMate";
}

function mimeFromName(name: string): string | null {
  const ext = name.split(".").at(-1)?.toLowerCase();
  return ["jpg", "jpeg"].includes(ext ?? "") ? "image/jpeg"
    : ext === "png" ? "image/png"
      : ext === "webp" ? "image/webp"
        : ext === "pdf" ? "application/pdf"
          : ext === "txt" ? "text/plain"
            : ext === "md" ? "text/markdown"
              : ext === "json" ? "application/json"
                : ext === "csv" ? "text/csv"
                  : null;
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

function readId(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const id = String(value).trim();
  return id && id.length <= 16_384 ? id : null;
}

function requireId(
  value: string | null | undefined,
  code: string,
): string {
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
