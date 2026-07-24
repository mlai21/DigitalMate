import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentTickUnderLease } from "@/agent-service/index";

const mocks = vi.hoisted(() => ({
  processDueProactiveTasks: vi.fn(),
  assertAuthorizedModelRoutes: vi.fn(),
  getLlmClient: vi.fn(),
}));

vi.mock("@/server/agent/proactive-delivery", () => ({
  processDueProactiveTasks: mocks.processDueProactiveTasks,
}));

vi.mock("@/server/agents/service", () => ({
  assertAuthorizedModelRoutes: mocks.assertAuthorizedModelRoutes,
}));

vi.mock("@/server/llm/router", () => ({
  getLlmClient: mocks.getLlmClient,
}));

describe("agent service bounded tick", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.processDueProactiveTasks.mockResolvedValue(undefined);
    mocks.assertAuthorizedModelRoutes.mockResolvedValue(undefined);
    mocks.getLlmClient.mockReturnValue({
      client: {
        async *stream() {
          yield { type: "text", text: "" };
        },
        completeText: vi.fn(async () => (
          '[{"kind":"profile","content":"用户喜欢爬山","confidence":0.8}]'
        )),
      },
      model: "mock-light",
    });
  });

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

  it("passes the bounded signal into memory embedding writes and stops later writes on abort", async () => {
    const sourceAbort = new AbortController();
    const release = vi.fn(async () => undefined);
    let createManySignal: AbortSignal | undefined;
    const markMemoryProcessed = vi.fn();
    const listActiveByKind = vi.fn();
    const repositories = {
      userDataMutations: {
        beginRequest: vi.fn(async (userId: string) => ({ userId, epoch: "1" })),
        acquireSharedLease: vi.fn(async (fence: { userId: string; epoch: string }) => ({
          ...fence,
          mode: "shared" as const,
          release,
        })),
      },
      messages: {
        unprocessedForMemory: vi.fn(async () => [{ id: "message-1", content: "用户喜欢爬山" }]),
        markMemoryProcessed,
      },
      settings: {
        get: vi.fn(async () => ({ modelRouting: { main: "mock-main", light: "mock-light" } })),
      },
      memories: {
        createMany: vi.fn(async (
          _scope: unknown,
          _sourceMessageId: string,
          _memories: unknown[],
          signal?: AbortSignal,
        ) => {
          createManySignal = signal;
          sourceAbort.abort(new Error("memory_embedding_timeout"));
          signal?.throwIfAborted();
        }),
        listActiveByKind,
      },
      agents: {},
    };

    await expect(runAgentTickUnderLease(
      repositories as never,
      { userId: "user-1", agentId: "agent-1" },
      { signal: sourceAbort.signal, timeoutMs: 1_000 },
    )).rejects.toThrow("memory_embedding_timeout");

    expect(createManySignal?.aborted).toBe(true);
    expect(markMemoryProcessed).not.toHaveBeenCalled();
    expect(listActiveByKind).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
