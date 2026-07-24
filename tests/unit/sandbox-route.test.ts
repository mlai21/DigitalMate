import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/tasks/sandbox/route";
import { USER_DATA_WORK_TIMEOUT_MS } from "@/server/admin/user-data-lease";

const mocks = vi.hoisted(() => ({
  releaseLease: vi.fn(async () => undefined),
  publishTaskArtifact: vi.fn(),
  discardPublishedTaskArtifacts: vi.fn(async () => undefined),
  taskRunComplete: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
  taskRunFail: vi.fn(async () => undefined),
  runSandboxTask: vi.fn(async () => ({ stdout: "ok\n", stderr: "" })),
}));

vi.mock("@/server/auth/current-user", () => ({
  requireCurrentUser: vi.fn(async () => ({ id: "user-1" })),
}));

vi.mock("@/server/db/repositories", () => ({
  createRepositories: vi.fn(() => ({
    userDataMutations: {
      beginRequest: vi.fn(async (userId: string) => ({ userId, epoch: "1" })),
      acquireSharedLease: vi.fn(async (fence: { userId: string; epoch: string }) => ({
        ...fence,
        mode: "shared",
        release: mocks.releaseLease,
      })),
    },
    agents: {
      getDefault: vi.fn(async () => ({ id: "agent-1", userId: "user-1", status: "active" })),
    },
    taskRuns: {
      create: vi.fn(async () => "task-1"),
      completeWithArtifacts: mocks.taskRunComplete,
      fail: mocks.taskRunFail,
    },
    taskArtifacts: {},
    skills: {
      create: vi.fn(async () => undefined),
    },
  })),
}));

vi.mock("@/server/tasks/artifacts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/tasks/artifacts")>();
  return {
    ...actual,
    defaultArtifactRoot: vi.fn(() => "/private/artifacts"),
  };
});

vi.mock("@/server/tasks/artifact-publisher", () => ({
  publishTaskArtifact: mocks.publishTaskArtifact,
  discardPublishedTaskArtifacts: mocks.discardPublishedTaskArtifacts,
}));

vi.mock("@/server/tasks/sandbox", () => ({
  runSandboxTask: mocks.runSandboxTask,
}));

vi.mock("@/server/evolution/event-reflection", () => ({
  recordEventReflection: vi.fn(async () => undefined),
}));

describe("sandbox task route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.publishTaskArtifact.mockResolvedValue({
      artifactId: "artifact-1",
      fileName: "sandbox-output.txt",
      mimeType: "text/plain; charset=utf-8",
      storagePath: "user-1/task-1/sandbox-output.txt",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes the sandbox output before completing and releases the shared lease", async () => {
    const form = new FormData();
    form.set("script", "node -e \"console.log('ok')\"");

    const response = await POST({
      formData: async () => form,
      url: "http://localhost/api/tasks/sandbox",
    } as Request);

    expect(response.status).toBe(303);
    expect(mocks.taskRunComplete.mock.calls[0]?.[4]).toMatchObject({
      aborted: false,
    });
    expect(mocks.publishTaskArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { userId: "user-1", agentId: "agent-1" },
        root: "/private/artifacts",
        taskRunId: "task-1",
        file: expect.objectContaining({
          fileName: "sandbox-output.txt",
          buffer: Buffer.from("stdout:\nok\n\n\nstderr:\n(empty)"),
        }),
      }),
    );
    expect(mocks.taskRunComplete).toHaveBeenCalledTimes(1);
    expect(mocks.releaseLease).toHaveBeenCalledTimes(1);
  });

  it("fails the task when publication fails without leaving a published locator", async () => {
    mocks.publishTaskArtifact.mockRejectedValueOnce(new Error("rename_failed"));
    const form = new FormData();
    form.set("script", "node -e \"console.log('ok')\"");

    const response = await POST({
      formData: async () => form,
      url: "http://localhost/api/tasks/sandbox",
    } as Request);

    expect(response.status).toBe(303);
    expect(mocks.discardPublishedTaskArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ artifacts: [] }),
    );
    expect(mocks.taskRunFail).toHaveBeenCalledWith(
      { userId: "user-1", agentId: "agent-1" },
      "task-1",
      "rename_failed",
    );
    expect(mocks.releaseLease).toHaveBeenCalledTimes(1);
  });

  it("preserves published output and returns a stable error when completion is ambiguous", async () => {
    mocks.taskRunComplete.mockRejectedValueOnce(Object.assign(
      new Error("connection_lost_after_commit"),
      { code: "task_completion_ambiguous" },
    ));
    const form = new FormData();
    form.set("script", "node -e \"console.log('ok')\"");

    const response = await POST({
      formData: async () => form,
      url: "http://localhost/api/tasks/sandbox",
    } as Request);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "task_completion_ambiguous",
    });
    expect(mocks.discardPublishedTaskArtifacts).not.toHaveBeenCalled();
    expect(mocks.taskRunFail).not.toHaveBeenCalled();
    expect(mocks.releaseLease).toHaveBeenCalledTimes(1);
  });

  it("cancels a half-open completion, compensates confirmed pre-COMMIT work, and releases the lease", async () => {
    vi.useFakeTimers();
    let completionSignal: AbortSignal | undefined;
    let markCompletionReached: (() => void) | undefined;
    const completionReached = new Promise<void>((resolve) => {
      markCompletionReached = resolve;
    });
    mocks.taskRunComplete.mockImplementationOnce((...args: unknown[]) => {
      completionSignal = args[4] as AbortSignal | undefined;
      markCompletionReached?.();
      return new Promise<void>((_resolve, reject) => {
        const rejectFromAbort = () => reject(completionSignal?.reason);
        if (completionSignal?.aborted) {
          rejectFromAbort();
        } else {
          completionSignal?.addEventListener("abort", rejectFromAbort, { once: true });
        }
      });
    });
    const form = new FormData();
    form.set("script", "node -e \"console.log('ok')\"");

    const operation = POST({
      formData: async () => form,
      url: "http://localhost/api/tasks/sandbox",
    } as Request);
    await completionReached;
    await vi.advanceTimersByTimeAsync(USER_DATA_WORK_TIMEOUT_MS);

    await expect(operation).rejects.toThrow("user_data_work_timeout");
    expect(completionSignal?.aborted).toBe(true);
    expect(mocks.discardPublishedTaskArtifacts).toHaveBeenCalledTimes(1);
    expect(mocks.taskRunFail).toHaveBeenCalledTimes(1);
    expect(mocks.releaseLease).toHaveBeenCalledTimes(1);
  });
});
