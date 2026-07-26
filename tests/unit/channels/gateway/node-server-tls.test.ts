import { createHash, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { connect as connectTls } from "node:tls";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import {
  createChannelNodeServer,
} from "@/server/channels/gateway/node-server";
import {
  buildNodeTlsOptions,
} from "@/server/channels/gateway/tls";
import {
  NODE_MAX_FRAME_BYTES,
  type NodeInboundFrame,
} from "@/server/channels/nodes/protocol";
import {
  TEST_NODE_CA_CERTIFICATE,
  TEST_NODE_CLIENT_CERTIFICATE,
  TEST_NODE_CLIENT_KEY,
  TEST_NODE_ROGUE_CLIENT_CERTIFICATE,
  TEST_NODE_ROGUE_CLIENT_KEY,
  TEST_NODE_SERVER_CERTIFICATE,
  TEST_NODE_SERVER_KEY,
} from "../../../fixtures/channels/gateway/node-tls";

const NODE_ID = "30000000-0000-4000-8000-000000000001";
const USER_ID = "10000000-0000-4000-8000-000000000001";
const CLIENT_FINGERPRINT = createHash("sha256")
  .update(new X509Certificate(
    TEST_NODE_CLIENT_CERTIFICATE,
  ).raw)
  .digest();
const CLIENT_FINGERPRINT_HEX =
  CLIENT_FINGERPRINT.toString("hex");

describe("channel node mTLS WebSocket server", () => {
  const servers: Array<
    ReturnType<typeof createChannelNodeServer>
  > = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.terminate();
    }
    for (const server of servers.splice(0)) {
      await server.stop(100);
    }
  });

  it("accepts a trusted known node and completes registration", async () => {
    const repository = nodeRepository();
    const { server, port } = await startServer(repository);
    servers.push(server);
    const socket = await connectNode(port);
    sockets.push(socket);

    socket.send(JSON.stringify(registerFrame()));
    const frame = await readFrame(socket);

    expect(frame).toMatchObject({
      type: "registered",
      nodeId: NODE_ID,
      sequence: 1,
    });
  });

  it("rejects clients signed by another CA before upgrade", async () => {
    const { server, port } = await startServer(nodeRepository());
    servers.push(server);

    await expect(connectNode(port, "/channel-node", {
      certificate: TEST_NODE_ROGUE_CLIENT_CERTIFICATE,
      privateKey: TEST_NODE_ROGUE_CLIENT_KEY,
    })).rejects.toThrow();
  });

  it.each(["unknown", "revoked"] as const)(
    "rejects a %s certificate identity during upgrade",
    async (status) => {
      const { server, port } = await startServer(
        nodeRepository({ status }),
      );
      servers.push(server);

      await expect(connectNode(port)).rejects.toThrow(
        /403|Unexpected server response/,
      );
    },
  );

  it("accepts only the exact node path", async () => {
    const { server, port } = await startServer(nodeRepository());
    servers.push(server);

    await expect(
      connectNode(port, "/channel-node/extra"),
    ).rejects.toThrow(/404|Unexpected server response/);
  });

  it("closes an oversized frame while keeping the server available", async () => {
    const repository = nodeRepository();
    const { server, port } = await startServer(repository);
    servers.push(server);
    const oversized = await connectNode(port);
    sockets.push(oversized);
    oversized.send(JSON.stringify(registerFrame()));
    await readFrame(oversized);

    oversized.send("x".repeat(NODE_MAX_FRAME_BYTES + 1));
    const [code] = await once(oversized, "close") as [number];
    expect([1006, 1009]).toContain(code);

    const replacement = await connectNode(port);
    sockets.push(replacement);
    replacement.send(JSON.stringify(registerFrame()));
    await expect(readFrame(replacement)).resolves.toMatchObject({
      type: "registered",
      sequence: 2,
    });
  });

  it("drains durable inbound work and its ACK before shutdown", async () => {
    let releaseInbound: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const canFinish = new Promise<void>((resolve) => {
      releaseInbound = resolve;
    });
    const repository = nodeRepository();
    const { server, port } = await startServer(
      repository,
      async () => {
        markStarted?.();
        await canFinish;
        return {
          disposition: "accepted",
          eventId:
            "40000000-0000-4000-8000-000000000001",
        };
      },
    );
    const socket = await connectNode(port);
    sockets.push(socket);
    socket.send(JSON.stringify(registerFrame()));
    await readFrame(socket);
    socket.send(JSON.stringify(inboundFrame(1)));
    await started;

    let stopped = false;
    const stopping = server.stop(1_000).then(() => {
      stopped = true;
    });
    const ackPromise = readFrame(socket);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stopped).toBe(false);

    releaseInbound?.();
    await expect(ackPromise).resolves.toMatchObject({
      type: "inbound_ack",
      externalEventId: "imessage:rowid:1",
      disposition: "accepted",
    });
    await stopping;
  });

  it("fails closed on live per-frame certificate revocation", async () => {
    const repository = nodeRepository();
    const { server, port } = await startServer(repository);
    servers.push(server);
    const socket = await connectNode(port);
    sockets.push(socket);
    socket.send(JSON.stringify(registerFrame()));
    await readFrame(socket);

    repository.setStatus("revoked");
    socket.send(JSON.stringify(heartbeatFrame(1)));
    const [code, reason] = await once(socket, "close") as [
      number,
      Buffer,
    ];
    expect(code).toBe(1008);
    expect(reason.toString()).toBe(
      "node_certificate_revoked",
    );
  });

  it("keeps only one active WebSocket session for each node", async () => {
    const repository = nodeRepository();
    const { server, port } = await startServer(repository);
    servers.push(server);
    const first = await connectNode(port);
    sockets.push(first);
    first.send(JSON.stringify(registerFrame()));
    await readFrame(first);
    const firstClosed = once(first, "close");

    const second = await connectNode(port);
    sockets.push(second);
    const [code, reason] = await firstClosed as [
      number,
      Buffer,
    ];
    expect(code).toBe(1008);
    expect(reason.toString()).toBe("node_session_replaced");
    second.send(JSON.stringify(registerFrame()));
    await expect(readFrame(second)).resolves.toMatchObject({
      type: "registered",
      sequence: 2,
    });
  });

  it("does not let a non-upgraded TLS socket block shutdown", async () => {
    const { server, port } = await startServer(nodeRepository());
    const socket = connectTls({
      host: "127.0.0.1",
      port,
      servername: "localhost",
      ca: TEST_NODE_CA_CERTIFICATE,
      cert: TEST_NODE_CLIENT_CERTIFICATE,
      key: TEST_NODE_CLIENT_KEY,
      rejectUnauthorized: true,
    });
    await once(socket, "secureConnect");
    socket.on("error", () => undefined);

    try {
      const closed = new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
      });
      await expect(server.stop(20)).resolves.toBeUndefined();
      await closed;
      expect(socket.destroyed).toBe(true);
    } finally {
      socket.destroy();
    }
  });

  it("serializes in-flight inbound work across a reconnect for the same node", async () => {
    let releaseFirst: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const handled: number[] = [];
    const repository = nodeRepository();
    const { server, port } = await startServer(
      repository,
      async (frame) => {
        if (frame.sequence === 1) {
          markFirstStarted?.();
          await firstCanFinish;
        }
        handled.push(frame.sequence);
        return { disposition: "accepted" };
      },
    );
    servers.push(server);
    const first = await connectNode(port);
    sockets.push(first);
    first.on("error", () => undefined);
    first.send(JSON.stringify(registerFrame()));
    await readFrame(first);
    first.send(JSON.stringify(inboundFrame(1)));
    await firstStarted;

    const second = await connectNode(port);
    sockets.push(second);
    second.send(JSON.stringify(registerFrame()));
    let registered = false;
    const registeredFrame = readFrame(second).then((frame) => {
      registered = true;
      return frame;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(registered).toBe(false);

    releaseFirst?.();
    await expect(registeredFrame).resolves.toMatchObject({
      type: "registered",
      sequence: 3,
    });
    second.send(JSON.stringify(inboundFrame(2)));
    await expect(readFrame(second)).resolves.toMatchObject({
      type: "inbound_ack",
      sequence: 4,
      externalEventId: "imessage:rowid:2",
    });
    expect(handled).toEqual([1, 2]);
  });

  it("rejects a malformed mTLS upgrade target without stopping the node server", async () => {
    const { server, port } = await startServer(nodeRepository());
    servers.push(server);
    const socket = connectTls({
      host: "127.0.0.1",
      port,
      servername: "localhost",
      ca: TEST_NODE_CA_CERTIFICATE,
      cert: TEST_NODE_CLIENT_CERTIFICATE,
      key: TEST_NODE_CLIENT_KEY,
      rejectUnauthorized: true,
    });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", () => undefined);
    await once(socket, "secureConnect");
    const closed = new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
    });
    socket.write(
      "GET //[ HTTP/1.1\r\n"
        + "Host: localhost\r\n"
        + "Connection: Upgrade\r\n"
        + "Upgrade: websocket\r\n"
        + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
        + "Sec-WebSocket-Version: 13\r\n\r\n",
    );
    await closed;
    expect(Buffer.concat(chunks).toString("utf8"))
      .toContain("HTTP/1.1 400");

    const replacement = await connectNode(port);
    sockets.push(replacement);
    replacement.send(JSON.stringify(registerFrame()));
    await expect(readFrame(replacement)).resolves.toMatchObject({
      type: "registered",
    });
  });

  it("terminates an idle node without pong and keeps a responsive node", async () => {
    const repository = nodeRepository();
    const { server, port } = await startServer(
      repository,
      undefined,
      {
        idleTimeoutMs: 40,
        idleSweepIntervalMs: 10,
      },
    );
    servers.push(server);
    const idle = await connectNode(
      port,
      "/channel-node",
      undefined,
      false,
    );
    sockets.push(idle);
    idle.on("error", () => undefined);
    idle.send(JSON.stringify(registerFrame()));
    await readFrame(idle);

    const [code] = await once(idle, "close") as [number];
    expect(code).toBe(1006);

    const responsive = await connectNode(port);
    sockets.push(responsive);
    responsive.send(JSON.stringify(registerFrame()));
    await readFrame(responsive);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(responsive.readyState).toBe(WebSocket.OPEN);
  });
});

async function startServer(
  repository: ReturnType<typeof nodeRepository>,
  onInbound?: (
    frame: NodeInboundFrame,
  ) => Promise<Readonly<{
    disposition:
      | "accepted"
      | "duplicate"
      | "ignored"
      | "rejected";
    eventId?: string;
  }>>,
  serverOptions: Readonly<{
    idleTimeoutMs?: number;
    idleSweepIntervalMs?: number;
  }> = {},
) {
  const server = createChannelNodeServer({
    host: "127.0.0.1",
    port: 0,
    tls: buildNodeTlsOptions({
      certificate: Buffer.from(TEST_NODE_SERVER_CERTIFICATE),
      privateKey: Buffer.from(TEST_NODE_SERVER_KEY),
      certificateAuthority: Buffer.from(
        TEST_NODE_CA_CERTIFICATE,
      ),
    }),
    repository,
    ...serverOptions,
    ...(onInbound
      ? {
          onInbound: async (_node, frame) =>
            onInbound(frame),
        }
      : {}),
  });
  const { port } = await server.start();
  return { server, port };
}

async function connectNode(
  port: number,
  pathname = "/channel-node",
  credentials: Readonly<{
    certificate: string;
    privateKey: string;
  }> | undefined = undefined,
  autoPong = true,
): Promise<WebSocket> {
  const resolvedCredentials = credentials ?? {
    certificate: TEST_NODE_CLIENT_CERTIFICATE,
    privateKey: TEST_NODE_CLIENT_KEY,
  };
  const socket = new WebSocket(
    `wss://localhost:${port}${pathname}`,
    {
      ca: TEST_NODE_CA_CERTIFICATE,
      cert: resolvedCredentials.certificate,
      key: resolvedCredentials.privateKey,
      rejectUnauthorized: true,
      autoPong,
      perMessageDeflate: false,
    },
  );
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      socket.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      socket.off("open", onOpen);
      reject(error);
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
  });
  return socket;
}

async function readFrame(
  socket: WebSocket,
): Promise<Record<string, unknown>> {
  const [raw] = await once(socket, "message");
  return JSON.parse(raw.toString()) as Record<string, unknown>;
}

function registerFrame() {
  return {
    type: "register",
    protocolVersion: 1,
    nodeId: NODE_ID,
    sequence: 1,
    sentAt: new Date().toISOString(),
    certificateFingerprint: CLIENT_FINGERPRINT_HEX,
    supportedChannelTypes: ["imessage", "sip"],
    clientVersion: "test",
  };
}

function heartbeatFrame(sequence: number) {
  return {
    type: "heartbeat" as const,
    protocolVersion: 1 as const,
    nodeId: NODE_ID,
    sequence,
    sentAt: new Date().toISOString(),
  };
}

function inboundFrame(sequence: number) {
  return {
    type: "inbound" as const,
    protocolVersion: 1 as const,
    nodeId: NODE_ID,
    sequence,
    sentAt: new Date().toISOString(),
    connectionId:
      "20000000-0000-4000-8000-000000000001",
    payload: {
      externalEventId: `imessage:rowid:${sequence}`,
      externalConversationId: "chat:1",
      externalSenderId: "+8613800000000",
      chatType: "direct" as const,
      mentioned: false,
      text: "hello",
      thread: {},
      attachments: [],
      occurredAt: new Date().toISOString(),
      rawSummary: {},
    },
  };
}

function nodeRepository(options: {
  status?: "unknown" | "revoked" | "disconnected";
} = {}) {
  let serverSequence = 0;
  let clientSequence = 0;
  let status = options.status ?? "disconnected";
  return {
    setStatus(next: typeof status) {
      status = next;
    },
    findByCertificateFingerprint: async (
      fingerprint: Buffer,
    ) => (
      status === "unknown"
      || !fingerprint.equals(CLIENT_FINGERPRINT)
        ? null
        : {
            id: NODE_ID,
            userId: USER_ID,
            status,
            certificateFingerprint: CLIENT_FINGERPRINT,
          }
    ),
    isBound: async () => true,
    listBoundConnectionIds: async () => [],
    allocateServerSequence: async () => {
      serverSequence += 1;
      return serverSequence;
    },
    assertSequenceAvailable: async (
      _userId: string,
      _nodeId: string,
      sequence: number,
    ) => {
      if (sequence <= clientSequence) {
        throw new Error("node_sequence_replayed");
      }
    },
    replayInboundAck: async () => null,
    recordInboundAck: async (input: {
      nodeId: string;
      connectionId: string;
      clientSequence: number;
      externalEventId: string;
      disposition:
        | "accepted"
        | "duplicate"
        | "ignored"
        | "rejected";
      eventId?: string;
      frameDigest: Buffer;
      sentAt: Date;
    }) => {
      clientSequence = input.clientSequence;
      serverSequence += 1;
      return {
        type: "inbound_ack" as const,
        protocolVersion: 1 as const,
        nodeId: input.nodeId,
        sequence: serverSequence,
        sentAt: input.sentAt.toISOString(),
        connectionId: input.connectionId,
        externalEventId: input.externalEventId,
        ...(input.eventId ? { eventId: input.eventId } : {}),
        disposition: input.disposition,
      };
    },
    acceptSequence: async (
      _userId: string,
      _nodeId: string,
      sequence: number,
    ) => {
      clientSequence = sequence;
    },
    recordHeartbeat: async (
      _userId: string,
      _nodeId: string,
      sequence: number,
    ) => {
      clientSequence = sequence;
    },
  };
}
