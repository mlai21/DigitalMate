import { describe, expect, it, vi } from "vitest";
import { completeTaskWithSkillDraft } from "@/server/tasks/skill-drafts";

describe("completeTaskWithSkillDraft", () => {
  it("marks a task complete and creates a pending skill draft", async () => {
    const repositories = {
      taskRuns: { complete: vi.fn() },
      skills: { create: vi.fn() },
    };

    await completeTaskWithSkillDraft(repositories, {
      userId: "user-1",
      taskRunId: "task-1",
      kind: "spreadsheet",
      inputSummary: "表格汇总：sales.xlsx",
      outputSummary: "表格汇总报告已生成。",
    });

    expect(repositories.taskRuns.complete).toHaveBeenCalledWith("task-1", "表格汇总报告已生成。");
    expect(repositories.skills.create).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        name: "表格汇总任务流程",
        status: "pending",
        trigger: expect.stringContaining("sales.xlsx"),
      }),
    );
  });

  it("does not fail a completed task when skill draft creation fails", async () => {
    const repositories = {
      taskRuns: { complete: vi.fn() },
      skills: { create: vi.fn(async () => Promise.reject(new Error("skill write failed"))) },
    };

    await expect(
      completeTaskWithSkillDraft(repositories, {
        userId: "user-1",
        taskRunId: "task-1",
        kind: "sandbox",
        inputSummary: "沙箱执行：node task.js",
        outputSummary: "沙箱任务已执行，输出文件已生成。",
      }),
    ).resolves.toBeUndefined();

    expect(repositories.taskRuns.complete).toHaveBeenCalledWith("task-1", "沙箱任务已执行，输出文件已生成。");
  });
});
