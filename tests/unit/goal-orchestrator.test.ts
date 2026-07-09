import { describe, expect, it, vi } from "vitest";
import type { createRepositories, DbGoal } from "@/server/db/repositories";
import { cadenceIntervalMinutes, type GoalContract } from "@/server/goals/contract";
import { processGoalLoops } from "@/server/goals/orchestrator";

const baseContract: GoalContract = {
  objective: "整理某主题的可靠来源",
  successCriteria: [{ id: "c1", description: "至少 5 个可靠来源", verification: "来源计数" }],
  cadence: { mode: "interval", intervalMinutes: 30 },
  scope: { allowedTools: ["web_search", "memory_search"], forbidden: [] },
  budget: { maxRounds: 20, maxTokens: 200_000 },
  stopConditions: { maxNoProgressRounds: 3, escalation: [] },
  deliverable: { format: "report" },
};

function buildGoal(overrides: Partial<DbGoal>): DbGoal {
  return {
    id: "goal-1",
    userId: "user-1",
    title: "测试目标",
    contract: baseContract,
    status: "running",
    progressSummary: "",
    reportDraft: "",
    budgetUsed: { rounds: 0, tokens: 0, costUsd: 0 },
    noProgressRounds: 0,
    runningStep: null,
    needsHumanPrompt: null,
    conversationId: null,
    nextRunAt: new Date("2026-07-09T00:00:00Z"),
    finishedAt: null,
    createdAt: new Date("2026-07-08T00:00:00Z"),
    updatedAt: new Date("2026-07-08T00:00:00Z"),
    ...overrides,
  };
}

function buildRepositories(goals: DbGoal[], options?: { claimResult?: boolean }) {
  const setStatus = vi.fn(async () => undefined);
  const claimRunningStep = vi.fn(async () => options?.claimResult ?? true);
  const releaseRunningStep = vi.fn(async () => undefined);
  const repositories = {
    goals: {
      listDue: vi.fn(async () => goals),
      setStatus,
      claimRunningStep,
      releaseRunningStep,
    },
  } as unknown as ReturnType<typeof createRepositories>;
  return { repositories, setStatus, claimRunningStep, releaseRunningStep };
}

describe("processGoalLoops (M-A idle pickup)", () => {
  it("promotes confirmed goals to running through the state machine before executing", async () => {
    const now = new Date("2026-07-09T06:00:00Z");
    const goal = buildGoal({ status: "confirmed", nextRunAt: null });
    const { repositories, setStatus, releaseRunningStep } = buildRepositories([goal]);

    const outcome = await processGoalLoops({ repositories, now });

    expect(setStatus).toHaveBeenCalledWith(goal.id, "running", { nextRunAt: now });
    expect(outcome).toEqual({ pickedUp: 1, deferred: 1, skipped: 0 });
    expect(releaseRunningStep).toHaveBeenCalledOnce();
  });

  it("claims a due running goal then releases it with next_run_at deferred by cadence", async () => {
    const now = new Date("2026-07-09T06:00:00Z");
    const goal = buildGoal({ status: "running" });
    const { repositories, claimRunningStep, releaseRunningStep } = buildRepositories([goal]);

    const outcome = await processGoalLoops({ repositories, now });

    expect(claimRunningStep).toHaveBeenCalledWith(goal.id, expect.any(String));
    const [, nextRunAt] = releaseRunningStep.mock.calls[0] as unknown as [string, Date];
    expect(nextRunAt.getTime()).toBe(now.getTime() + 30 * 60_000);
    expect(outcome).toEqual({ pickedUp: 0, deferred: 1, skipped: 0 });
  });

  it("skips goals whose running step is already claimed by another round", async () => {
    const goal = buildGoal({ status: "running" });
    const { repositories, releaseRunningStep } = buildRepositories([goal], { claimResult: false });

    const outcome = await processGoalLoops({ repositories });

    expect(outcome).toEqual({ pickedUp: 0, deferred: 0, skipped: 1 });
    expect(releaseRunningStep).not.toHaveBeenCalled();
  });

  it("does nothing when no goal is due", async () => {
    const { repositories, setStatus, claimRunningStep } = buildRepositories([]);

    const outcome = await processGoalLoops({ repositories });

    expect(outcome).toEqual({ pickedUp: 0, deferred: 0, skipped: 0 });
    expect(setStatus).not.toHaveBeenCalled();
    expect(claimRunningStep).not.toHaveBeenCalled();
  });
});

describe("cadenceIntervalMinutes", () => {
  it("uses the contract interval in interval mode", () => {
    expect(cadenceIntervalMinutes(baseContract)).toBe(30);
  });

  it("falls back to one minute for continuous mode and invalid intervals", () => {
    expect(cadenceIntervalMinutes({ ...baseContract, cadence: { mode: "continuous" } })).toBe(1);
    expect(cadenceIntervalMinutes({ ...baseContract, cadence: { mode: "interval", intervalMinutes: 0 } })).toBe(1);
  });
});
