import { describe, expect, it } from "vitest";

import {
  normalizeNodeInbound,
} from "@/server/channels/nodes/runtime-bridge";
import {
  parseNodeFrame,
  type NodeInboundFrame,
} from "@/server/channels/nodes/protocol";

describe("channel node runtime bridge", () => {
  it("maps a node frame into the common ingress contract with all tools disabled", () => {
    const receivedAt = new Date(
      "2026-07-26T00:00:01.000Z",
    );
    const event = normalizeNodeInbound({
      id: "20000000-0000-4000-8000-000000000001",
      scope: {
        userId: "10000000-0000-4000-8000-000000000001",
        agentId: "10000000-0000-4000-8000-000000000002",
      },
      channelType: "imessage",
      enabled: true,
      revision: 1,
      runtimeNodeId:
        "30000000-0000-4000-8000-000000000001",
      config: {},
    }, inbound(), receivedAt);

    expect(event).toMatchObject({
      channelType: "imessage",
      externalEventId: "imessage:rowid:42",
      chatType: "direct",
      permission: {
        webSearch: false,
        backgroundNetwork: false,
        tools: false,
        skills: "none",
        attachmentsPresent: false,
      },
      receivedAt,
    });
  });
});

function inbound(): NodeInboundFrame {
  return parseNodeFrame({
    type: "inbound",
    protocolVersion: 1,
    nodeId: "30000000-0000-4000-8000-000000000001",
    sequence: 2,
    sentAt: "2026-07-26T00:00:00.000Z",
    connectionId:
      "20000000-0000-4000-8000-000000000001",
    payload: {
      externalEventId: "imessage:rowid:42",
      externalConversationId: "chat:7",
      externalSenderId: "+8613800000000",
      chatType: "direct",
      mentioned: false,
      text: "hello",
      thread: {},
      attachments: [],
      occurredAt: "2026-07-26T00:00:00.000Z",
      rawSummary: { rowid: 42 },
    },
  }) as NodeInboundFrame;
}
