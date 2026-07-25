import { describe, expect, it, vi } from "vitest";

import type {
  ClaimedChannelDelivery,
} from "@/server/channels/runtime/delivery-repository";
import {
  ChannelSendError,
  createChannelDeliveryWorker,
  segmentDeliveryBody,
  type ChannelDeliveryTransport,
  type DeliverySegmentStart,
} from "@/server/channels/runtime/delivery-worker";
import { nextRetryAt } from "@/server/channels/runtime/retry";
import type { SendResult } from "@/server/channels/runtime/types";

describe("channel delivery retry", () => {
  it("uses Retry-After before exponential backoff with bounded jitter", () => {
    const now = new Date("2026-07-26T00:00:00.000Z");

    expect(nextRetryAt({
      attempt: 1,
      now,
      retryAfterMs: 5_000,
      random: 0.5,
    })).toEqual(new Date("2026-07-26T00:00:05.000Z"));
    expect(nextRetryAt({
      attempt: 3,
      now,
      random: 0,
    })).toEqual(new Date("2026-07-26T00:00:03.200Z"));
    expect(nextRetryAt({
      attempt: 99,
      now,
      random: 1,
    })).toEqual(new Date("2026-07-26T00:06:00.000Z"));
  });

  it("retries rate limit and network failures without running the Agent again", async () => {
    const harness = deliveryHarness();
    const runAgent = vi.fn();
    runAgent();
    harness.transport.send
      .mockRejectedValueOnce(new ChannelSendError({
        code: "rate_limited",
        retryable: true,
        retryAfterMs: 2_000,
      }))
      .mockRejectedValueOnce(new Error("socket closed"))
      .mockResolvedValueOnce(sendResult("platform-1"));

    await harness.worker.runOne();
    harness.advanceToRetry();
    await harness.worker.runOne();
    harness.advanceToRetry();
    await harness.worker.runOne();

    expect(harness.transport.send).toHaveBeenCalledTimes(3);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(harness.state.status).toBe("sent");
    expect(harness.state.attempts).toBe(3);
  });

  it("dead-letters a non-retryable credential error immediately", async () => {
    const harness = deliveryHarness();
    harness.transport.send.mockRejectedValueOnce(
      new ChannelSendError({
        code: "credential_invalid",
        retryable: false,
      }),
    );

    await harness.worker.runOne();

    expect(harness.state.status).toBe("dead_letter");
    expect(harness.state.lastErrorCode).toBe("credential_invalid");
    expect(harness.transport.send).toHaveBeenCalledTimes(1);
  });

  it("dead-letters after eight retryable attempts", async () => {
    const harness = deliveryHarness();
    harness.transport.send.mockRejectedValue(
      new Error("network"),
    );

    for (let attempt = 1; attempt <= 8; attempt += 1) {
      await harness.worker.runOne();
      if (attempt < 8) harness.advanceToRetry();
    }

    expect(harness.transport.send).toHaveBeenCalledTimes(8);
    expect(harness.state.status).toBe("dead_letter");
    expect(harness.state.attempts).toBe(8);
    expect(harness.state.lastErrorCode).toBe(
      "network_unreachable",
    );
  });

  it("preserves the entire reply when maxSegments merges overflow", () => {
    expect(segmentDeliveryBody("第一句。第二句。第三句。", {
      maxSegments: 2,
    })).toEqual([
      "第一句。",
      "第二句。\n\n第三句。",
    ]);
  });

  it("updates one streaming message with deterministic cumulative bodies", async () => {
    const harness = deliveryHarness({
      body: "第一段。\n\n第二段。",
      mode: "streaming",
    });
    harness.transport.send
      .mockResolvedValueOnce(sendResult("platform-stream"))
      .mockResolvedValueOnce(sendResult("platform-stream"));

    await harness.worker.runOne();

    expect(harness.transport.send).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        body: "第一段。",
        state: { sequence: 1, final: false },
        previousResult: null,
      }),
      expect.any(AbortSignal),
    );
    expect(harness.transport.send).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        body: "第一段。\n\n第二段。",
        state: { sequence: 2, final: true },
        previousResult: expect.objectContaining({
          externalMessageId: "platform-stream",
        }),
      }),
      expect.any(AbortSignal),
    );
    expect(harness.state.status).toBe("sent");
  });

  it("continues after a partial segmented send without duplicating sent segments", async () => {
    const harness = deliveryHarness({
      body: "第一段。\n\n第二段。",
      mode: "segmented",
    });
    harness.transport.send
      .mockResolvedValueOnce(sendResult("platform-1"))
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(sendResult("platform-2"));

    await harness.worker.runOne();
    harness.advanceToRetry();
    await harness.worker.runOne();

    expect(harness.transport.send.mock.calls.map(
      ([part]) => part.body,
    )).toEqual([
      "第一段。",
      "第二段。",
      "第二段。",
    ]);
    expect(harness.state.status).toBe("sent");
  });

  it("does not resend a segment whose prior platform outcome is ambiguous", async () => {
    const harness = deliveryHarness({
      beginOverride: async () => ({
        action: "ambiguous" as const,
        previousResult: null,
      }),
    });

    await harness.worker.runOne();

    expect(harness.transport.send).not.toHaveBeenCalled();
    expect(harness.state.status).toBe("dead_letter");
    expect(harness.state.lastErrorCode).toBe(
      "delivery_outcome_unknown",
    );
  });

  it("does not start a platform send after shutdown aborts a cadence delay", async () => {
    const controller = new AbortController();
    const harness = deliveryHarness({
      cadence: {
        responseDelayMs: 480,
        segmentDelayMs: 240,
        maxSegments: 5,
      },
      delay: async (_milliseconds, signal) => {
        controller.abort(new Error("shutdown"));
        signal?.throwIfAborted();
      },
    });

    await expect(harness.worker.runOne({
      signal: controller.signal,
    })).rejects.toThrow("shutdown");

    expect(harness.transport.send).not.toHaveBeenCalled();
    expect(harness.state.status).toBe("running");
  });
});

type FakeStatus =
  | "queued"
  | "running"
  | "retry"
  | "sent"
  | "dead_letter";

function deliveryHarness(options: {
  body?: string;
  mode?: "segmented" | "streaming";
  cadence?: {
    responseDelayMs: number;
    segmentDelayMs: number;
    maxSegments: number;
  };
  delay?: (
    milliseconds: number,
    signal?: AbortSignal,
  ) => Promise<void>;
  beginOverride?: (
    claim: ClaimedChannelDelivery,
    segmentNo: number,
  ) => Promise<DeliverySegmentStart>;
} = {}) {
  let currentTime = new Date("2026-07-26T00:00:00.000Z");
  const state = {
    status: "queued" as FakeStatus,
    attempts: 0,
    nextAttemptAt: currentTime,
    lastErrorCode: null as string | null,
  };
  const sentSegments = new Map<number, SendResult>();
  const claim = (): ClaimedChannelDelivery => ({
    id: "delivery-1",
    scope: {
      userId: "10000000-0000-4000-8000-000000000001",
      agentId: "10000000-0000-4000-8000-000000000011",
    },
    eventId: "20000000-0000-4000-8000-000000000001",
    connectionId: "30000000-0000-4000-8000-000000000001",
    assistantMessageId:
      "40000000-0000-4000-8000-000000000001",
    replyHandleId: null,
    body: options.body ?? "已经持久化的回复",
    recipient: {
      externalConversationId: "conversation-1",
    },
    status: "running",
    claimOwner: "delivery-worker-1",
    claimExpiresAt: new Date(
      currentTime.getTime() + 30_000,
    ),
    attempts: state.attempts,
    attemptCycleBaseline: 0,
    nextAttemptAt: state.nextAttemptAt,
    lastErrorCode: state.lastErrorCode,
    sentAt: null,
  });
  const deliveries = {
    leaseDurationMs: 30_000,
    claimNext: vi.fn(async () => {
      if (
        !["queued", "retry"].includes(state.status)
        || state.nextAttemptAt > currentTime
      ) {
        return null;
      }
      state.status = "running";
      state.attempts += 1;
      return claim();
    }),
    renew: vi.fn(async () =>
      new Date(currentTime.getTime() + 30_000)
    ),
    beginSegment: vi.fn(async (
      claimed: ClaimedChannelDelivery,
      segmentNo: number,
    ): Promise<DeliverySegmentStart> => {
      if (options.beginOverride) {
        return options.beginOverride(claimed, segmentNo);
      }
      const previous = sentSegments.get(segmentNo);
      return previous
        ? { action: "already_sent", previousResult: previous }
        : { action: "send", previousResult: null };
    }),
    completeSegment: vi.fn(async (
      _claim: ClaimedChannelDelivery,
      segmentNo: number,
      result: {
        status: "sent" | "retryable" | "failed";
        platformResult?: SendResult;
      },
    ) => {
      if (result.status === "sent" && result.platformResult) {
        sentSegments.set(segmentNo, result.platformResult);
      }
      return true;
    }),
    markSent: vi.fn(async () => {
      state.status = "sent";
      return true;
    }),
    scheduleRetry: vi.fn(async (
      _claim: ClaimedChannelDelivery,
      nextAttemptAt: Date,
      errorCode: string,
    ) => {
      state.status = "retry";
      state.nextAttemptAt = nextAttemptAt;
      state.lastErrorCode = errorCode;
      return true;
    }),
    deadLetter: vi.fn(async (
      _claim: ClaimedChannelDelivery,
      errorCode: string,
    ) => {
      state.status = "dead_letter";
      state.lastErrorCode = errorCode;
      return true;
    }),
  };
  const transport = {
    mode: vi.fn(async () => options.mode ?? "segmented"),
    send: vi.fn(),
  } satisfies ChannelDeliveryTransport;
  const worker = createChannelDeliveryWorker({
    owner: "delivery-worker-1",
    deliveries,
    transport,
    loadCadence: vi.fn(async () => options.cadence ?? ({
      responseDelayMs: 0,
      segmentDelayMs: 0,
      maxSegments: 5,
    })),
    now: () => currentTime,
    random: () => 0.5,
    delay: options.delay ?? vi.fn(async () => undefined),
  });

  return {
    worker,
    transport,
    state,
    advanceToRetry() {
      currentTime = state.nextAttemptAt;
    },
  };
}

function sendResult(externalMessageId: string): SendResult {
  return {
    externalMessageId,
    sentAt: new Date("2026-07-26T00:00:00.000Z"),
    rawSummary: {},
  };
}
