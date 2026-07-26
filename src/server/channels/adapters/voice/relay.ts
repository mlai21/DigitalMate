import {
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";
import type { IncomingMessage } from "node:http";

import {
  WebSocket,
} from "ws";

import type {
  ChannelGatewayUpgradeRoute,
} from "@/server/channels/gateway/router";
import type { SendResult } from "@/server/channels/runtime/types";

import type { VoiceConfig } from "./config";
import { verifyTwilioSignature } from "./signature";
import {
  buildBusyTwiml,
  buildConversationRelayTwiml,
} from "./twiml";
import {
  configureTwilioWebhook,
  type ConfigureTwilioWebhook,
} from "./transport";

const RELAY_TOKEN_TTL_MS = 2 * 60 * 1_000;
const CALL_REPLAY_RETENTION_MS = 24 * 60 * 60 * 1_000;
const CALL_REPLAY_MAX_ENTRIES = 10_000;
const RELAY_FRAME_QUEUE_MAX = 32;
const DEFAULT_TEXT_CHUNK_CODE_POINTS = 320;
const CALL_SID = /^CA[0-9a-f]{32}$/i;
const TERMINAL_CALL_STATUSES = new Set([
  "completed",
  "busy",
  "failed",
  "no-answer",
  "canceled",
]);

export type VoicePromptPayload = Readonly<{
  kind: "prompt";
  callSid: string;
  from: string;
  to: string;
  sequence: number;
  prompt: Readonly<{
    type: "prompt";
    voicePrompt: string;
    last: true;
    lang?: string;
  }>;
}>;

type VoiceTransportStart = Readonly<{
  connectionId: string;
  config: VoiceConfig;
  publicBaseUrl: string;
  signal: AbortSignal;
  onPrompt(payload: VoicePromptPayload): Promise<void>;
}>;

export type VoiceTransportPort = Readonly<{
  start(input: VoiceTransportStart): Promise<void>;
  stop(): Promise<void>;
  send(input: Readonly<{
    callSid: string;
    text: string;
    deliveryId: string;
    signal: AbortSignal;
  }>): Promise<SendResult>;
  state(): Readonly<{
    activeCalls: number;
    lastConnectedAt: Date | null;
    lastEventAt: Date | null;
  }>;
}>;

type PendingCall = {
  tokenHash: string;
  issuanceNonce: string;
  requestFingerprint: string;
  callSid: string;
  from: string;
  to: string;
  expiresAt: number;
};

type RelaySession = {
  registration: Registration;
  socket: WebSocket;
  pending: PendingCall;
  setup: boolean;
  closed: boolean;
  sequence: number;
  interruptGeneration: number;
  queuedFrames: number;
  tail: Promise<void>;
};

type Registration = {
  input: VoiceTransportStart;
  registrationNonce: string;
  pending: Map<string, PendingCall>;
  authorizedCalls: Set<PendingCall>;
  terminalCalls: Map<string, number>;
  sessions: Map<string, RelaySession>;
  preSetup: Set<RelaySession>;
  lastConnectedAt: Date | null;
  lastEventAt: Date | null;
};

type AuthorizedUpgrade = {
  registration: Registration;
  pending: PendingCall;
};

export function createVoiceGatewayHub(options: Readonly<{
  now?: () => Date;
  generateToken?: (input: Readonly<{
    connectionId: string;
    callSid: string;
    requestFingerprint: string;
    registrationNonce: string;
    issuanceNonce: string;
  }>) => string;
  textChunkCodePoints?: number;
}> = {}) {
  const now = options.now ?? (() => new Date());
  const tokenKey = randomBytes(32);
  const generateToken = options.generateToken
    ?? ((input) =>
      createHmac("sha256", tokenKey)
        .update(input.connectionId)
        .update("\0")
        .update(input.callSid)
        .update("\0")
        .update(input.requestFingerprint)
        .update("\0")
        .update(input.registrationNonce)
        .update("\0")
        .update(input.issuanceNonce)
        .digest("base64url"));
  const textChunkCodePoints = options.textChunkCodePoints
    ?? DEFAULT_TEXT_CHUNK_CODE_POINTS;
  if (
    !Number.isSafeInteger(textChunkCodePoints)
    || textChunkCodePoints < 1
    || textChunkCodePoints > 4_096
  ) {
    throw new Error("voice_text_chunk_size_invalid");
  }
  const registrations = new Map<string, Registration>();
  const authorized =
    new WeakMap<IncomingMessage, AuthorizedUpgrade>();

  const hub = {
    createTransport(input: Readonly<{
      configureWebhook?: ConfigureTwilioWebhook;
    }> = {}): VoiceTransportPort {
      const webhook = input.configureWebhook
        ?? configureTwilioWebhook;
      let registration: Registration | null = null;
      let detachAbort: (() => void) | null = null;
      let stopPromise: Promise<void> | null = null;
      const port: VoiceTransportPort = {
        async start(startInput) {
          startInput.signal.throwIfAborted();
          if (registration) return;
          if (registrations.has(startInput.connectionId)) {
            throw new Error("voice_connection_already_registered");
          }
          const publicBaseUrl = parsePublicBaseUrl(
            startInput.publicBaseUrl,
          );
          await webhook({
            accountSid:
              startInput.config.twilio_account_sid,
            authToken:
              startInput.config.twilio_auth_token,
            phoneNumberSid:
              startInput.config.phone_number_sid,
            voiceUrl: voiceHttpUrl(
              publicBaseUrl,
              startInput.connectionId,
              "incoming",
            ),
            statusCallback: voiceHttpUrl(
              publicBaseUrl,
              startInput.connectionId,
              "status",
            ),
            signal: startInput.signal,
          });
          startInput.signal.throwIfAborted();
          const created: Registration = {
            input: {
              ...startInput,
              publicBaseUrl,
            },
            registrationNonce:
              randomBytes(16).toString("base64url"),
            pending: new Map(),
            authorizedCalls: new Set(),
            terminalCalls: new Map(),
            sessions: new Map(),
            preSetup: new Set(),
            lastConnectedAt: null,
            lastEventAt: null,
          };
          registrations.set(startInput.connectionId, created);
          registration = created;
          const onAbort = () => void port.stop();
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
        },

        stop() {
          if (stopPromise) return stopPromise;
          const active = registration;
          if (!active) return Promise.resolve();
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

        send(sendInput) {
          if (!registration) {
            return Promise.reject(
              new Error("voice_transport_not_started"),
            );
          }
          return sendText(
            registration,
            sendInput,
          );
        },

        state() {
          return {
            activeCalls: registration?.sessions.size ?? 0,
            lastConnectedAt:
              registration?.lastConnectedAt ?? null,
            lastEventAt: registration?.lastEventAt ?? null,
          };
        },
      };
      return port;
    },

    async handleIncoming(
      request: Request,
      context: Readonly<{ connectionId: string }>,
    ): Promise<Response> {
      const registration = registrations.get(
        context.connectionId,
      );
      if (!registration) {
        return new Response("Channel gateway unavailable", {
          status: 503,
        });
      }
      cleanupExpired(registration, now().getTime());
      const params = await signedForm(
        request,
        registration,
        "incoming",
      );
      if (!params) {
        return new Response("Forbidden", { status: 403 });
      }
      const callSid = params.CallSid ?? "";
      const from = params.From ?? "";
      const to = params.To ?? "";
      if (
        !CALL_SID.test(callSid)
        || from.length === 0
        || to !== registration.input.config.phone_number
      ) {
        return new Response("Bad Request", { status: 400 });
      }
      if (registration.terminalCalls.has(callSid)) {
        return xmlResponse(buildBusyTwiml());
      }
      const requestFingerprint = fingerprintParams(
        params,
        requestQuery(request.url),
      );
      const existingPending = pendingCallFor(
        registration,
        callSid,
      );
      if (existingPending) {
        if (
          existingPending.requestFingerprint
          !== requestFingerprint
        ) {
          return new Response("Conflict", { status: 409 });
        }
        const replayToken = generateToken({
          connectionId: context.connectionId,
          callSid,
          requestFingerprint,
          registrationNonce:
            registration.registrationNonce,
          issuanceNonce: existingPending.issuanceNonce,
        });
        if (
          replayToken.length < 32
          || hashToken(replayToken)
            !== existingPending.tokenHash
        ) {
          return new Response("Channel gateway unavailable", {
            status: 503,
          });
        }
        return xmlResponse(
          buildConversationRelayTwiml(
            registration.input.config,
            voiceRelayUrl(
              registration.input.publicBaseUrl,
              context.connectionId,
              replayToken,
            ),
          ),
        );
      }
      if (
        callIsInProgress(registration, callSid)
        || concurrentCallCount(registration)
          >= registration.input.config.max_concurrent_calls
      ) {
        return xmlResponse(buildBusyTwiml());
      }
      const tokenInput = {
        connectionId: context.connectionId,
        callSid,
        requestFingerprint,
        registrationNonce: registration.registrationNonce,
        issuanceNonce:
          randomBytes(16).toString("base64url"),
      };
      let token = generateToken(tokenInput);
      let tokenHash = hashToken(token);
      for (
        let attempt = 0;
        registration.pending.has(tokenHash) && attempt < 4;
        attempt += 1
      ) {
        tokenInput.issuanceNonce =
          randomBytes(16).toString("base64url");
        token = generateToken(tokenInput);
        tokenHash = hashToken(token);
      }
      if (
        token.length < 32
        || registration.pending.has(tokenHash)
      ) {
        return new Response("Channel gateway unavailable", {
          status: 503,
        });
      }
      registration.pending.set(tokenHash, {
        tokenHash,
        issuanceNonce: tokenInput.issuanceNonce,
        requestFingerprint,
        callSid,
        from,
        to,
        expiresAt: now().getTime() + RELAY_TOKEN_TTL_MS,
      });
      const relayUrl = voiceRelayUrl(
        registration.input.publicBaseUrl,
        context.connectionId,
        token,
      );
      return xmlResponse(
        buildConversationRelayTwiml(
          registration.input.config,
          relayUrl,
        ),
      );
    },

    async handleStatus(
      request: Request,
      context: Readonly<{ connectionId: string }>,
    ): Promise<Response> {
      const registration = registrations.get(
        context.connectionId,
      );
      if (!registration) {
        return new Response("Channel gateway unavailable", {
          status: 503,
        });
      }
      cleanupExpired(registration, now().getTime());
      const params = await signedForm(
        request,
        registration,
        "status",
      );
      if (!params) {
        return new Response("Forbidden", { status: 403 });
      }
      const callSid = params.CallSid ?? "";
      const status = (params.CallStatus ?? "").toLowerCase();
      if (!CALL_SID.test(callSid) || status.length === 0) {
        return new Response("Bad Request", { status: 400 });
      }
      if (TERMINAL_CALL_STATUSES.has(status)) {
        terminateCall(
          registration,
          callSid,
          now().getTime(),
        );
      }
      return new Response(null, { status: 204 });
    },

    authorize(
      route: ChannelGatewayUpgradeRoute,
      request: IncomingMessage,
    ): boolean | number {
      if (route.type !== "voice-relay") return 503;
      const registration = registrations.get(
        route.connectionId,
      );
      if (!registration) return 503;
      cleanupExpired(registration, now().getTime());
      const requestUrl = request.url ?? "";
      const token = new URL(
        requestUrl,
        "https://channel-gateway.invalid",
      ).searchParams.get("token") ?? "";
      if (token.length < 32) return 401;
      const tokenHash = hashToken(token);
      const pending = registration.pending.get(tokenHash);
      if (!pending || pending.expiresAt <= now().getTime()) {
        return 401;
      }
      const signature = stringHeader(
        request.headers["x-twilio-signature"],
      );
      const signatureUrl = upgradeSignatureUrl(
        registration.input.publicBaseUrl,
        requestUrl,
      );
      if (
        !verifyTwilioSignature({
          url: signatureUrl,
          signature,
          params: {},
        }, registration.input.config.twilio_auth_token)
      ) {
        return 401;
      }
      registration.pending.delete(tokenHash);
      registration.authorizedCalls.add(pending);
      authorized.set(request, { registration, pending });
      return true;
    },

    async accept(
      route: ChannelGatewayUpgradeRoute,
      socket: WebSocket,
      request?: IncomingMessage,
    ): Promise<void> {
      if (
        route.type !== "voice-relay"
        || !request
      ) {
        socket.close(1008, "unsupported_channel");
        return;
      }
      const approved = authorized.get(request);
      authorized.delete(request);
      if (
        !approved
        || approved.registration.input.connectionId
          !== route.connectionId
        || registrations.get(route.connectionId)
          !== approved.registration
        || !approved.registration.authorizedCalls.has(
          approved.pending,
        )
        || approved.pending.expiresAt <= now().getTime()
        || approved.registration.terminalCalls.has(
          approved.pending.callSid,
        )
      ) {
        if (approved) {
          if (
            registrations.get(route.connectionId)
              === approved.registration
            && approved.pending.expiresAt <= now().getTime()
          ) {
            terminateCall(
              approved.registration,
              approved.pending.callSid,
              now().getTime(),
              1008,
              "relay_token_expired",
            );
          } else {
            approved.registration.authorizedCalls.delete(
              approved.pending,
            );
          }
        }
        socket.close(1008, "connection_unavailable");
        return;
      }
      const session: RelaySession = {
        registration: approved.registration,
        socket,
        pending: approved.pending,
        setup: false,
        closed: false,
        sequence: 0,
        interruptGeneration: 0,
        queuedFrames: 0,
        tail: Promise.resolve(),
      };
      approved.registration.authorizedCalls.delete(
        approved.pending,
      );
      approved.registration.preSetup.add(session);
      socket.on("message", (data, isBinary) => {
        if (session.closed) return;
        if (session.queuedFrames >= RELAY_FRAME_QUEUE_MAX) {
          closeSession(session, 1008, "relay_queue_full");
          return;
        }
        session.queuedFrames += 1;
        session.tail = session.tail
          .then(() =>
            handleRelayFrame(session, data, isBinary)
          )
          .catch(() => {
            closeSession(session, 1011, "relay_frame_failed");
          })
          .finally(() => {
            session.queuedFrames -= 1;
          });
      });
      socket.once("close", () => {
        detachSession(session);
      });
      socket.once("error", () => {
        detachSession(session);
      });
    },

    inspect(connectionId: string) {
      const registration = registrations.get(connectionId);
      if (!registration) return null;
      cleanupExpired(registration, now().getTime());
      return {
        pendingCalls: registration.pending.size,
        authorizedCalls: registration.authorizedCalls.size,
        activeCalls: registration.sessions.size,
        preSetupCalls: registration.preSetup.size,
        lastConnectedAt:
          registration.lastConnectedAt?.toISOString() ?? null,
        lastEventAt:
          registration.lastEventAt?.toISOString() ?? null,
      };
    },
  };
  return hub;

  function unregister(registration: Registration): void {
    if (
      registrations.get(registration.input.connectionId)
      === registration
    ) {
      registrations.delete(registration.input.connectionId);
    }
    registration.pending.clear();
    registration.authorizedCalls.clear();
    registration.terminalCalls.clear();
    for (const session of [
      ...registration.sessions.values(),
      ...registration.preSetup,
    ]) {
      closeSession(session, 1001, "voice_channel_stopped");
    }
  }

  async function handleRelayFrame(
    session: RelaySession,
    data: unknown,
    isBinary: boolean,
  ): Promise<void> {
    if (isBinary) {
      closeSession(session, 1003, "text_frames_only");
      return;
    }
    if (!sessionIsLive(session)) return;
    let frame: unknown;
    try {
      frame = JSON.parse(String(data));
    } catch {
      closeSession(session, 1007, "invalid_json");
      return;
    }
    if (!frame || typeof frame !== "object") return;
    const record = frame as Record<string, unknown>;
    if (record.type === "setup") {
      if (session.setup) return;
      const callSid = stringValue(record.callSid);
      if (
        callSid !== session.pending.callSid
        || session.registration.sessions.has(callSid)
        || session.pending.expiresAt <= now().getTime()
        || session.registration.terminalCalls.has(callSid)
      ) {
        if (session.pending.expiresAt <= now().getTime()) {
          terminateCall(
            session.registration,
            session.pending.callSid,
            now().getTime(),
            1008,
            "relay_token_expired",
          );
          return;
        }
        closeSession(session, 1008, "call_sid_mismatch");
        return;
      }
      session.setup = true;
      session.registration.preSetup.delete(session);
      session.registration.sessions.set(callSid, session);
      session.registration.lastConnectedAt = now();
      return;
    }
    if (!session.setup) {
      closeSession(session, 1008, "setup_required");
      return;
    }
    if (record.type === "interrupt") {
      session.interruptGeneration += 1;
      session.registration.lastEventAt = now();
      return;
    }
    if (record.type !== "prompt" || record.last !== true) {
      return;
    }
    const voicePrompt = stringValue(record.voicePrompt).trim();
    if (voicePrompt.length === 0 || voicePrompt.length > 32_000) {
      return;
    }
    const lang = stringValue(record.lang);
    session.sequence += 1;
    session.registration.lastEventAt = now();
    if (!sessionIsLive(session)) return;
    await session.registration.input.onPrompt({
      kind: "prompt",
      callSid: session.pending.callSid,
      from: session.pending.from,
      to: session.pending.to,
      sequence: session.sequence,
      prompt: {
        type: "prompt",
        voicePrompt,
        last: true,
        ...(lang ? { lang } : {}),
      },
    });
  }

  async function sendText(
    registration: Registration,
    input: Readonly<{
      callSid: string;
      text: string;
      deliveryId: string;
      signal: AbortSignal;
    }>,
  ): Promise<SendResult> {
    input.signal.throwIfAborted();
    const session = registration.sessions.get(input.callSid);
    if (
      !session
      || session.closed
      || registration.sessions.get(input.callSid) !== session
      || session.socket.readyState !== WebSocket.OPEN
    ) {
      throw new Error("voice_call_not_active");
    }
    const generation = session.interruptGeneration;
    const chunks = splitText(
      input.text,
      textChunkCodePoints,
    );
    let sentChunks = 0;
    for (const chunk of chunks) {
      input.signal.throwIfAborted();
      if (session.interruptGeneration !== generation) break;
      await sendFrame(session.socket, {
        type: "text",
        token: chunk,
        last: false,
      });
      sentChunks += 1;
    }
    const interrupted =
      session.interruptGeneration !== generation;
    if (!interrupted) {
      await sendFrame(session.socket, {
        type: "text",
        token: "",
        last: true,
      });
    }
    return {
      externalMessageId: `voice:${input.deliveryId}`,
      sentAt: now(),
      rawSummary: {
        interrupted,
        chunks: sentChunks,
      },
    };
  }
}

export const voiceGatewayHub = createVoiceGatewayHub();

async function signedForm(
  request: Request,
  registration: Registration,
  action: "incoming" | "status",
): Promise<Record<string, string> | null> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/x-www-form-urlencoded")
  ) {
    return null;
  }
  const form = new URLSearchParams(await request.text());
  const params: Record<string, string> = {};
  for (const [key, value] of form) {
    if (Object.hasOwn(params, key)) return null;
    params[key] = value;
  }
  const signature = request.headers.get(
    "x-twilio-signature",
  ) ?? "";
  const url = voiceHttpUrl(
    registration.input.publicBaseUrl,
    registration.input.connectionId,
    action,
  ) + requestQuery(request.url);
  return verifyTwilioSignature({
    url,
    signature,
    params,
  }, registration.input.config.twilio_auth_token)
    ? params
    : null;
}

function voiceHttpUrl(
  publicBaseUrl: string,
  connectionId: string,
  action: "incoming" | "status",
): string {
  return `${publicBaseUrl}/channel-gateway/voice/`
    + `${connectionId}/${action}`;
}

function voiceRelayUrl(
  publicBaseUrl: string,
  connectionId: string,
  token: string,
): string {
  const url = new URL(publicBaseUrl);
  url.protocol = "wss:";
  url.pathname =
    `/channel-gateway/voice/${connectionId}/relay`;
  url.searchParams.set("token", token);
  return url.toString();
}

function upgradeSignatureUrl(
  publicBaseUrl: string,
  pathWithQuery: string,
): string {
  const base = new URL(publicBaseUrl);
  base.protocol = "wss:";
  return new URL(pathWithQuery, base).toString();
}

function parsePublicBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("voice_public_https_required");
  }
  if (
    url.protocol !== "https:"
    || url.username.length > 0
    || url.password.length > 0
    || url.search.length > 0
    || url.hash.length > 0
    || (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("voice_public_https_required");
  }
  return url.origin;
}

function xmlResponse(xml: string): Response {
  return new Response(xml, {
    status: 200,
    headers: {
      "content-type": "text/xml; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function concurrentCallCount(
  registration: Registration,
): number {
  return registration.pending.size
    + registration.authorizedCalls.size
    + registration.sessions.size
    + registration.preSetup.size;
}

function cleanupExpired(
  registration: Registration,
  timestamp: number,
): void {
  const expiredCallSids = new Set<string>();
  for (const [hash, pending] of registration.pending) {
    if (pending.expiresAt <= timestamp) {
      registration.pending.delete(hash);
      expiredCallSids.add(pending.callSid);
    }
  }
  for (const pending of registration.authorizedCalls) {
    if (pending.expiresAt <= timestamp) {
      registration.authorizedCalls.delete(pending);
      expiredCallSids.add(pending.callSid);
    }
  }
  for (const session of registration.preSetup) {
    if (session.pending.expiresAt <= timestamp) {
      expiredCallSids.add(session.pending.callSid);
    }
  }
  for (const callSid of expiredCallSids) {
    terminateCall(
      registration,
      callSid,
      timestamp,
      1008,
      "relay_token_expired",
    );
  }
  for (const [callSid, expiresAt] of registration.terminalCalls) {
    if (expiresAt <= timestamp) {
      registration.terminalCalls.delete(callSid);
    }
  }
}

function removePendingCall(
  registration: Registration,
  callSid: string,
): void {
  for (const [hash, pending] of registration.pending) {
    if (pending.callSid === callSid) {
      registration.pending.delete(hash);
    }
  }
}

function pendingCallFor(
  registration: Registration,
  callSid: string,
): PendingCall | null {
  for (const pending of registration.pending.values()) {
    if (pending.callSid === callSid) return pending;
  }
  return null;
}

function callIsInProgress(
  registration: Registration,
  callSid: string,
): boolean {
  if (registration.sessions.has(callSid)) return true;
  for (const pending of registration.authorizedCalls) {
    if (pending.callSid === callSid) return true;
  }
  for (const session of registration.preSetup) {
    if (session.pending.callSid === callSid) return true;
  }
  return false;
}

function terminateCall(
  registration: Registration,
  callSid: string,
  timestamp: number,
  code = 1000,
  reason = "call_completed",
): void {
  removePendingCall(registration, callSid);
  for (const pending of registration.authorizedCalls) {
    if (pending.callSid === callSid) {
      registration.authorizedCalls.delete(pending);
    }
  }
  for (const session of registration.preSetup) {
    if (session.pending.callSid === callSid) {
      closeSession(session, code, reason);
    }
  }
  closeSession(
    registration.sessions.get(callSid),
    code,
    reason,
  );
  registration.terminalCalls.set(
    callSid,
    timestamp + CALL_REPLAY_RETENTION_MS,
  );
  while (
    registration.terminalCalls.size
    > CALL_REPLAY_MAX_ENTRIES
  ) {
    const oldest = registration.terminalCalls.keys().next().value;
    if (typeof oldest !== "string") break;
    registration.terminalCalls.delete(oldest);
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function fingerprintParams(
  params: Readonly<Record<string, string>>,
  query: string,
): string {
  const canonical = Object.keys(params)
    .sort()
    .map((key) => `${key.length}:${key}${params[key]!.length}:`
      + params[key])
    .join("");
  return createHash("sha256")
    .update(query)
    .update("\0")
    .update(canonical)
    .digest("hex");
}

function requestQuery(value: string): string {
  try {
    return new URL(value).search;
  } catch {
    return "";
  }
}

function closeSession(
  session: RelaySession | undefined,
  code: number,
  reason: string,
): void {
  if (!session) return;
  detachSession(session);
  if (
    session.socket.readyState !== WebSocket.CLOSED
    && session.socket.readyState !== WebSocket.CLOSING
  ) {
    session.socket.close(code, reason);
  }
}

function detachSession(session: RelaySession): void {
  session.closed = true;
  const registration = session.registration;
  registration.preSetup.delete(session);
  if (
    registration.sessions.get(session.pending.callSid)
    === session
  ) {
    registration.sessions.delete(session.pending.callSid);
  }
}

function sessionIsLive(session: RelaySession): boolean {
  if (
    session.closed
    || session.registration.terminalCalls.has(
      session.pending.callSid,
    )
  ) {
    return false;
  }
  return session.setup
    ? session.registration.sessions.get(
      session.pending.callSid,
    ) === session
    : session.registration.preSetup.has(session);
}

function sendFrame(
  socket: WebSocket,
  frame: Readonly<Record<string, unknown>>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error("voice_call_not_active"));
      return;
    }
    socket.send(JSON.stringify(frame), (error) => {
      if (error) reject(new Error("voice_relay_send_failed"));
      else resolve();
    });
  });
}

function splitText(value: string, limit: number): string[] {
  const codePoints = Array.from(value);
  const chunks: string[] = [];
  for (let index = 0; index < codePoints.length; index += limit) {
    chunks.push(codePoints.slice(index, index + limit).join(""));
  }
  return chunks.length > 0 ? chunks : [""];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringHeader(
  value: string | string[] | undefined,
): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}
