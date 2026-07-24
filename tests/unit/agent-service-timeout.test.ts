import { describe, expect, it, vi } from "vitest";
import { runAgentTickUnderLease } from "@/agent-service/index";

const mocks = vi.hoisted(() => ({
  processDueProactiveTasks: vi.fn(),
}));

vi.mock("@/server/agent/proactive-delivery", () => ({
  processDueProactiveTasks: mocks.processDueProactiveTasks,
}));

describe("agent service bounded tick", () => {
  it("aborts a half-open tick stage and releases its shared lease only after the stage exits", async () => {
    vi.useFakeTimers();
    const release = vi.fn(async () => undefined);
    let tickSignal: AbortSignal | undefined;
    const order: string[] = [];
    release.mockImplementationOnce(async () => {
      order.push("lease-released");
    });
    mocks.processDueProactiveTasks.mockImplementationOnce(async (input: { signal?: AbortSignal }) => {
      tickSignal = input.signal;
      await new Promise<void>((resolve) => {
        input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      try {
        input.signal?.throwIfAborted();
      } finally {
        order.push("tick-exited");
      }
    });
    const repositories = {
      userDataMutations: {
        beginRequest: vi.fn(async (userId: string) => ({ userId, epoch: "1" })),
        acquireSharedLease: vi.fn(async (fence: { userId: string; epoch: string }) => ({
          ...fence,
          mode: "shared" as const,
          release,
        })),
      },
    };

    try {
      const operation = runAgentTickUnderLease(
        repositories as never,
        { userId: "user-1", agentId: "agent-1" },
        { timeoutMs: 25 },
      );
      const settled = operation.then(
        () => null,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.processDueProactiveTasks).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(25);
      expect(tickSignal?.aborted).toBe(true);
      const error = await settled;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("agent_tick_timeout");
      expect(release).toHaveBeenCalledTimes(1);
      expect(order).toEqual(["tick-exited", "lease-released"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
