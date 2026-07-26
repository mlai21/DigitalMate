import { describe, expect, it, vi } from "vitest";

import {
  NODE_FRAME_TYPES,
  NODE_MAX_FRAME_BYTES,
  authorizeNodeFrame,
  createNodeFrameDigest,
  createNodeSequenceGuard,
  parseNodeFrame,
} from "@/server/channels/nodes/protocol";
import {
  NODE_OUTBOX_LIMITS,
  classifyNodeHeartbeat,
  evaluateNodeOutboxAdmission,
} from "@/server/channels/nodes/repository";

const NODE_ID = "30000000-0000-4000-8000-000000000001";
const CONNECTION_ID =
  "20000000-0000-4000-8000-000000000001";
const DELIVERY_ID =
  "40000000-0000-4000-8000-000000000001";
const SENT_AT = "2026-07-26T00:00:00.000Z";

describe("channel node protocol", () => {
  it("exposes only transport frames, without Agent capabilities", () => {
    expect(NODE_FRAME_TYPES).toEqual([
      "register",
      "registered",
      "heartbeat",
      "inbound",
      "inbound_ack",
      "send",
      "send_result",
      "attachment_start",
      "attachment_chunk",
      "attachment_commit",
      "attachment_ack",
      "error",
    ]);
  });

  it("keeps attachment chunks below the one MiB frame boundary", () => {
    const chunk = parseNodeFrame({
      type: "attachment_chunk",
      protocolVersion: 1,
      nodeId: NODE_ID,
      sequence: 11,
      sentAt: SENT_AT,
      connectionId: CONNECTION_ID,
      transferId: "a".repeat(64),
      chunkIndex: 0,
      dataBase64: Buffer.alloc(512 * 1024, 0x61)
        .toString("base64"),
    });

    expect(chunk).toMatchObject({
      type: "attachment_chunk",
      transferId: "a".repeat(64),
      chunkIndex: 0,
    });
    expect(() => parseNodeFrame({
      ...chunk,
      dataBase64: Buffer.alloc(800 * 1024, 0x61)
        .toString("base64"),
    })).toThrow("node_frame_too_large");
  });

  it("parses a strict inbound frame and rejects unknown fields", () => {
    const frame = parseNodeFrame(inboundFrame(7));

    expect(frame).toMatchObject({
      type: "inbound",
      protocolVersion: 1,
      nodeId: NODE_ID,
      sequence: 7,
      connectionId: CONNECTION_ID,
    });
    expect(() =>
      parseNodeFrame({
        ...inboundFrame(8),
        tool: "web_search",
      })
    ).toThrow("node_frame_invalid");
    expect(() =>
      parseNodeFrame({
        ...sendFrame(9),
        payload: {
          ...sendFrame(9).payload,
          memory: "read_all",
        },
      })
    ).toThrow("node_frame_invalid");
    expect(() =>
      parseNodeFrame({
        ...inboundFrame(10),
        protocolVersion: 2,
      })
    ).toThrow("node_frame_invalid");
  });

  it("rejects frames larger than one MiB before schema parsing", () => {
    expect(() =>
      parseNodeFrame({
        ...inboundFrame(7),
        payload: {
          ...inboundFrame(7).payload,
          text: "x".repeat(NODE_MAX_FRAME_BYTES),
        },
      })
    ).toThrow("node_frame_too_large");
  });

  it("rejects replayed or non-monotonic sequence numbers", () => {
    const guard = createNodeSequenceGuard({
      [NODE_ID]: 6,
    });

    expect(guard.accept(parseNodeFrame(inboundFrame(7)))).toBe(7);
    expect(() =>
      guard.accept(parseNodeFrame(heartbeatFrame(7)))
    ).toThrow("node_sequence_replayed");
    expect(() =>
      guard.accept(parseNodeFrame(heartbeatFrame(6)))
    ).toThrow("node_sequence_replayed");
    expect(guard.accept(parseNodeFrame(heartbeatFrame(8)))).toBe(8);
  });

  it("hashes the complete normalized frame with canonical object keys", () => {
    const first = parseNodeFrame({
      ...inboundFrame(7),
      payload: {
        ...inboundFrame(7).payload,
        rawSummary: { b: "2", a: "1" },
      },
    });
    const same = parseNodeFrame({
      ...inboundFrame(7),
      payload: {
        ...inboundFrame(7).payload,
        rawSummary: { a: "1", b: "2" },
      },
    });
    const changed = parseNodeFrame({
      ...inboundFrame(7),
      payload: {
        ...inboundFrame(7).payload,
        text: "changed",
        rawSummary: { a: "1", b: "2" },
      },
    });

    expect(createNodeFrameDigest(first)).toEqual(
      createNodeFrameDigest(same),
    );
    expect(createNodeFrameDigest(first)).not.toEqual(
      createNodeFrameDigest(changed),
    );
  });

  it("does not authorize a node for an unbound connection", async () => {
    const isBound = vi.fn(async () => false);
    const frame = parseNodeFrame(inboundFrame(7));

    await expect(
      authorizeNodeFrame(
        {
          id: NODE_ID,
          userId: "10000000-0000-4000-8000-000000000001",
          isBound,
        },
        frame,
      ),
    ).rejects.toThrow("node_connection_not_bound");
    expect(isBound).toHaveBeenCalledWith(CONNECTION_ID);
  });

  it("authorizes only matching nodes and bound send instructions", async () => {
    const isBound = vi.fn(async () => true);
    await expect(
      authorizeNodeFrame(
        {
          id: NODE_ID,
          userId: "10000000-0000-4000-8000-000000000001",
          isBound,
        },
        parseNodeFrame(sendFrame(9)),
      ),
    ).resolves.toBeUndefined();

    await expect(
      authorizeNodeFrame(
        {
          id: "30000000-0000-4000-8000-000000000002",
          userId: "10000000-0000-4000-8000-000000000001",
          isBound,
        },
        parseNodeFrame(sendFrame(10)),
      ),
    ).rejects.toThrow("node_identity_mismatch");
  });
});

describe("channel node queue policy", () => {
  const now = new Date("2026-07-26T00:00:00.000Z");

  it("marks heartbeats stale after 45 seconds and long-offline after 24 hours", () => {
    expect(
      classifyNodeHeartbeat(
        new Date("2026-07-25T23:59:15.000Z"),
        now,
      ),
    ).toBe("connected");
    expect(
      classifyNodeHeartbeat(
        new Date("2026-07-25T23:59:14.999Z"),
        now,
      ),
    ).toBe("disconnected");
    expect(
      classifyNodeHeartbeat(
        new Date("2026-07-24T23:59:59.999Z"),
        now,
      ),
    ).toBe("offline_too_long");
  });

  it("bounds each outbox by item count and serialized bytes", () => {
    const base = {
      lastHeartbeatAt:
        new Date("2026-07-25T23:59:50.000Z"),
      now,
      frameBytes: 1_024,
    };
    expect(
      evaluateNodeOutboxAdmission({
        ...base,
        pendingCount: NODE_OUTBOX_LIMITS.maxItems - 1,
        pendingBytes: 0,
      }),
    ).toEqual({ action: "enqueue" });
    expect(
      evaluateNodeOutboxAdmission({
        ...base,
        pendingCount: NODE_OUTBOX_LIMITS.maxItems,
        pendingBytes: 0,
      }),
    ).toEqual({
      action: "wait",
      reason: "node_outbox_item_limit",
    });
    expect(
      evaluateNodeOutboxAdmission({
        ...base,
        pendingCount: 0,
        pendingBytes:
          NODE_OUTBOX_LIMITS.maxBytes - base.frameBytes + 1,
      }),
    ).toEqual({
      action: "wait",
      reason: "node_outbox_byte_limit",
    });
  });

  it("retains delivery without growing outbox after 24 hours offline", () => {
    expect(
      evaluateNodeOutboxAdmission({
        lastHeartbeatAt:
          new Date("2026-07-24T23:59:59.999Z"),
        now,
        frameBytes: 1_024,
        pendingCount: 0,
        pendingBytes: 0,
      }),
    ).toEqual({
      action: "wait",
      reason: "node_offline_too_long",
    });
  });
});

function heartbeatFrame(sequence: number) {
  return {
    type: "heartbeat",
    protocolVersion: 1,
    nodeId: NODE_ID,
    sequence,
    sentAt: SENT_AT,
  } as const;
}

function inboundFrame(sequence: number) {
  return {
    type: "inbound",
    protocolVersion: 1,
    nodeId: NODE_ID,
    sequence,
    sentAt: SENT_AT,
    connectionId: CONNECTION_ID,
    payload: {
      externalEventId: `event-${sequence}`,
      externalConversationId: "conversation-1",
      externalSenderId: "sender-1",
      chatType: "direct",
      mentioned: false,
      text: "hello",
      thread: {},
      attachments: [],
      occurredAt: SENT_AT,
      rawSummary: {},
    },
  } as const;
}

function sendFrame(sequence: number) {
  return {
    type: "send",
    protocolVersion: 1,
    nodeId: NODE_ID,
    sequence,
    sentAt: SENT_AT,
    connectionId: CONNECTION_ID,
    deliveryId: DELIVERY_ID,
    expiresAt: "2026-07-26T00:05:00.000Z",
    payload: {
      body: "hello",
      recipient: {
        externalConversationId: "conversation-1",
      },
    },
  } as const;
}
