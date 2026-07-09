import { describe, expect, it, vi } from "vitest";
import type { DbGoal } from "@/server/db/repositories";
import type { GoalContract } from "@/server/goals/contract";
import type { GoalStepCandidate } from "@/server/goals/executor";
import { verifyGoalStep } from "@/server/goals/verifier";
import type { LlmClient } from "@/server/llm/types";

const contract: GoalContract = {
  objective: "整理主题 X 的可靠来源",
  successCriteria: [
    { id: "c1", description: "覆盖 A 子方向", verification: "来源计数" },
    { id: "c2", description: "覆盖 B 子方向", verification: "来源计数" },
  ],
  cadence: { mode: "continuous" },
  scope: { allowedTools: ["web_search"], forbidden: [] },
  budget: { maxRounds: 10, maxTokens: 100_000 },
  stopConditions: { maxNoProgressRounds: 3, escalation: [] },
  deliverable: { format: "report" },
};

const goal: DbGoal = {
  id: "goal-1",
  userId: "user-1",
  title: "主题 X 调研",
  contract,
  status: "running",
  progressSummary: "",
  reportDraft: "",
  budgetUsed: { rounds: 0, tokens: 0, costUsd: 0 },
  noProgressRounds: 0,
  runningStep: null,
  needsHumanPrompt: null,
  conversationId: null,
  nextRunAt: null,
  finishedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const candidate: GoalStepCandidate = {
  intent: "搜集 A 子方向",
  evidence: [{ source: "示例站", url: "https://example.com/a", summary: "事实 A" }],
  candidate: "## A\n- 事实 A",
  progressSummary: "A 方向推进中",
  failedPaths: [],
  tokensUsed: 100,
};

function buildLlm(response: string): { llm: LlmClient; seen: { system: string; user: string }[] } {
  const seen: { system: string; user: string }[] = [];
  const llm: LlmClient = {
    async *stream() {
      yield { type: "text" as const, text: "" };
    },
    completeText: vi.fn(async (input: { messages: Array<{ role: string; content: string }> }) => {
      seen.push({
        system: input.messages.find((message) => message.role === "system")?.content ?? "",
        user: input.messages.find((message) => message.role === "user")?.content ?? "",
      });
      return response;
    }),
  };
  return { llm, seen };
}

describe("verifyGoalStep", () => {
  it("passes the checklist and candidate to an independent prompt without executor reasoning", async () => {
    const { llm, seen } = buildLlm(
      JSON.stringify({ progressed: true, criteriaStatus: [], allMet: false, summary: "有进展" }),
    );

    const result = await verifyGoalStep({
      goal,
      candidate,
      priorEvidence: [{ source: "旧来源", url: "https://example.com/old", summary: "旧事实" }],
      llm,
      model: "light-model",
    });

    expect(result.progressed).toBe(true);
    expect(seen[0].user).toContain("[c1] 覆盖 A 子方向");
    expect(seen[0].user).toContain("https://example.com/old");
    expect(seen[0].user).toContain("事实 A");
    // Executor's intent/reasoning is not part of the verify prompt.
    expect(seen[0].user).not.toContain("搜集 A 子方向");
    expect(result.tokensUsed).toBeGreaterThan(0);
  });

  it("downgrades met criteria that lack evidence references", async () => {
    const { llm } = buildLlm(
      JSON.stringify({
        progressed: true,
        criteriaStatus: [
          { id: "c1", met: true, evidenceRefs: [], note: "模型声称完成但没引用" },
          { id: "c2", met: true, evidenceRefs: ["https://example.com/b"], note: "" },
        ],
        allMet: true,
        summary: "看起来都完成了",
      }),
    );

    const result = await verifyGoalStep({ goal, candidate, priorEvidence: [], llm, model: "light-model" });

    expect(result.criteriaStatus.find((status) => status.id === "c1")?.met).toBe(false);
    expect(result.criteriaStatus.find((status) => status.id === "c2")?.met).toBe(true);
    // c1 is not genuinely met, so allMet must be forced false in code.
    expect(result.allMet).toBe(false);
    expect(result.evidenceRefs).toEqual(["https://example.com/b"]);
  });

  it("confirms allMet only when every contract criterion is met with evidence", async () => {
    const { llm } = buildLlm(
      JSON.stringify({
        progressed: true,
        criteriaStatus: [
          { id: "c1", met: true, evidenceRefs: ["https://example.com/a"], note: "" },
          { id: "c2", met: true, evidenceRefs: ["https://example.com/b"], note: "" },
        ],
        allMet: true,
        summary: "全部达成",
      }),
    );

    const result = await verifyGoalStep({ goal, candidate, priorEvidence: [], llm, model: "light-model" });

    expect(result.allMet).toBe(true);
    expect(result.evidenceRefs).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("forces progressed to false when the round produced no new material", async () => {
    const { llm } = buildLlm(JSON.stringify({ progressed: true, criteriaStatus: [], allMet: false, summary: "" }));
    const emptyCandidate: GoalStepCandidate = { ...candidate, evidence: [], candidate: "" };

    const result = await verifyGoalStep({ goal, candidate: emptyCandidate, priorEvidence: [], llm, model: "light-model" });

    expect(result.progressed).toBe(false);
  });

  it("returns a conservative result when the verifier output is unparseable", async () => {
    const { llm } = buildLlm("我觉得完成得不错！");

    const result = await verifyGoalStep({ goal, candidate, priorEvidence: [], llm, model: "light-model" });

    expect(result.progressed).toBe(false);
    expect(result.allMet).toBe(false);
    expect(result.evidenceRefs).toEqual([]);
  });
});
