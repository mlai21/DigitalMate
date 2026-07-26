import { timingSafeEqual } from "node:crypto";
import { createServer, type Server as HttpsServer } from "node:https";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { TLSSocket, TlsOptions } from "node:tls";

import {
  WebSocket,
  WebSocketServer,
  type RawData,
} from "ws";

import {
  NODE_MAX_FRAME_BYTES,
  NODE_PROTOCOL_VERSION,
  authorizeNodeFrame,
  createNodeFrameDigest,
  parseNodeFrame,
  type NodeFrame,
  type NodeInboundAckFrame,
  type NodeInboundFrame,
} from "@/server/channels/nodes/protocol";
import {
  authorizeNodeCertificate,
  type ChannelNodeCertificateRecord,
} from "./tls";

const NODE_PATH = "/channel-node";
const NODE_IDLE_TIMEOUT_MS = 60_000;
const NODE_HEARTBEAT_INTERVAL_MS = 15_000;

type NodeRepository = Readonly<{
  isBound(
    userId: string,
    nodeId: string,
    connectionId: string,
  ): Promise<boolean>;
  acceptSequence(
    userId: string,
    nodeId: string,
    sequence: number,
  ): Promise<void>;
  allocateServerSequence(
    userId: string,
    nodeId: string,
  ): Promise<number>;
  assertSequenceAvailable(
    userId: string,
    nodeId: string,
    sequence: number,
  ): Promise<void>;
  replayInboundAck(input: Readonly<{
    userId: string;
    nodeId: string;
    clientSequence: number;
    frameDigest: Buffer;
    sentAt: Date;
  }>): Promise<NodeInboundAckFrame | null>;
  recordInboundAck(input: Readonly<{
    userId: string;
    nodeId: string;
    connectionId: string;
    clientSequence: number;
    externalEventId: string;
    disposition: NodeInboundAckFrame["disposition"];
    eventId?: string;
    frameDigest: Buffer;
    sentAt: Date;
  }>): Promise<NodeInboundAckFrame>;
  recordHeartbeat(
    userId: string,
    nodeId: string,
    sequence: number,
    receivedAt?: Date,
  ): Promise<void>;
  listBoundConnectionIds?(
    userId: string,
    nodeId: string,
  ): Promise<string[]>;
  recordRegistration?(
    userId: string,
    nodeId: string,
    supportedChannelTypes: Extract<
      NodeFrame,
      { type: "register" }
    >["supportedChannelTypes"],
    clientVersion: string,
    registeredAt?: Date,
  ): Promise<void>;
}>;

type NodeSessionInput = Readonly<{
  node: Readonly<{
    id: string;
    userId: string;
    certificateFingerprintHex: string;
    certificateExpiresAt: Date;
  }>;
  repository: NodeRepository;
  send(frame: NodeFrame): void | Promise<void>;
  close(code: number, reason: string): void;
  now?: () => Date;
  onInbound?: (
    frame: NodeInboundFrame,
  ) => Promise<Readonly<{
    disposition: NodeInboundAckFrame["disposition"];
    eventId?: string;
  }>>;
  onFrame?: (
    frame: NodeFrame,
  ) => Promise<NodeFrame | void>;
  onRegistered?: () => void | Promise<void>;
  onInboundCommitted?: (
    frame: NodeInboundFrame,
    ack: NodeInboundAckFrame,
  ) => void | Promise<void>;
  isAuthorized?: () => Promise<boolean>;
}>;

export function createNodeReceiveQueue(
  receive: (raw: Buffer) => Promise<void>,
) {
  const queue = createNodeTaskQueue();
  return {
    enqueue(raw: Buffer): Promise<void> {
      return queue.enqueue(() => receive(raw));
    },
    drain(): Promise<void> {
      return queue.drain();
    },
  };
}

function createNodeTaskQueue() {
  let pending = Promise.resolve();
  return {
    enqueue(task: () => Promise<void>): Promise<void> {
      pending = pending
        .catch(() => undefined)
        .then(task);
      return pending;
    },
    drain(): Promise<void> {
      return pending;
    },
  };
}

export function createNodeMessageSession(input: NodeSessionInput) {
  const now = input.now ?? (() => new Date());
  if (
    !Number.isFinite(
      input.node.certificateExpiresAt.getTime(),
    )
  ) {
    throw new Error("node_certificate_expiry_invalid");
  }
  let registered = false;
  let closed = false;

  const close = (reason: string) => {
    if (closed) return;
    closed = true;
    input.close(1008, boundedCloseReason(reason));
  };

  return {
    async receive(raw: string | Buffer): Promise<void> {
      if (closed) return;
      try {
        if (now() >= input.node.certificateExpiresAt) {
          throw new Error("node_certificate_expired");
        }
        if (
          input.isAuthorized
          && !await input.isAuthorized()
        ) {
          throw new Error("node_certificate_revoked");
        }
        if (
          Buffer.byteLength(raw)
          > NODE_MAX_FRAME_BYTES
        ) {
          throw new Error("node_frame_too_large");
        }
        const value = JSON.parse(raw.toString());
        const frame = parseNodeFrame(value);
        if (!registered) {
          if (frame.type !== "register") {
            throw new Error("node_register_required");
          }
          assertRegisterFrame(
            frame,
            input.node.id,
            input.node.certificateFingerprintHex,
          );
          await input.repository.recordRegistration?.(
            input.node.userId,
            input.node.id,
            frame.supportedChannelTypes,
            frame.clientVersion,
            now(),
          );
          const serverSequence =
            await input.repository.allocateServerSequence(
            input.node.userId,
            input.node.id,
          );
          const boundConnectionIds =
            await input.repository.listBoundConnectionIds?.(
              input.node.userId,
              input.node.id,
            ) ?? [];
          registered = true;
          await input.send(parseNodeFrame({
            type: "registered",
            protocolVersion: NODE_PROTOCOL_VERSION,
            nodeId: input.node.id,
            sequence: serverSequence,
            sentAt: now().toISOString(),
            heartbeatIntervalMs: NODE_HEARTBEAT_INTERVAL_MS,
            boundConnectionIds,
          }));
          await input.onRegistered?.();
          return;
        }
        if (frame.type === "register") {
          throw new Error("node_already_registered");
        }
        if (
          frame.type === "registered"
          || frame.type === "inbound_ack"
          || frame.type === "send"
          || frame.type === "attachment_ack"
        ) {
          throw new Error("node_frame_direction_invalid");
        }
        if (frame.nodeId !== input.node.id) {
          throw new Error("node_identity_mismatch");
        }
        await authorizeNodeFrame(
          {
            id: input.node.id,
            userId: input.node.userId,
            isBound: (connectionId) =>
              input.repository.isBound(
                input.node.userId,
                input.node.id,
                connectionId,
              ),
          },
          frame,
        );
        const inboundFrameDigest = frame.type === "inbound"
          ? createNodeFrameDigest(frame)
          : undefined;
        if (frame.type === "inbound") {
          const replayedAck =
            await input.repository.replayInboundAck({
              userId: input.node.userId,
              nodeId: input.node.id,
              clientSequence: frame.sequence,
              frameDigest: inboundFrameDigest!,
              sentAt: now(),
            });
          if (replayedAck) {
            assertInboundAckMatches(replayedAck, frame);
            await input.onInboundCommitted?.(
              frame,
              replayedAck,
            );
            await input.send(replayedAck);
            return;
          }
        }
        if (frame.type === "inbound" && !input.onInbound) {
          throw new Error("node_inbound_handler_unavailable");
        }
        if (
          (
            frame.type === "send_result"
            || frame.type === "attachment_start"
            || frame.type === "attachment_chunk"
            || frame.type === "attachment_commit"
            || frame.type === "error"
          )
          && !input.onFrame
        ) {
          throw new Error("node_result_handler_unavailable");
        }
        if (frame.type === "heartbeat") {
          await input.repository.recordHeartbeat(
            input.node.userId,
            input.node.id,
            frame.sequence,
            now(),
          );
        } else {
          if (frame.type === "inbound") {
            const result = await input.onInbound!(frame);
            const ack =
              await input.repository.recordInboundAck({
                userId: input.node.userId,
                nodeId: input.node.id,
                connectionId: frame.connectionId,
                clientSequence: frame.sequence,
                externalEventId:
                  frame.payload.externalEventId,
                disposition: result.disposition,
                ...(result.eventId
                  ? { eventId: result.eventId }
                  : {}),
                frameDigest: inboundFrameDigest!,
                sentAt: now(),
              });
            await input.onInboundCommitted?.(frame, ack);
            await input.send(ack);
          } else {
            await input.repository.assertSequenceAvailable(
              input.node.userId,
              input.node.id,
              frame.sequence,
            );
            const response = await input.onFrame?.(frame);
            await input.repository.acceptSequence(
              input.node.userId,
              input.node.id,
              frame.sequence,
            );
            if (response) await input.send(response);
          }
        }
      } catch (error) {
        close(stableNodeErrorCode(error));
      }
    },

    revoke(): void {
      close("node_certificate_revoked");
    },

    replace(): void {
      close("node_session_replaced");
    },

    expire(): void {
      close("node_certificate_expired");
    },

    isAuthorizedAt(at: Date): boolean {
      if (
        !Number.isFinite(at.getTime())
        || at >= input.node.certificateExpiresAt
      ) {
        close("node_certificate_expired");
        return false;
      }
      return !closed;
    },

    isClosed(): boolean {
      return closed;
    },
  };
}

export function createChannelNodeServer(input: Readonly<{
  tls: TlsOptions;
  repository: NodeRepository & Readonly<{
    findByCertificateFingerprint(
      fingerprint: Buffer,
    ): Promise<ChannelNodeCertificateRecord | null>;
  }>;
  host?: string;
  port: number;
  idleTimeoutMs?: number;
  idleSweepIntervalMs?: number;
  now?: () => Date;
  onInbound?: (
    node: ChannelNodeCertificateRecord,
    frame: NodeInboundFrame,
  ) => Promise<Readonly<{
    disposition: NodeInboundAckFrame["disposition"];
    eventId?: string;
  }>>;
  onFrame?: (
    node: ChannelNodeCertificateRecord,
    frame: NodeFrame,
  ) => Promise<NodeFrame | void>;
  onRegistered?: (
    node: ChannelNodeCertificateRecord,
  ) => void | Promise<void>;
  onDisconnected?: (
    node: ChannelNodeCertificateRecord,
  ) => void | Promise<void>;
  onInboundCommitted?: (
    node: ChannelNodeCertificateRecord,
    frame: NodeInboundFrame,
    ack: NodeInboundAckFrame,
  ) => void | Promise<void>;
}>) {
  const idleTimeoutMs =
    input.idleTimeoutMs ?? NODE_IDLE_TIMEOUT_MS;
  const idleSweepIntervalMs =
    input.idleSweepIntervalMs ?? NODE_HEARTBEAT_INTERVAL_MS;
  if (
    !Number.isSafeInteger(idleTimeoutMs)
    || idleTimeoutMs < 1
    || !Number.isSafeInteger(idleSweepIntervalMs)
    || idleSweepIntervalMs < 1
  ) {
    throw new Error("channel_node_idle_timeout_invalid");
  }
  const webSockets = new WebSocketServer({
    noServer: true,
    maxPayload: NODE_MAX_FRAME_BYTES,
    perMessageDeflate: false,
  });
  webSockets.on("error", () => undefined);
  const sessions = new Map<
    string,
    Set<{
      socket: WebSocket;
      session: ReturnType<typeof createNodeMessageSession>;
      receiveQueue: ReturnType<typeof createNodeTaskQueue>;
      certificateFingerprint: Buffer;
    }>
  >();
  const nodeReceiveQueues = new Map<
    string,
    ReturnType<typeof createNodeTaskQueue>
  >();
  const networkSockets = new Set<Duplex>();
  let accepting = true;
  const server = createServer(
    input.tls,
    (_request, response) => {
      response.writeHead(404).end();
    },
  );

  server.on("upgrade", (request, socket, head) => {
    void authorizeUpgrade(request, socket, head);
  });
  server.on("connection", (socket) => {
    networkSockets.add(socket);
    socket.once("close", () => {
      networkSockets.delete(socket);
    });
  });

  const idleTimer = setInterval(() => {
    const wallNow = Date.now();
    const authorizationNow =
      input.now?.() ?? new Date(wallNow);
    for (const connections of sessions.values()) {
      for (const connection of connections) {
        if (
          !connection.session.isAuthorizedAt(
            authorizationNow,
          )
        ) {
          continue;
        }
        const lastActivity =
          (connection.socket as WebSocket & {
            lastActivity?: number;
          }).lastActivity ?? wallNow;
        if (wallNow - lastActivity > idleTimeoutMs) {
          connection.socket.terminate();
        } else if (
          connection.socket.readyState === WebSocket.OPEN
        ) {
          connection.socket.ping();
        }
      }
    }
  }, idleSweepIntervalMs);
  idleTimer.unref();

  async function authorizeUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    let pathname: string;
    try {
      pathname = new URL(
        request.url ?? "/",
        "https://channel-node.invalid",
      ).pathname;
    } catch {
      rejectUpgrade(socket, 400);
      return;
    }
    if (!accepting || pathname !== NODE_PATH) {
      rejectUpgrade(socket, 404);
      return;
    }
    const tlsSocket = request.socket as TLSSocket;
    if (!tlsSocket.authorized) {
      rejectUpgrade(socket, 401);
      return;
    }
    try {
      const certificate = tlsSocket.getPeerCertificate(true);
      const node = await authorizeNodeCertificate(
        certificate,
        input.repository,
        input.now?.() ?? new Date(),
      );
      webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        acceptWebSocket(webSocket, node);
      });
    } catch {
      rejectUpgrade(socket, 403);
    }
  }

  function acceptWebSocket(
    socket: WebSocket,
    node: ChannelNodeCertificateRecord,
  ): void {
    for (const existing of sessions.get(node.id) ?? []) {
      existing.session.replace();
    }
    const tracked = socket as WebSocket & {
      lastActivity?: number;
    };
    tracked.lastActivity = Date.now();
    const session = createNodeMessageSession({
        node: {
          id: node.id,
          userId: node.userId,
          certificateFingerprintHex:
            node.certificateFingerprint.toString("hex"),
          certificateExpiresAt:
            node.certificateExpiresAt,
        },
        repository: input.repository,
        send: (frame) => sendWebSocketFrame(socket, frame),
        close: (code, reason) => socket.close(code, reason),
        isAuthorized: async () => {
          const checkedAt =
            input.now?.() ?? new Date();
          if (checkedAt >= node.certificateExpiresAt) {
            throw new Error("node_certificate_expired");
          }
          const current =
            await input.repository.findByCertificateFingerprint(
              node.certificateFingerprint,
            );
          if (
            current
            && checkedAt >= current.certificateExpiresAt
          ) {
            throw new Error("node_certificate_expired");
          }
          return current?.id === node.id
            && current.userId === node.userId
            && current.agentId === node.agentId
            && current.status !== "revoked";
        },
        ...(input.now ? { now: input.now } : {}),
        ...(input.onInbound
          ? {
              onInbound: (frame) =>
                input.onInbound!(node, frame),
            }
          : {}),
        ...(input.onFrame
          ? {
              onFrame: (frame) =>
                input.onFrame!(node, frame),
            }
          : {}),
        ...(input.onRegistered
          ? {
              onRegistered: () =>
                input.onRegistered!(node),
            }
          : {}),
        ...(input.onInboundCommitted
          ? {
              onInboundCommitted: (frame, ack) =>
                input.onInboundCommitted!(
                  node,
                  frame,
                  ack,
                ),
            }
          : {}),
    });
    const receiveQueue =
      nodeReceiveQueues.get(node.id)
      ?? createNodeTaskQueue();
    nodeReceiveQueues.set(node.id, receiveQueue);
    const entry = {
      socket,
      session,
      receiveQueue,
      certificateFingerprint:
        Buffer.from(node.certificateFingerprint),
    };
    const cancelCertificateExpiry =
      scheduleCertificateExpiry(
        node.certificateExpiresAt,
        () => session.expire(),
      );
    const nodeSessions = sessions.get(node.id) ?? new Set();
    nodeSessions.add(entry);
    sessions.set(node.id, nodeSessions);
    socket.on("pong", () => {
      tracked.lastActivity = Date.now();
    });
    socket.on("message", (data: RawData, isBinary: boolean) => {
      tracked.lastActivity = Date.now();
      if (!accepting) {
        socket.close(1012, "channel_node_server_stopping");
        return;
      }
      if (isBinary) {
        socket.close(1003, "node_binary_frame_rejected");
        return;
      }
      const raw = rawDataToBuffer(data);
      void entry.receiveQueue.enqueue(() =>
        session.receive(raw)
      )
        .catch(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.close(1011, "node_frame_processing_failed");
          }
        });
    });
    socket.on("error", () => {
      socket.terminate();
    });
    socket.once("close", () => {
      cancelCertificateExpiry();
      nodeSessions.delete(entry);
      if (nodeSessions.size === 0) {
        sessions.delete(node.id);
        const cleanup = receiveQueue.enqueue(async () => {
          if (
            !sessions.has(node.id)
            && nodeReceiveQueues.get(node.id)
              === receiveQueue
          ) {
            await input.onDisconnected?.(node);
          }
        });
        void cleanup.finally(() => {
          if (
            !sessions.has(node.id)
            && nodeReceiveQueues.get(node.id)
              === receiveQueue
          ) {
            nodeReceiveQueues.delete(node.id);
          }
        }).catch(() => undefined);
      }
    });
  }

  return {
    async start(): Promise<{ port: number }> {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(input.port, input.host ?? "0.0.0.0");
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("channel_node_address_unavailable");
      }
      return { port: address.port };
    },

    revokeNode(nodeId: string): void {
      for (const entry of sessions.get(nodeId) ?? []) {
        entry.session.revoke();
      }
    },

    async sendFrame(
      nodeId: string,
      frame: NodeFrame,
    ): Promise<boolean> {
      const entries = [...(sessions.get(nodeId) ?? [])]
        .filter(({ socket, session }) =>
          socket.readyState === WebSocket.OPEN
          && !session.isClosed()
        )
        .reverse();
      for (const target of entries) {
        const checkedAt = input.now?.() ?? new Date();
        if (!target.session.isAuthorizedAt(checkedAt)) {
          continue;
        }
        const current =
          await input.repository.findByCertificateFingerprint(
            target.certificateFingerprint,
          );
        if (
          !current
          || current.id !== nodeId
          || current.status === "revoked"
        ) {
          target.session.revoke();
          continue;
        }
        if (checkedAt >= current.certificateExpiresAt) {
          target.session.expire();
          continue;
        }
        await sendWebSocketFrame(target.socket, frame);
        return true;
      }
      return false;
    },

    async stop(drainMs = 5_000): Promise<void> {
      accepting = false;
      clearInterval(idleTimer);
      const serverClosed = beginCloseHttpsServer(server);
      const deadline = Date.now() + Math.max(0, drainMs);
      const queues = [...nodeReceiveQueues.values()]
        .map((queue) => queue.drain());
      await Promise.race([
        Promise.allSettled(queues),
        delayUntil(deadline),
      ]);
      while (
        Date.now() < deadline
        && [...sessions.values()].some((entries) =>
          [...entries].some(({ socket }) => socket.bufferedAmount > 0)
        )
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      for (const entries of sessions.values()) {
        for (const { socket } of entries) {
          socket.close(1001, "channel_node_server_stopping");
        }
      }
      await closeNodeWebSocketServer(
        webSockets,
        sessions,
        deadline,
      );
      for (const socket of networkSockets) socket.destroy();
      await serverClosed;
    },
  };
}

async function closeNodeWebSocketServer(
  server: WebSocketServer,
  sessions: ReadonlyMap<
    string,
    ReadonlySet<{ socket: WebSocket }>
  >,
  deadline: number,
): Promise<void> {
  const closed = new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  await Promise.race([closed, delayUntil(deadline)]);
  for (const entries of sessions.values()) {
    for (const { socket } of entries) socket.terminate();
  }
  await closed;
}

async function delayUntil(deadline: number): Promise<void> {
  const remaining = Math.max(0, deadline - Date.now());
  if (remaining === 0) return;
  await new Promise((resolve) => setTimeout(resolve, remaining));
}

function scheduleCertificateExpiry(
  expiresAt: Date,
  expire: () => void,
): () => void {
  const maximumDelay = 2_147_000_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const schedule = () => {
    if (cancelled) return;
    const remaining = expiresAt.getTime() - Date.now();
    if (remaining <= 0) {
      expire();
      return;
    }
    timer = setTimeout(
      schedule,
      Math.min(remaining, maximumDelay),
    );
    timer.unref();
  };
  schedule();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}

function assertRegisterFrame(
  frame: Extract<NodeFrame, { type: "register" }>,
  nodeId: string,
  fingerprintHex: string,
): void {
  if (frame.nodeId !== nodeId) {
    throw new Error("node_identity_mismatch");
  }
  const claimed = Buffer.from(
    frame.certificateFingerprint,
    "hex",
  );
  const actual = Buffer.from(fingerprintHex, "hex");
  if (
    claimed.length !== actual.length
    || !timingSafeEqual(claimed, actual)
  ) {
    throw new Error("node_certificate_mismatch");
  }
}

function assertInboundAckMatches(
  ack: NodeInboundAckFrame,
  inbound: NodeInboundFrame,
): void {
  if (
    ack.connectionId !== inbound.connectionId
    || ack.externalEventId
      !== inbound.payload.externalEventId
  ) {
    throw new Error("node_inbound_replay_mismatch");
  }
}

function sendWebSocketFrame(
  socket: WebSocket,
  frame: NodeFrame,
): Promise<void> {
  if (socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(
      new Error("node_socket_not_open"),
    );
  }
  return new Promise<void>((resolve, reject) => {
    socket.send(JSON.stringify(frame), (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function stableNodeErrorCode(error: unknown): string {
  if (
    error instanceof Error
    && /^[a-z][a-z0-9_]{0,122}$/.test(error.message)
  ) {
    return error.message;
  }
  return "node_frame_rejected";
}

function boundedCloseReason(reason: string): string {
  return reason.slice(0, 123);
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function rejectUpgrade(socket: Duplex, status: number): void {
  if (!socket.destroyed) {
    socket.end(
      `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`,
    );
  }
}

function beginCloseHttpsServer(
  server: HttpsServer,
): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
