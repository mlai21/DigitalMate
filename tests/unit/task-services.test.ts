import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as postCsvTask } from "@/app/api/tasks/csv/route";
import { buildCsvSummaryReport } from "@/server/tasks/csv";
import { parsePresentationOutline } from "@/server/tasks/presentation";

const routeMocks = vi.hoisted(() => ({
  requireCurrentUser: vi.fn(async () => ({ id: "user-1" })),
  taskArtifactsCreate: vi.fn<(...args: unknown[]) => Promise<string>>(async () => "artifact-id"),
  releaseLease: vi.fn(async () => undefined),
  taskRunsComplete: vi.fn(async () => undefined),
  taskRunsFail: vi.fn(async () => undefined),
  taskRunsCreate: vi.fn(async () => "task-1"),
  skillsCreate: vi.fn(async () => undefined),
  discardPublishedTaskArtifacts: vi.fn(async () => undefined),
}));

vi.mock("@/server/auth/current-user", () => ({
  requireCurrentUser: routeMocks.requireCurrentUser,
}));

vi.mock("@/server/db/repositories", () => ({
  createRepositories: vi.fn(() => ({
    userDataMutations: {
      beginRequest: vi.fn(async (userId: string) => ({ userId, epoch: "1" })),
      acquireSharedLease: vi.fn(async (fence: { userId: string; epoch: string }) => ({
        ...fence,
        mode: "shared",
        release: routeMocks.releaseLease,
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
    file: { fileName: string; mimeType: string };
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
    return { artifactId, ...stored };
  }),
  discardPublishedTaskArtifacts: routeMocks.discardPublishedTaskArtifacts,
}));

describe("buildCsvSummaryReport", () => {
  it("creates a markdown report with row count and totals", () => {
    const report = buildCsvSummaryReport("region,amount\nEast,10\nWest,20\n");

    expect(report.fileName).toBe("csv-summary.md");
    expect(report.mimeType).toBe("text/markdown; charset=utf-8");
    expect(report.buffer.toString("utf8")).toContain("行数：2");
    expect(report.buffer.toString("utf8")).toContain("amount：30");
  });
});

describe("csv task route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores both the spreadsheet report and generated chart artifacts", async () => {
    const form = new FormData();
    form.set("file", new File(["region,amount\nEast,10\nWest,20\n"], "sales.csv", { type: "text/csv" }));

    const response = await postCsvTask({
      formData: async () => form,
      url: "http://localhost/api/tasks/csv",
    } as Request);

    expect(response.status).toBe(303);
    expect(routeMocks.taskArtifactsCreate).toHaveBeenCalledTimes(2);
    expect(routeMocks.taskArtifactsCreate).toHaveBeenCalledWith(
      { userId: "user-1", agentId: "agent-1" },
      expect.objectContaining({
        fileName: "csv-summary.md",
        mimeType: "text/markdown; charset=utf-8",
      }),
    );
    expect(routeMocks.taskArtifactsCreate).toHaveBeenCalledWith(
      { userId: "user-1", agentId: "agent-1" },
      expect.objectContaining({
        fileName: "csv-summary-chart.svg",
        mimeType: "image/svg+xml; charset=utf-8",
      }),
    );
  });

  it("preserves all published files and returns a stable error when completion is ambiguous", async () => {
    routeMocks.taskRunsComplete.mockRejectedValueOnce(Object.assign(
      new Error("connection_lost_after_commit"),
      { code: "task_completion_ambiguous" },
    ));
    const form = new FormData();
    form.set("file", new File(["region,amount\nEast,10\nWest,20\n"], "sales.csv", { type: "text/csv" }));

    const response = await postCsvTask({
      formData: async () => form,
      url: "http://localhost/api/tasks/csv",
    } as Request);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "task_completion_ambiguous",
    });
    expect(routeMocks.taskArtifactsCreate).toHaveBeenCalledTimes(2);
    expect(routeMocks.discardPublishedTaskArtifacts).not.toHaveBeenCalled();
    expect(routeMocks.taskRunsFail).not.toHaveBeenCalled();
    expect(routeMocks.releaseLease).toHaveBeenCalledTimes(1);
  });
});

describe("parsePresentationOutline", () => {
  it("parses slide titles and bullet lines", () => {
    expect(parsePresentationOutline("本周进展\n- 完成聊天\n- 接入记忆\n\n下周计划\n- IM 联调")).toEqual([
      { title: "本周进展", bullets: ["完成聊天", "接入记忆"] },
      { title: "下周计划", bullets: ["IM 联调"] },
    ]);
  });
});
