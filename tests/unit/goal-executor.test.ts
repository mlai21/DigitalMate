import { describe, expect, it, vi } from "vitest";
import type { DbGoal } from "@/server/db/repositories";
import type { GoalContract } from "@/server/goals/contract";
import { executeGoalStep, extractJsonObject } from "@/server/goals/executor";
import type { LlmClient, LlmStreamEvent, LlmStreamInput, LlmTool } from "@/server/llm/types";

const contract: GoalContract = {
  objective: "整理主题 X 的可靠来源",
  successCriteria: [{ id: "c1", description: "至少 5 个来源", verification: "来源计数" }],
  cadence: { mode: "continuous" },
  scope: { allowedTools: ["web_search", "memory_search"], forbidden: ["对外发送消息"] },
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

const finalJson = JSON.stringify({
  intent: "搜集主题 X 的来源",
  evidence: [{ source: "示例站", url: "https://example.com", summary: "事实 A" }],
  candidate: "## 发现\n- 事实 A",
  progressSummary: "找到了第一批来源",
  failedPaths: ["查询词 Y 无结果"],
});

function buildLlm(turns: LlmStreamEvent[][]): { llm: LlmClient; seenTools: LlmTool[][] } {
  const seenTools: LlmTool[][] = [];
  let turn = 0;
  const llm: LlmClient = {
    async *stream(input: LlmStreamInput) {
      seenTools.push(input.tools ?? []);
      const events = turns[Math.min(turn, turns.length - 1)];
      turn += 1;
      for (const event of events) yield event;
    },
    async completeText() {
      return "";
    },
  };
  return { llm, seenTools };
}

describe("executeGoalStep", () => {
  it("runs whitelisted tools then parses the structured candidate", async () => {
    const { llm, seenTools } = buildLlm([
      [{ type: "tool_call", toolCall: { id: "t1", name: "web_search", arguments: '{"query":"主题 X"}' } }],
      [{ type: "text", text: `\u597d\u7684\n\`\`\`json\n${finalJson}\n\`\`\`` }],
    ]);
    const search = { run: vi.fn(async () => ({ summary: "1. 示例站：事实 A (https://example.com)" })) };
    const toolLogs = { create: vi.fn(async () => undefined) };

    const candidate = await executeGoalStep({
      goal,
      recentSteps: [],
      llm,
      model: "main-model",
      search,
      memories: { findRelevant: vi.fn(async () => []) },
      toolLogs,
    });

    expect(search.run).toHaveBeenCalledWith("主题 X");
    expect(candidate.intent).toBe("搜集主题 X 的来源");
    expect(candidate.evidence).toEqual([{ source: "示例站", url: "https://example.com", summary: "事实 A" }]);
    expect(candidate.candidate).toContain("事实 A");
    expect(candidate.failedPaths).toEqual(["查询词 Y 无结果"]);
    expect(candidate.tokensUsed).toBeGreaterThan(0);
    // Tool calls are logged with the goal dimension for admin replay.
    expect(toolLogs.create).toHaveBeenCalledWith(
      expect.objectContaining({ goalId: "goal-1", toolName: "web_search", status: "success" }),
    );
    // Only whitelisted tools are exposed to the model.
    expect(seenTools[0].map((tool) => tool.name)).toEqual(["web_search", "memory_search"]);
  });

  it("restricts the tool table to the contract whitelist", async () => {
    const { llm, seenTools } = buildLlm([[{ type: "text", text: finalJson }]]);
    const narrowGoal: DbGoal = { ...goal, contract: { ...contract, scope: { allowedTools: ["web_search"], forbidden: [] } } };

    await executeGoalStep({
      goal: narrowGoal,
      recentSteps: [],
      llm,
      model: "main-model",
      search: { run: vi.fn(async () => ({ summary: "" })) },
      memories: { findRelevant: vi.fn(async () => []) },
      toolLogs: { create: vi.fn(async () => undefined) },
    });

    expect(seenTools[0].map((tool) => tool.name)).toEqual(["web_search"]);
  });

  it("rejects tool calls outside the whitelist and tells the model", async () => {
    const { llm } = buildLlm([
      [{ type: "tool_call", toolCall: { id: "t1", name: "run_sandbox", arguments: '{"query":"rm -rf"}' } }],
      [{ type: "text", text: finalJson }],
    ]);
    const toolLogs = { create: vi.fn(async () => undefined) };

    await executeGoalStep({
      goal,
      recentSteps: [],
      llm,
      model: "main-model",
      search: { run: vi.fn(async () => ({ summary: "" })) },
      memories: { findRelevant: vi.fn(async () => []) },
      toolLogs,
    });

    expect(toolLogs.create).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "goal_tool:run_sandbox", status: "error" }),
    );
  });

  it("falls back to a plain candidate when the model output is not valid JSON", async () => {
    const { llm } = buildLlm([[{ type: "text", text: "本轮没有产出结构化结果" }]]);

    const candidate = await executeGoalStep({
      goal,
      recentSteps: [],
      llm,
      model: "main-model",
      search: { run: vi.fn(async () => ({ summary: "" })) },
      memories: { findRelevant: vi.fn(async () => []) },
      toolLogs: { create: vi.fn(async () => undefined) },
    });

    expect(candidate.intent).toBe("本轮没有产出结构化结果");
    expect(candidate.evidence).toEqual([]);
    expect(candidate.candidate).toBe("");
  });
});

describe("extractJsonObject", () => {
  it("parses fenced, bare, and surrounded JSON", () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(extractJsonObject('前言 {"a":1} 后记')).toEqual({ a: 1 });
    expect(extractJsonObject("不是 JSON")).toBeNull();
  });
});
