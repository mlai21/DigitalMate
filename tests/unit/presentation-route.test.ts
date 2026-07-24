import { beforeEach, describe, expect, it, vi } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { POST as postPresentationTask } from "@/app/api/tasks/presentation/route";

const routeMocks = vi.hoisted(() => ({
  callOrder: [] as string[],
  requireCurrentUser: vi.fn(async () => ({ id: "user-1" })),
  acquireLock: vi.fn(async (userId: string) => {
    routeMocks.callOrder.push("lock");
    return { userId, epoch: "1" };
  }),
  releaseLock: vi.fn(async () => {
    routeMocks.callOrder.push("unlock");
  }),
  taskArtifactsCreate: vi.fn<(...args: unknown[]) => Promise<string>>(async () => {
    routeMocks.callOrder.push("locator");
    return "artifact-id";
  }),
  taskRunsComplete: vi.fn(async () => {
    routeMocks.callOrder.push("complete");
  }),
  taskRunsFail: vi.fn(async () => {
    routeMocks.callOrder.push("fail");
  }),
  taskRunsCreate: vi.fn(async () => {
    routeMocks.callOrder.push("task");
    return "task-1";
  }),
  skillsCreate: vi.fn(async () => undefined),
  storedBuffers: [] as Buffer[],
  discardPublishedArtifacts: vi.fn(async () => {
    routeMocks.callOrder.push("discard");
  }),
}));

vi.mock("@/server/auth/current-user", () => ({
  requireCurrentUser: routeMocks.requireCurrentUser,
}));

vi.mock("@/server/db/repositories", () => ({
  createRepositories: vi.fn(() => ({
    userDataMutations: {
      beginRequest: routeMocks.acquireLock,
      acquireSharedLease: vi.fn(async (fence: { userId: string; epoch: string }) => ({
        ...fence,
        mode: "shared",
        release: routeMocks.releaseLock,
      })),
    },
    agents: {
      getDefault: vi.fn(async () => ({ id: "agent-1", userId: "user-1", status: "active" })),
    },
    taskRuns: {
      create: routeMocks.taskRunsCreate,
      completeWithArtifacts: routeMocks.taskRunsComplete,
      fail: routeMocks.taskRunsFail,
    },
    taskArtifacts: {
      create: routeMocks.taskArtifactsCreate,
    },
    skills: {
      create: routeMocks.skillsCreate,
    },
  })),
}));

vi.mock("@/server/tasks/artifacts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/tasks/artifacts")>();
  return {
    ...actual,
    defaultArtifactRoot: vi.fn(() => "/tmp/digitalmate-test-artifacts"),
  };
});

vi.mock("@/server/tasks/artifact-publisher", () => ({
  publishTaskArtifact: vi.fn(async (input: {
    scope: { userId: string; agentId: string };
    repositories: { taskArtifacts: { create: typeof routeMocks.taskArtifactsCreate } };
    taskRunId: string;
    file: { fileName: string; mimeType: string; buffer: Buffer };
  }) => {
    const stored = {
      fileName: input.file.fileName,
      mimeType: input.file.mimeType,
      storagePath: `user-1/task-1/${input.file.fileName}`,
    };
    const artifactId = await input.repositories.taskArtifacts.create(input.scope, {
      taskRunId: input.taskRunId,
      ...stored,
    });
    routeMocks.callOrder.push("file");
    routeMocks.storedBuffers.push(input.file.buffer);
    return { artifactId, ...stored };
  }),
  discardPublishedTaskArtifacts: routeMocks.discardPublishedArtifacts,
}));

describe("presentation task route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeMocks.storedBuffers.length = 0;
    routeMocks.callOrder.length = 0;
  });

  it("includes uploaded spreadsheet data in the generated pptx artifact", async () => {
    const form = new FormData();
    form.set("title", "销售汇报");
    form.set("outline", "结论\n- 华东表现最好");
    form.set("file", new File(["region,amount\n华东,120\n华南,80\n"], "sales.csv", { type: "text/csv" }));

    const response = await postPresentationTask({
      formData: async () => form,
      url: "http://localhost/api/tasks/presentation",
    } as Request);

    expect(response.status).toBe(303);
    expect(routeMocks.storedBuffers).toHaveLength(1);
    expect(pptxText(routeMocks.storedBuffers[0])).toContain("数据概览");
    expect(routeMocks.callOrder).toEqual([
      "lock",
      "task",
      "locator",
      "file",
      "complete",
      "unlock",
    ]);
  });

  it("discards ready artifacts and fails the task when completion fails", async () => {
    routeMocks.taskRunsComplete.mockImplementationOnce(async () => {
      routeMocks.callOrder.push("complete");
      throw new Error("complete_failed");
    });
    const form = new FormData();
    form.set("title", "失败补偿");
    form.set("outline", "结论\n- 需要补偿");

    const response = await postPresentationTask({
      formData: async () => form,
      url: "http://localhost/api/tasks/presentation",
    } as Request);

    expect(response.status).toBe(303);
    expect(routeMocks.discardPublishedArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        artifacts: [expect.objectContaining({ artifactId: "artifact-id" })],
      }),
    );
    expect(routeMocks.taskRunsFail).toHaveBeenCalledWith(
      { userId: "user-1", agentId: "agent-1" },
      "task-1",
      "complete_failed",
    );
    expect(routeMocks.callOrder).toEqual([
      "lock",
      "task",
      "locator",
      "file",
      "complete",
      "discard",
      "fail",
      "unlock",
    ]);
  });

  it("preserves published artifacts and returns a stable error when completion is ambiguous", async () => {
    routeMocks.taskRunsComplete.mockImplementationOnce(async () => {
      routeMocks.callOrder.push("complete");
      throw Object.assign(new Error("connection_lost_after_commit"), {
        code: "task_completion_ambiguous",
      });
    });
    const form = new FormData();
    form.set("title", "歧义提交");
    form.set("outline", "结论\n- 等待核验");

    const response = await postPresentationTask({
      formData: async () => form,
      url: "http://localhost/api/tasks/presentation",
    } as Request);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "task_completion_ambiguous",
    });
    expect(routeMocks.discardPublishedArtifacts).not.toHaveBeenCalled();
    expect(routeMocks.taskRunsFail).not.toHaveBeenCalled();
    expect(routeMocks.callOrder).toEqual([
      "lock",
      "task",
      "locator",
      "file",
      "complete",
      "unlock",
    ]);
  });
});

function pptxText(buffer: Buffer): string {
  const files = unzipSync(new Uint8Array(buffer));
  return Object.entries(files)
    .filter(([path]) => path.startsWith("ppt/slides/") && path.endsWith(".xml"))
    .map(([, content]) => strFromU8(content))
    .join("\n");
}
