import { describe, expect, it, vi } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { POST as postPresentationTask } from "@/app/api/tasks/presentation/route";

const routeMocks = vi.hoisted(() => ({
  requireCurrentUser: vi.fn(async () => ({ id: "user-1" })),
  taskArtifactsCreate: vi.fn(async () => "artifact-id"),
  taskRunsComplete: vi.fn(async () => undefined),
  taskRunsCreate: vi.fn(async () => "task-1"),
  skillsCreate: vi.fn(async () => undefined),
  storedBuffers: [] as Buffer[],
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
    writeArtifactFile: vi.fn(async (input: { fileName: string; mimeType: string; buffer: Buffer }) => {
      routeMocks.storedBuffers.push(input.buffer);
      return {
        fileName: input.fileName,
        mimeType: input.mimeType,
        storagePath: `user-1/task-1/${input.fileName}`,
      };
    }),
  };
});

describe("presentation task route", () => {
  it("includes uploaded spreadsheet data in the generated pptx artifact", async () => {
    routeMocks.storedBuffers.length = 0;
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
  });
});

function pptxText(buffer: Buffer): string {
  const files = unzipSync(new Uint8Array(buffer));
  return Object.entries(files)
    .filter(([path]) => path.startsWith("ppt/slides/") && path.endsWith(".xml"))
    .map(([, content]) => strFromU8(content))
    .join("\n");
}
