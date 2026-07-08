import { describe, expect, it, vi } from "vitest";
import {
  buildEventReflection,
  recordEventReflection,
  shouldRecordEventReflection,
  shouldReflectOnUserDissatisfaction,
} from "@/server/evolution/event-reflection";

describe("event reflections", () => {
  it("detects explicit user dissatisfaction without matching neutral messages", () => {
    expect(shouldReflectOnUserDissatisfaction("你刚才理解错了，不是这个意思")).toBe(true);
    expect(shouldReflectOnUserDissatisfaction("这个方向不对，先别再这样答")).toBe(true);
    expect(shouldReflectOnUserDissatisfaction("这个方案不错，继续")).toBe(false);
  });

  it("builds private reflection records for task failures", () => {
    const reflection = buildEventReflection({
      event: "task_failure",
      summary: "PPT 生成失败：模板文件缺失",
    });

    expect(reflection.positives).toContain("及时记录了异常信号");
    expect(reflection.negatives.join("")).toContain("PPT 生成失败");
    expect(reflection.suggestions.join("")).toContain("下次");
  });

  it("records event reflections with source metadata", async () => {
    const create = vi.fn();

    await recordEventReflection(
      { reflections: { create } },
      {
        userId: "user-1",
        event: "task_failure",
        summary: "沙箱任务失败：权限不足",
        source: { taskRunId: "task-1", taskKind: "sandbox" },
      },
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        reflection: expect.objectContaining({
          negatives: expect.arrayContaining([expect.stringContaining("沙箱任务失败")]),
        }),
        sourceWindow: expect.objectContaining({
          event: "task_failure",
          taskRunId: "task-1",
          taskKind: "sandbox",
        }),
      }),
    );
  });

  it("skips neutral dissatisfaction events", async () => {
    const create = vi.fn();

    await recordEventReflection(
      { reflections: { create } },
      {
        userId: "user-1",
        event: "user_dissatisfaction",
        summary: "这个方案不错，继续",
      },
    );

    expect(create).not.toHaveBeenCalled();
  });

  it("deduplicates repeated event reflections within a day", () => {
    expect(shouldRecordEventReflection(new Date("2026-07-05T10:00:00+08:00"), null)).toBe(true);
    expect(
      shouldRecordEventReflection(
        new Date("2026-07-05T10:00:00+08:00"),
        new Date("2026-07-04T09:59:00+08:00"),
      ),
    ).toBe(true);
    expect(
      shouldRecordEventReflection(
        new Date("2026-07-05T10:00:00+08:00"),
        new Date("2026-07-04T10:01:00+08:00"),
      ),
    ).toBe(false);
  });
});
