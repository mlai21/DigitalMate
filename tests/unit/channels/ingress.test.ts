import { describe, expect, it, vi } from "vitest";

import type { AgentScope } from "@/server/agents/types";
import {
  evaluateChannelAccess,
  type ChannelAccessSnapshot,
} from "@/server/channels/runtime/access";
import { acceptInbound } from "@/server/channels/runtime/ingress";
import type { ChannelAdapter } from "@/server/channels/runtime/adapter";
import type {
  IngressResult,
  NormalizedChannelEvent,
} from "@/server/channels/runtime/types";

const scope = {
  userId: "10000000-0000-4000-8000-000000000001",
  agentId: "10000000-0000-4000-8000-000000000011",
} satisfies AgentScope;

describe("channel ingress", () => {
  it("persists a normalized event before acknowledging it", async () => {
    const order: string[] = [];
    const event = normalizedEvent();
    const adapter = fakeAdapter({
      acknowledge: async () => {
        order.push("ack");
        return { status: 200 };
      },
    });
    const events = {
      accept: vi.fn(async () => {
        order.push("persist");
        return { created: true, event: persistedEvent("accepted") };
      }),
    };

    const result = await acceptInbound({
      adapter,
      payload: { updateId: 1 },
      context: inboundContext(),
      scope,
      access: fakeAccess({ kind: "allowed", allowed: true }),
      events,
    });

    expect(result).toEqual({ kind: "accepted", eventId: "event-id" });
    expect(order).toEqual(["persist", "ack"]);
    expect(events.accept).toHaveBeenCalledWith(scope, event, {
      initialStatus: "accepted",
      failureCode: null,
    });
  });

  it("does not acknowledge success when persistence fails", async () => {
    const acknowledge = vi.fn();

    await expect(
      acceptInbound({
        adapter: fakeAdapter({ acknowledge }),
        payload: {},
        context: inboundContext(),
        scope,
        access: fakeAccess({ kind: "allowed", allowed: true }),
        events: {
          accept: vi.fn(async () => {
            throw new Error("database_unavailable");
          }),
        },
      }),
    ).rejects.toThrow("database_unavailable");

    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("keeps attachment events unclaimable until private files are bound", async () => {
    const order: string[] = [];
    const attachmentEvent = normalizedEvent({
      attachments: [{
        externalAttachmentId: "telegram-file-1",
        fileName: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        source: { fileId: "platform-file-1" },
      }],
      permission: {
        webSearch: false,
        backgroundNetwork: false,
        tools: false,
        skills: "none",
        attachmentsPresent: true,
      },
    });
    const markAttachmentsReady = vi.fn(async () => {
      order.push("ready");
      return true;
    });
    const events = {
      accept: vi.fn(async () => {
        order.push("persist-pending");
        return {
          created: true,
          event: persistedEvent("pending_attachments"),
        };
      }),
      markAttachmentsReady,
    };

    const result = await acceptInbound({
      adapter: fakeAdapter({
        normalizeInbound: vi.fn(async () => attachmentEvent),
        acknowledge: vi.fn(async () => {
          order.push("ack");
          return { status: 200 };
        }),
      }),
      payload: {},
      context: inboundContext(),
      scope,
      access: fakeAccess({ kind: "allowed", allowed: true }),
      events,
      afterPersist: vi.fn(async () => {
        order.push("bind-private-files");
      }),
    });

    expect(result).toEqual({
      kind: "accepted",
      eventId: "event-id",
    });
    expect(events.accept).toHaveBeenCalledWith(
      scope,
      attachmentEvent,
      {
        initialStatus: "pending_attachments",
        failureCode: null,
      },
    );
    expect(markAttachmentsReady).toHaveBeenCalledWith(
      scope,
      "event-id",
    );
    expect(order).toEqual([
      "persist-pending",
      "bind-private-files",
      "ready",
      "ack",
    ]);
  });

  it("acknowledges a duplicate without creating a second access request", async () => {
    const acknowledge = vi.fn(async (
      _payload: unknown,
      result: IngressResult,
    ) => ({ status: result.kind === "duplicate" ? 200 : 500 }));
    const recordPendingRequest = vi.fn();

    const result = await acceptInbound({
      adapter: fakeAdapter({ acknowledge }),
      payload: {},
      context: inboundContext(),
      scope,
      access: fakeAccess(
        { kind: "pending", allowed: false, reason: "approval_required" },
        recordPendingRequest,
      ),
      events: {
        accept: vi.fn(async () => ({
          created: false,
          event: persistedEvent("failed"),
        })),
      },
    });

    expect(result).toEqual({ kind: "duplicate", eventId: "event-id" });
    expect(recordPendingRequest).not.toHaveBeenCalled();
    expect(acknowledge).toHaveBeenCalledOnce();
  });

  it("persists rejected and pending events as terminal failures", async () => {
    const recordPendingRequest = vi.fn(async () => undefined);
    const events = {
      accept: vi.fn(async (
        _scope: AgentScope,
        _event: NormalizedChannelEvent,
        options: {
          initialStatus:
            | "accepted"
            | "pending_attachments"
            | "failed";
          failureCode: string | null;
        },
      ) => ({
        created: true,
        event: persistedEvent(options.initialStatus),
      })),
    };
    const adapter = fakeAdapter();

    const rejected = await acceptInbound({
      adapter,
      payload: {},
      context: inboundContext(),
      scope,
      access: fakeAccess({
        kind: "rejected",
        allowed: false,
        reason: "mention_required",
      }),
      events,
    });
    const pending = await acceptInbound({
      adapter,
      payload: {},
      context: inboundContext(),
      scope,
      access: fakeAccess(
        {
          kind: "pending",
          allowed: false,
          reason: "approval_required",
        },
        recordPendingRequest,
      ),
      events,
    });

    expect(rejected.kind).toBe("rejected");
    expect(pending.kind).toBe("rejected");
    expect(events.accept).toHaveBeenNthCalledWith(
      1,
      scope,
      expect.any(Object),
      {
        initialStatus: "failed",
        failureCode: "mention_required",
      },
    );
    expect(events.accept).toHaveBeenNthCalledWith(
      2,
      scope,
      expect.any(Object),
      {
        initialStatus: "failed",
        failureCode: "approval_required",
      },
    );
    expect(recordPendingRequest).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ id: "event-id" }),
    );
  });

  it("records ACK failure after persistence without deleting the event", async () => {
    const onAcknowledgementFailure = vi.fn(async () => undefined);
    const events = {
      accept: vi.fn(async () => ({
        created: true,
        event: persistedEvent("accepted"),
      })),
    };
    const failure = new Error("platform_ack_failed");

    await expect(
      acceptInbound({
        adapter: fakeAdapter({
          acknowledge: vi.fn(async () => {
            throw failure;
          }),
        }),
        payload: {},
        context: inboundContext(),
        scope,
        access: fakeAccess({ kind: "allowed", allowed: true }),
        events,
        onAcknowledgementFailure,
      }),
    ).rejects.toThrow("platform_ack_failed");

    expect(events.accept).toHaveBeenCalledOnce();
    expect(onAcknowledgementFailure).toHaveBeenCalledWith(
      "event-id",
      failure,
    );
  });

  it("acknowledges ignored platform noise without creating an event", async () => {
    const acknowledge = vi.fn(async () => ({ status: 200 }));
    const events = { accept: vi.fn() };

    const result = await acceptInbound({
      adapter: fakeAdapter({
        normalizeInbound: vi.fn(async () => null),
        acknowledge,
      }),
      payload: {},
      context: inboundContext(),
      scope,
      access: fakeAccess({ kind: "allowed", allowed: true }),
      events,
    });

    expect(result).toEqual({ kind: "ignored" });
    expect(events.accept).not.toHaveBeenCalled();
    expect(acknowledge).toHaveBeenCalledWith({}, { kind: "ignored" });
  });
});

describe("channel access decision order", () => {
  const baseSnapshot: ChannelAccessSnapshot = {
    exists: true,
    enabled: true,
    deleted: false,
    directDisabled: false,
    groupDisabled: false,
    directPolicy: "open",
    groupPolicy: "open",
    allowFrom: [],
    requireMention: false,
    directApprovalRequired: false,
    groupApprovalRequired: false,
    rules: [],
  };

  it.each([
    [
      "disabled connection",
      { ...baseSnapshot, enabled: false },
      normalizedEvent(),
      { kind: "rejected", reason: "connection_disabled" },
    ],
    [
      "disabled group",
      { ...baseSnapshot, groupDisabled: true },
      normalizedEvent({ chatType: "group" }),
      { kind: "rejected", reason: "group_disabled" },
    ],
    [
      "bot event",
      baseSnapshot,
      normalizedEvent({ rawSummary: { isBotEvent: true } }),
      { kind: "rejected", reason: "bot_or_self_event" },
    ],
    [
      "deny rule before allow",
      {
        ...baseSnapshot,
        allowFrom: ["sender-1"],
        rules: [{
          targetKind: "sender" as const,
          targetId: "sender-1",
          effect: "deny" as const,
        }],
      },
      normalizedEvent(),
      { kind: "rejected", reason: "access_denied" },
    ],
    [
      "mention before approval",
      {
        ...baseSnapshot,
        requireMention: true,
        groupApprovalRequired: true,
      },
      normalizedEvent({ chatType: "group", mentioned: false }),
      { kind: "rejected", reason: "mention_required" },
    ],
    [
      "pending approval",
      { ...baseSnapshot, directApprovalRequired: true },
      normalizedEvent(),
      { kind: "pending", reason: "approval_required" },
    ],
  ])("%s", (_label, snapshot, event, expected) => {
    expect(evaluateChannelAccess(event, snapshot)).toMatchObject(expected);
  });

  it("allows an explicitly permitted sender through approval mode", () => {
    expect(evaluateChannelAccess(
      normalizedEvent(),
      {
        ...baseSnapshot,
        directApprovalRequired: true,
        rules: [{
          targetKind: "sender",
          targetId: "sender-1",
          effect: "allow",
        }],
      },
    )).toEqual({ kind: "allowed", allowed: true });
  });
});

function fakeAdapter(
  overrides: Partial<ChannelAdapter<Record<string, unknown>>> = {},
): ChannelAdapter<Record<string, unknown>> {
  return {
    manifest: {} as ChannelAdapter<Record<string, unknown>>["manifest"],
    validateConfig: (config) => config as Record<string, unknown>,
    start: async () => undefined,
    stop: async () => undefined,
    health: async () => ({
      status: "healthy",
      checkedAt: new Date(),
      reconnectAttempts: 0,
    }),
    normalizeInbound: async () => normalizedEvent(),
    acknowledge: async () => ({ status: 200 }),
    send: async () => ({
      externalMessageId: "message-1",
      sentAt: new Date(),
      rawSummary: {},
    }),
    resolveRecipient: async () => ({ address: {} }),
    ...overrides,
  };
}

function fakeAccess(
  decision:
    | { kind: "allowed"; allowed: true }
    | {
        kind: "rejected" | "pending";
        allowed: false;
        reason: string;
      },
  recordPendingRequest = vi.fn(async () => undefined),
) {
  return {
    evaluate: vi.fn(async () => decision),
    recordPendingRequest,
  };
}

function normalizedEvent(
  overrides: Partial<NormalizedChannelEvent> = {},
): NormalizedChannelEvent {
  return {
    connectionId: "20000000-0000-4000-8000-000000000001",
    agentId: scope.agentId,
    channelType: "telegram",
    externalEventId: "external-event-1",
    externalConversationId: "conversation-1",
    externalSenderId: "sender-1",
    chatType: "direct",
    mentioned: false,
    text: "hello",
    thread: {},
    attachments: [],
    occurredAt: new Date("2026-07-26T00:00:00.000Z"),
    receivedAt: new Date("2026-07-26T00:00:01.000Z"),
    permission: {
      webSearch: false,
      backgroundNetwork: false,
      tools: false,
      skills: "none",
      attachmentsPresent: false,
    },
    rawSummary: {},
    ...overrides,
  };
}

function persistedEvent(
  status: "accepted" | "pending_attachments" | "failed",
) {
  return {
    id: "event-id",
    scope,
    connectionId:
      "20000000-0000-4000-8000-000000000001",
    normalizedEvent: normalizedEvent(),
    clientTurnId: "30000000-0000-5000-8000-000000000001",
    payloadHash: "a".repeat(64),
    status,
    claimOwner: null,
    claimExpiresAt: null,
    attempts: 0,
    failureCode: status === "failed" ? "rejected" : null,
    assistantMessageId: null,
    completedAt: status === "failed" ? new Date() : null,
  };
}

function inboundContext() {
  return {
    connectionId:
      "20000000-0000-4000-8000-000000000001",
    agentId: scope.agentId,
    receivedAt: new Date("2026-07-26T00:00:01.000Z"),
  };
}
