import { describe, expect, it, vi } from "vitest";
import { POST as postCsvTask } from "@/app/api/tasks/csv/route";
import { buildCsvSummaryReport } from "@/server/tasks/csv";
import { parsePresentationOutline } from "@/server/tasks/presentation";

const routeMocks = vi.hoisted(() => ({
  requireCurrentUser: vi.fn(async () => ({ id: "user-1" })),
  taskArtifactsCreate: vi.fn(async () => "artifact-id"),
  taskRunsComplete: vi.fn(async () => undefined),
  taskRunsCreate: vi.fn(async () => "task-1"),
  skillsCreate: vi.fn(async () => undefined),
}));

vi.mock("@/server/auth/current-user", () => ({
  requireCurrentUser: routeMocks.requireCurrentUser,
}));

vi.mock("@/server/db/repositories", () => ({
  createRepositories: vi.fn(() => ({
    taskRuns: {
      create: routeMocks.taskRunsCreate,
      complete: routeMocks.taskRunsComplete,
      fail: vi.fn(async () => undefined),
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
    writeArtifactFile: vi.fn(async (input: { fileName: string; mimeType: string }) => ({
      fileName: input.fileName,
      mimeType: input.mimeType,
      storagePath: `user-1/task-1/${input.fileName}`,
    })),
  };
});

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
  it("stores both the spreadsheet report and generated chart artifacts", async () => {
    routeMocks.taskArtifactsCreate.mockClear();
    const form = new FormData();
    form.set("file", new File(["region,amount\nEast,10\nWest,20\n"], "sales.csv", { type: "text/csv" }));

    const response = await postCsvTask({
      formData: async () => form,
      url: "http://localhost/api/tasks/csv",
    } as Request);

    expect(response.status).toBe(303);
    expect(routeMocks.taskArtifactsCreate).toHaveBeenCalledTimes(2);
    expect(routeMocks.taskArtifactsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: "csv-summary.md",
        mimeType: "text/markdown; charset=utf-8",
      }),
    );
    expect(routeMocks.taskArtifactsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: "csv-summary-chart.svg",
        mimeType: "image/svg+xml; charset=utf-8",
      }),
    );
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
