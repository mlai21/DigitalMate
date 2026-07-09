import { describe, expect, it, vi } from "vitest";
import type { createRepositories, DbGoal, DbGoalStep } from "@/server/db/repositories";
import { cadenceIntervalMinutes, checkGoalBudget, type GoalContract } from "@/server/goals/contract";
import type { GoalStepCandidate } from "@/server/goals/executor";
import { appendReportDraft, processGoalLoops, type GoalRoundServices } from "@/server/goals/orchestrator";
import type { GoalVerifyResult } from "@/server/goals/verifier";

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

const progressCandidate: GoalStepCandidate = {
  intent: "搜集 A 子方向来源",
  evidence: [{ source: "示例来源", url: "https://example.com/a", summary: "事实 A" }],
  candidate: "## A 子方向\n- 事实 A",
  progressSummary: "A 方向已经有眉目了",
  failedPaths: [],
  tokensUsed: 1000,
};

const progressVerify: GoalVerifyResult = {
  progressed: true,
  criteriaStatus: [{ id: "c1", met: false, evidenceRefs: [], note: "来源还不够" }],
  allMet: false,
  evidenceRefs: [],
  summary: "有进展但未达成",
  tokensUsed: 200,
};

function buildHarness(options: {
  goals: DbGoal[];
  priorSteps?: DbGoalStep[];
  claimResult?: boolean;
  candidate?: GoalStepCandidate;
  verify?: GoalVerifyResult;
  executeError?: Error;
}) {
  const setStatus = vi.fn(async () => undefined);
  const claimRunningStep = vi.fn(async () => options.claimResult ?? true);
  const releaseRunningStep = vi.fn(async () => undefined);
  const updateProgress = vi.fn(async () => undefined);
  const createStep = vi.fn(async () => "step-1");
  const repositories = {
    goals: { listDue: vi.fn(async () => options.goals), setStatus, claimRunningStep, releaseRunningStep, updateProgress },
    goalSteps: { listByGoal: vi.fn(async () => options.priorSteps ?? []), create: createStep },
  } as unknown as ReturnType<typeof createRepositories>;

  const executeStep = vi.fn(async () => {
    if (options.executeError) throw options.executeError;
    return options.candidate ?? progressCandidate;
  });
  const verifyStep = vi.fn(async () => options.verify ?? progressVerify);
  const services: GoalRoundServices = { executeStep, verifyStep };

  return { repositories, services, setStatus, claimRunningStep, releaseRunningStep, updateProgress, createStep, executeStep, verifyStep };
}

describe("processGoalLoops (M-B closed loop)", () => {
  it("promotes confirmed goals to running and immediately runs the first round", async () => {
    const now = new Date("2026-07-09T06:00:00Z");
    const goal = buildGoal({ status: "confirmed", nextRunAt: null });
    const harness = buildHarness({ goals: [goal] });

    const outcome = await processGoalLoops({ repositories: harness.repositories, services: harness.services, now });

    expect(harness.setStatus).toHaveBeenCalledWith(goal.id, "running", { nextRunAt: now });
    expect(harness.executeStep).toHaveBeenCalledOnce();
    expect(outcome.pickedUp).toBe(1);
    expect(outcome.rounds).toBe(1);
  });

  it("stops with failed_budget before executing when the budget is exhausted", async () => {
    const goal = buildGoal({ budgetUsed: { rounds: 20, tokens: 0, costUsd: 0 } });
    const harness = buildHarness({ goals: [goal] });

    const outcome = await processGoalLoops({ repositories: harness.repositories, services: harness.services });

    expect(harness.executeStep).not.toHaveBeenCalled();
    expect(harness.setStatus).toHaveBeenCalledWith(goal.id, "failed_budget", { finished: true, nextRunAt: null });
    expect(harness.createStep).toHaveBeenCalledWith(expect.objectContaining({ phase: "failed" }));
    expect(outcome.stopped).toBe(1);
  });

  it("commits a progressed round to the ledger and defers next_run_at by cadence", async () => {
    const now = new Date("2026-07-09T06:00:00Z");
    const goal = buildGoal({ noProgressRounds: 2 });
    const harness = buildHarness({ goals: [goal] });

    await processGoalLoops({ repositories: harness.repositories, services: harness.services, now });

    expect(harness.createStep).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "committed",
        round: 1,
        intent: progressCandidate.intent,
        tokensUsed: progressCandidate.tokensUsed + progressVerify.tokensUsed,
      }),
    );
    expect(harness.updateProgress).toHaveBeenCalledWith(
      goal.id,
      expect.objectContaining({
        noProgressRounds: 0,
        budgetUsed: { rounds: 1, tokens: 1200, costUsd: 0 },
        progressSummary: progressCandidate.progressSummary,
      }),
    );
    const [, nextRunAt] = harness.releaseRunningStep.mock.calls[0] as unknown as [string, Date];
    expect(nextRunAt.getTime()).toBe(now.getTime() + 30 * 60_000);
  });

  it("transitions to succeeded when the verifier confirms all criteria with evidence", async () => {
    const goal = buildGoal({});
    const harness = buildHarness({
      goals: [goal],
      verify: {
        progressed: true,
        criteriaStatus: [{ id: "c1", met: true, evidenceRefs: ["https://example.com/a"], note: "" }],
        allMet: true,
        evidenceRefs: ["https://example.com/a"],
        summary: "全部达成",
        tokensUsed: 200,
      },
    });

    const outcome = await processGoalLoops({ repositories: harness.repositories, services: harness.services });

    expect(harness.setStatus).toHaveBeenCalledWith(goal.id, "succeeded", { finished: true, nextRunAt: null });
    expect(outcome.succeeded).toBe(1);
  });

  it("never transitions to succeeded when allMet lacks evidence references", async () => {
    const goal = buildGoal({});
    const harness = buildHarness({
      goals: [goal],
      verify: { progressed: true, criteriaStatus: [], allMet: true, evidenceRefs: [], summary: "", tokensUsed: 0 },
    });

    const outcome = await processGoalLoops({ repositories: harness.repositories, services: harness.services });

    expect(outcome.succeeded).toBe(0);
    expect(harness.setStatus).not.toHaveBeenCalledWith(goal.id, "succeeded", expect.anything());
  });

  it("stops with failed_no_progress when consecutive no-progress rounds hit the contract limit", async () => {
    const goal = buildGoal({ noProgressRounds: 2 });
    const harness = buildHarness({
      goals: [goal],
      candidate: { ...progressCandidate, evidence: [], candidate: "" },
      verify: { ...progressVerify, progressed: false },
    });

    const outcome = await processGoalLoops({ repositories: harness.repositories, services: harness.services });

    expect(harness.updateProgress).toHaveBeenCalledWith(goal.id, expect.objectContaining({ noProgressRounds: 3 }));
    expect(harness.setStatus).toHaveBeenCalledWith(goal.id, "failed_no_progress", { finished: true, nextRunAt: null });
    expect(outcome.stopped).toBe(1);
  });

  it("records a failed ledger row and counts a no-progress round when execution throws", async () => {
    const goal = buildGoal({ noProgressRounds: 0 });
    const harness = buildHarness({ goals: [goal], executeError: new Error("search unavailable") });

    const outcome = await processGoalLoops({ repositories: harness.repositories, services: harness.services });

    expect(harness.createStep).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "failed", error: "search unavailable" }),
    );
    expect(harness.updateProgress).toHaveBeenCalledWith(goal.id, expect.objectContaining({ noProgressRounds: 1 }));
    expect(harness.releaseRunningStep).toHaveBeenCalledOnce();
    expect(outcome.rounds).toBe(1);
    expect(outcome.stopped).toBe(0);
  });

  it("skips goals whose running step is already claimed", async () => {
    const goal = buildGoal({});
    const harness = buildHarness({ goals: [goal], claimResult: false });

    const outcome = await processGoalLoops({ repositories: harness.repositories, services: harness.services });

    expect(outcome.skipped).toBe(1);
    expect(harness.executeStep).not.toHaveBeenCalled();
  });
});

describe("checkGoalBudget", () => {
  const used = { rounds: 5, tokens: 1000, costUsd: 0.5 };

  it("passes when all limits have headroom", () => {
    expect(checkGoalBudget(baseContract, used, new Date())).toEqual({ exhausted: false });
  });

  it("stops on rounds, tokens, cost, and deadline limits", () => {
    expect(checkGoalBudget(baseContract, { ...used, rounds: 20 }, new Date()).exhausted).toBe(true);
    expect(checkGoalBudget(baseContract, { ...used, tokens: 200_000 }, new Date()).exhausted).toBe(true);
    expect(
      checkGoalBudget({ ...baseContract, budget: { ...baseContract.budget, maxCostUsd: 0.5 } }, used, new Date()).exhausted,
    ).toBe(true);
    expect(
      checkGoalBudget(
        { ...baseContract, budget: { ...baseContract.budget, deadlineAt: "2026-07-01T00:00:00Z" } },
        used,
        new Date("2026-07-09T00:00:00Z"),
      ).exhausted,
    ).toBe(true);
  });
});

describe("appendReportDraft", () => {
  it("appends increments with round markers and skips empty increments", () => {
    expect(appendReportDraft("", 1, "## A\n内容")).toBe("<!-- round 1 -->\n## A\n内容");
    expect(appendReportDraft("已有", 2, "新增")).toBe("已有\n\n<!-- round 2 -->\n新增");
    expect(appendReportDraft("已有", 2, "  ")).toBeUndefined();
  });
});

describe("cadenceIntervalMinutes", () => {
  it("uses the contract interval in interval mode and falls back to one minute otherwise", () => {
    expect(cadenceIntervalMinutes(baseContract)).toBe(30);
    expect(cadenceIntervalMinutes({ ...baseContract, cadence: { mode: "continuous" } })).toBe(1);
    expect(cadenceIntervalMinutes({ ...baseContract, cadence: { mode: "interval", intervalMinutes: 0 } })).toBe(1);
  });
});
