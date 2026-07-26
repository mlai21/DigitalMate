import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createNodeMessageSession,
  createNodeReceiveQueue,
} from "@/server/channels/gateway/node-server";

const NODE_ID = "30000000-0000-4000-8000-000000000001";
const CONNECTION_ID =
  "20000000-0000-4000-8000-000000000001";
const RAW_CERTIFICATE = Buffer.from("der-certificate-fixture");
const FINGERPRINT = createHash("sha256")
  .update(RAW_CERTIFICATE)
  .digest("hex");
const SENT_AT = "2026-07-26T00:00:00.000Z";
const NODE = Object.freeze({
  id: NODE_ID,
  userId: "10000000-0000-4000-8000-000000000001",
  certificateFingerprintHex: FINGERPRINT,
  certificateExpiresAt:
    new Date("2026-08-26T00:00:00.000Z"),
});

describe("channel node message session", () => {
  it("serializes frames from the same WebSocket in arrival order", async () => {
    const order: number[] = [];
    let releaseSecond: (() => void) | undefined;
    const secondCanFinish = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const queue = createNodeReceiveQueue(async (raw) => {
      const sequence = Number(raw.toString());
      order.push(sequence);
      if (sequence === 2) await secondCanFinish;
      order.push(sequence * 10);
    });

    void queue.enqueue(Buffer.from("2"));
    void queue.enqueue(Buffer.from("3"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual([2]);

    releaseSecond?.();
    await queue.drain();
    expect(order).toEqual([2, 20, 3, 30]);
  });

  it("requires register first and binds the claimed fingerprint", async () => {
    const close = vi.fn();
    const send = vi.fn();
    const session = createNodeMessageSession({
      node: NODE,
      repository: repository(),
      send,
      close,
      now: () => new Date(SENT_AT),
    });

    await session.receive(JSON.stringify(heartbeat(1)));
    expect(close).toHaveBeenCalledWith(
      1008,
      "node_register_required",
    );

    const nodeRepository = repository();
    const registered = createNodeMessageSession({
      node: NODE,
      repository: nodeRepository,
      send,
      close,
      now: () => new Date(SENT_AT),
    });
    await registered.receive(
      JSON.stringify(register(FINGERPRINT, 1)),
    );

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "registered",
        nodeId: NODE_ID,
        sequence: 1,
      }),
    );
    expect(
      nodeRepository.recordRegistration,
    ).toHaveBeenCalledWith(
      "10000000-0000-4000-8000-000000000001",
      NODE_ID,
      ["imessage", "sip"],
      "test",
      new Date(SENT_AT),
    );
  });

  it("rejects replayed sequences and unbound connections", async () => {
    const close = vi.fn();
    const nodeRepository = repository();
    const session = createNodeMessageSession({
      node: NODE,
      repository: nodeRepository,
      send: vi.fn(),
      close,
      now: () => new Date(SENT_AT),
    });

    await session.receive(
      JSON.stringify(register(FINGERPRINT, 1)),
    );
    await session.receive(JSON.stringify(heartbeat(2)));
    await session.receive(JSON.stringify(heartbeat(2)));
    expect(close).toHaveBeenCalledWith(
      1008,
      "node_sequence_replayed",
    );

    const unbound = createNodeMessageSession({
      node: NODE,
      repository: repository({ bound: false }),
      send: vi.fn(),
      close,
      now: () => new Date(SENT_AT),
    });
    await unbound.receive(
      JSON.stringify(register(FINGERPRINT, 1)),
    );
    await unbound.receive(
      JSON.stringify(inbound(2)),
    );
    expect(close).toHaveBeenCalledWith(
      1008,
      "node_connection_not_bound",
    );
  });

  it("stops accepting frames after revocation", async () => {
    const close = vi.fn();
    const session = createNodeMessageSession({
      node: NODE,
      repository: repository(),
      send: vi.fn(),
      close,
      now: () => new Date(SENT_AT),
    });

    await session.receive(
      JSON.stringify(register(FINGERPRINT, 1)),
    );
    session.revoke();
    await session.receive(JSON.stringify(heartbeat(2)));

    expect(close).toHaveBeenCalledWith(
      1008,
      "node_certificate_revoked",
    );
    expect(session.isClosed()).toBe(true);
  });

  it("closes an established session once its certificate expires", async () => {
    let current = new Date(SENT_AT);
    const close = vi.fn();
    const session = createNodeMessageSession({
      node: {
        ...NODE,
        certificateExpiresAt:
          new Date("2026-07-26T00:00:01.000Z"),
      },
      repository: repository(),
      send: vi.fn(),
      close,
      now: () => current,
      isAuthorized: async () => true,
    });

    await session.receive(
      JSON.stringify(register(FINGERPRINT, 1)),
    );
    current = new Date("2026-07-26T00:00:01.000Z");
    await session.receive(JSON.stringify(heartbeat(2)));

    expect(close).toHaveBeenCalledWith(
      1008,
      "node_certificate_expired",
    );
    expect(session.isClosed()).toBe(true);
    expect(
      session.isAuthorizedAt(current),
    ).toBe(false);
  });

  it("rejects frame types that are only valid from the server", async () => {
    const close = vi.fn();
    const session = createNodeMessageSession({
      node: NODE,
      repository: repository(),
      send: vi.fn(),
      close,
      now: () => new Date(SENT_AT),
    });

    await session.receive(
      JSON.stringify(register(FINGERPRINT, 1)),
    );
    await session.receive(JSON.stringify({
      type: "registered",
      protocolVersion: 1,
      nodeId: NODE_ID,
      sequence: 2,
      sentAt: SENT_AT,
      heartbeatIntervalMs: 15_000,
      boundConnectionIds: [],
    }));

    expect(close).toHaveBeenCalledWith(
      1008,
      "node_frame_direction_invalid",
    );
  });

  it("does not acknowledge inbound work without a durable handler", async () => {
    const close = vi.fn();
    const nodeRepository = repository();
    const session = createNodeMessageSession({
      node: NODE,
      repository: nodeRepository,
      send: vi.fn(),
      close,
      now: () => new Date(SENT_AT),
    });

    await session.receive(
      JSON.stringify(register(FINGERPRINT, 1)),
    );
    await session.receive(JSON.stringify(inbound(2)));

    expect(close).toHaveBeenCalledWith(
      1008,
      "node_inbound_handler_unavailable",
    );
    expect(nodeRepository.acceptSequence).not.toHaveBeenCalled();
  });

  it("persists and sends an inbound ACK only after the durable handler succeeds", async () => {
    const close = vi.fn();
    const nodeRepository = repository();
    const send = vi.fn();
    const session = createNodeMessageSession({
      node: NODE,
      repository: nodeRepository,
      send,
      close,
      now: () => new Date(SENT_AT),
      onInbound: async () => ({
        disposition: "accepted",
        eventId: "40000000-0000-4000-8000-000000000001",
      }),
    });

    await session.receive(
      JSON.stringify(register(FINGERPRINT, 1)),
    );
    await session.receive(JSON.stringify(inbound(2)));

    expect(nodeRepository.recordInboundAck).toHaveBeenCalledOnce();
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "inbound_ack",
        sequence: 2,
        externalEventId: "imessage:rowid:2",
        disposition: "accepted",
        eventId: "40000000-0000-4000-8000-000000000001",
      }),
    );
    expect(close).not.toHaveBeenCalled();
  });

  it("does not advance inbound sequence when durable handling fails", async () => {
    const close = vi.fn();
    const nodeRepository = repository();
    const session = createNodeMessageSession({
      node: NODE,
      repository: nodeRepository,
      send: vi.fn(),
      close,
      now: () => new Date(SENT_AT),
      onInbound: async () => {
        throw new Error("inbound_persistence_failed");
      },
    });

    await session.receive(
      JSON.stringify(register(FINGERPRINT, 1)),
    );
    await session.receive(JSON.stringify(inbound(2)));

    expect(close).toHaveBeenCalledWith(
      1008,
      "inbound_persistence_failed",
    );
    expect(nodeRepository.recordInboundAck).not.toHaveBeenCalled();
  });

  it("reissues the persisted ACK result on a fresh sequence without rerunning inbound work", async () => {
    const nodeRepository = repository();
    const onInbound = vi.fn(async () => ({
      disposition: "accepted" as const,
      eventId: "40000000-0000-4000-8000-000000000001",
    }));
    const firstSend = vi.fn();
    const first = createNodeMessageSession({
      node: NODE,
      repository: nodeRepository,
      send: firstSend,
      close: vi.fn(),
      now: () => new Date(SENT_AT),
      onInbound,
    });
    await first.receive(JSON.stringify(register(FINGERPRINT, 1)));
    await first.receive(JSON.stringify(inbound(2)));
    const persistedAck = firstSend.mock.calls.at(-1)?.[0];

    const secondSend = vi.fn();
    const second = createNodeMessageSession({
      node: NODE,
      repository: nodeRepository,
      send: secondSend,
      close: vi.fn(),
      now: () => new Date("2026-07-26T00:01:00.000Z"),
      onInbound,
    });
    await second.receive(JSON.stringify(register(FINGERPRINT, 1)));
    await second.receive(JSON.stringify(inbound(2)));

    expect(onInbound).toHaveBeenCalledOnce();
    expect(secondSend.mock.calls.map(([frame]) => frame.sequence))
      .toEqual([3, 4]);
    expect(secondSend).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "inbound_ack",
        externalEventId: persistedAck.externalEventId,
        disposition: persistedAck.disposition,
        eventId: persistedAck.eventId,
        sequence: 4,
      }),
    );
  });

  it("rejects a changed payload that reuses a persisted client sequence", async () => {
    const nodeRepository = repository();
    const first = createNodeMessageSession({
      node: NODE,
      repository: nodeRepository,
      send: vi.fn(),
      close: vi.fn(),
      now: () => new Date(SENT_AT),
      onInbound: async () => ({ disposition: "accepted" }),
    });
    await first.receive(JSON.stringify(register(FINGERPRINT, 1)));
    await first.receive(JSON.stringify(inbound(2)));

    const close = vi.fn();
    const second = createNodeMessageSession({
      node: NODE,
      repository: nodeRepository,
      send: vi.fn(),
      close,
      now: () => new Date(SENT_AT),
      onInbound: vi.fn(),
    });
    await second.receive(JSON.stringify(register(FINGERPRINT, 1)));
    await second.receive(JSON.stringify({
      ...inbound(2),
      payload: {
        ...inbound(2).payload,
        text: "changed payload",
      },
    }));

    expect(close).toHaveBeenCalledWith(
      1008,
      "node_inbound_replay_mismatch",
    );
  });

  it("does not replay a persisted ACK after its connection is unbound", async () => {
    const options = { bound: true };
    const nodeRepository = repository(options);
    const first = createNodeMessageSession({
      node: NODE,
      repository: nodeRepository,
      send: vi.fn(),
      close: vi.fn(),
      now: () => new Date(SENT_AT),
      onInbound: async () => ({ disposition: "accepted" }),
    });
    await first.receive(JSON.stringify(register(FINGERPRINT, 1)));
    await first.receive(JSON.stringify(inbound(2)));
    options.bound = false;

    const close = vi.fn();
    const onInbound = vi.fn();
    const second = createNodeMessageSession({
      node: NODE,
      repository: nodeRepository,
      send: vi.fn(),
      close,
      now: () => new Date(SENT_AT),
      onInbound,
    });
    await second.receive(JSON.stringify(register(FINGERPRINT, 1)));
    await second.receive(JSON.stringify(inbound(2)));

    expect(close).toHaveBeenCalledWith(
      1008,
      "node_connection_not_bound",
    );
    expect(onInbound).not.toHaveBeenCalled();
  });

  it("uses one persistent server sequence across registration, ACK, and later sessions", async () => {
    const nodeRepository = repository();
    const firstSend = vi.fn();
    const first = createNodeMessageSession({
      node: NODE,
      repository: nodeRepository,
      send: firstSend,
      close: vi.fn(),
      now: () => new Date(SENT_AT),
      onInbound: async () => ({ disposition: "ignored" }),
    });
    await first.receive(JSON.stringify(register(FINGERPRINT, 1)));
    await first.receive(JSON.stringify(inbound(2)));

    const secondSend = vi.fn();
    const second = createNodeMessageSession({
      node: NODE,
      repository: nodeRepository,
      send: secondSend,
      close: vi.fn(),
      now: () => new Date(SENT_AT),
    });
    await second.receive(JSON.stringify(register(FINGERPRINT, 1)));

    expect(firstSend.mock.calls.map(([frame]) => frame.sequence))
      .toEqual([1, 2]);
    expect(secondSend).toHaveBeenCalledWith(
      expect.objectContaining({ type: "registered", sequence: 3 }),
    );
  });
});

function repository(options: { bound?: boolean } = {}) {
  let lastSequence = 0;
  let lastServerSequence = 0;
  const inboundAcks = new Map<number, {
    ack: ReturnType<typeof inboundAck>;
    frameDigest: Buffer;
  }>();
  return {
    isBound: vi.fn(async () => options.bound ?? true),
    recordRegistration: vi.fn(async () => undefined),
    allocateServerSequence: vi.fn(async () => {
      lastServerSequence += 1;
      return lastServerSequence;
    }),
    assertSequenceAvailable: vi.fn(async (
      _userId: string,
      _nodeId: string,
      sequence: number,
    ) => {
      if (sequence <= lastSequence) {
        throw new Error("node_sequence_replayed");
      }
    }),
    replayInboundAck: vi.fn(async (input: {
      clientSequence: number;
      frameDigest: Buffer;
      sentAt: Date;
    }) => {
      const receipt = inboundAcks.get(input.clientSequence);
      if (!receipt) return null;
      if (!receipt.frameDigest.equals(input.frameDigest)) {
        throw new Error("node_inbound_replay_mismatch");
      }
      lastServerSequence += 1;
      receipt.ack = {
        ...receipt.ack,
        sequence: lastServerSequence,
        sentAt: input.sentAt.toISOString(),
      };
      return receipt.ack;
    }),
    recordInboundAck: vi.fn(async (input: {
      clientSequence: number;
      connectionId: string;
      externalEventId: string;
      disposition: "accepted" | "duplicate" | "ignored" | "rejected";
      eventId?: string;
      frameDigest: Buffer;
      sentAt: Date;
    }) => {
      const existing = inboundAcks.get(input.clientSequence);
      if (existing) {
        if (!existing.frameDigest.equals(input.frameDigest)) {
          throw new Error("node_inbound_replay_mismatch");
        }
        lastServerSequence += 1;
        existing.ack = {
          ...existing.ack,
          sequence: lastServerSequence,
          sentAt: input.sentAt.toISOString(),
        };
        return existing.ack;
      }
      if (input.clientSequence <= lastSequence) {
        throw new Error("node_sequence_replayed");
      }
      lastSequence = input.clientSequence;
      lastServerSequence += 1;
      const ack = inboundAck({
        sequence: lastServerSequence,
        sentAt: input.sentAt.toISOString(),
        connectionId: input.connectionId,
        externalEventId: input.externalEventId,
        disposition: input.disposition,
        ...(input.eventId ? { eventId: input.eventId } : {}),
      });
      inboundAcks.set(input.clientSequence, {
        ack,
        frameDigest: input.frameDigest,
      });
      return ack;
    }),
    acceptSequence: vi.fn(async (
      _userId: string,
      _nodeId: string,
      sequence: number,
    ) => {
      if (sequence <= lastSequence) {
        throw new Error("node_sequence_replayed");
      }
      lastSequence = sequence;
    }),
    recordHeartbeat: vi.fn(async (
      _userId: string,
      _nodeId: string,
      sequence: number,
    ) => {
      if (sequence <= lastSequence) {
        throw new Error("node_sequence_replayed");
      }
      lastSequence = sequence;
    }),
  };
}

function inboundAck(input: {
  sequence: number;
  sentAt: string;
  connectionId: string;
  externalEventId: string;
  disposition: "accepted" | "duplicate" | "ignored" | "rejected";
  eventId?: string;
}) {
  return {
    type: "inbound_ack" as const,
    protocolVersion: 1 as const,
    nodeId: NODE_ID,
    ...input,
  };
}

function register(fingerprint: string, sequence: number) {
  return {
    type: "register",
    protocolVersion: 1,
    nodeId: NODE_ID,
    sequence,
    sentAt: SENT_AT,
    certificateFingerprint: fingerprint,
    supportedChannelTypes: ["imessage", "sip"],
    clientVersion: "test",
  };
}

function heartbeat(sequence: number) {
  return {
    type: "heartbeat",
    protocolVersion: 1,
    nodeId: NODE_ID,
    sequence,
    sentAt: SENT_AT,
  };
}

function inbound(sequence: number) {
  return {
    type: "inbound",
    protocolVersion: 1,
    nodeId: NODE_ID,
    sequence,
    sentAt: SENT_AT,
    connectionId: CONNECTION_ID,
    payload: {
      externalEventId: `imessage:rowid:${sequence}`,
      externalConversationId: "chat:1",
      externalSenderId: "+8613800000000",
      chatType: "direct",
      mentioned: false,
      text: "hello",
      thread: {},
      attachments: [],
      occurredAt: SENT_AT,
      rawSummary: {},
    },
  };
}
