import { describe, expect, it, vi } from "vitest";
import type { DbGoal, DbGoalStep } from "@/server/db/repositories";
import {
  authorizeConfirmedGoalContract,
  hasPersistentGoalNetworkAuthorization,
  projectGoalDetail,
  projectInterjectionOverview,
  reduceAdminGoalAction,
} from "@/server/admin/views/evolution";
import {
  createGoalActionHandler,
  createUpdateInterjectionPolicyHandler,
  type AdminEvolutionService,
} from "@/server/admin/compat/handlers/evolution";
import type { AdminCompatContext } from "@/server/admin/compat/types";

const scope = {
  userId: "10000000-0000-4000-8000-000000000001",
  agentId: "10000000-0000-4000-8000-000000000011",
};
const goalId = "10000000-0000-4000-8000-000000000301";

function goal(
  overrides: Partial<DbGoal> = {},
): DbGoal {
  return {
    id: goalId,
    userId: scope.userId,
    agentId: scope.agentId,
    title: "持续整理可靠 AI 安全资料",
    contract: {
      objective: "整理 AI 安全资料",
      successCriteria: [
        {
          id: "sources",
          description: "至少 10 个可靠来源",
          verification: "逐项核对来源",
        },
      ],
      cadence: { mode: "interval", intervalMinutes: 60 },
      scope: {
        allowedTools: ["web_search", "memory_search"],
        forbidden: ["write_file"],
      },
      budget: {
        maxRounds: 10,
        maxTokens: 20_000,
      },
      stopConditions: {
        maxNoProgressRounds: 3,
        escalation: ["需要登录"],
      },
      deliverable: { format: "report" },
    },
    status: "draft",
    progressSummary: "",
    reportDraft: "",
    budgetUsed: { rounds: 0, tokens: 0, costUsd: 0 },
    noProgressRounds: 0,
    runningStep: null,
    needsHumanPrompt: null,
    conversationId: null,
    nextRunAt: null,
    finishedAt: null,
    createdAt: new Date("2026-07-27T01:00:00Z"),
    updatedAt: new Date("2026-07-27T01:00:00Z"),
    revision: 1,
    ...overrides,
  };
}

describe("admin compatibility evolution", () => {
  it("未确认持久来源的目标不得使用后台联网工具", () => {
    expect(
      hasPersistentGoalNetworkAuthorization(goal()),
    ).toBe(false);
    expect(
      hasPersistentGoalNetworkAuthorization(
        goal({
          contract: {
            ...goal().contract,
            authorization: {
              type: "goal_contract",
              sourceId: goalId,
              networkEnabled: true,
            },
          },
        }),
      ),
    ).toBe(true);
  });

  it("插话视图返回频率、下次时间和平台限制", () => {
    const overview = projectInterjectionOverview({
      scope,
      policy: {
        minIntervalMinutes: 30,
        maxPerHour: 2,
        maxPerDay: 3,
        quietStart: "23:00",
        quietEnd: "08:00",
      },
      now: new Date("2026-07-27T10:00:00Z"),
      decisions: [
        {
          id: "d1",
          agentId: scope.agentId,
          channel: "telegram",
          externalConversationId: "group-a",
          shouldInterject: true,
          reason: "relevant_memory",
          createdAt: new Date("2026-07-27T09:45:00Z"),
        },
        {
          id: "d2",
          agentId: scope.agentId,
          channel: "dingtalk",
          externalConversationId: "group-b",
          shouldInterject: false,
          reason: "mention_required",
          createdAt: new Date("2026-07-27T09:50:00Z"),
        },
      ],
    });

    expect(overview.channels.telegram).toMatchObject({
      capability: "full",
      sent_last_hour: 1,
      next_allowed_at: "2026-07-27T10:15:00.000Z",
    });
    expect(overview.channels.dingtalk).toMatchObject({
      capability: "capability_limited",
      limitation: "unmentioned_group_events_unavailable",
    });
  });

  it("目标确认、暂停与恢复严格经过状态机", () => {
    expect(reduceAdminGoalAction("draft", "confirm")).toEqual({
      ok: true,
      status: "confirmed",
    });
    expect(reduceAdminGoalAction("running", "pause")).toEqual({
      ok: true,
      status: "paused",
    });
    expect(reduceAdminGoalAction("paused", "resume")).toEqual({
      ok: true,
      status: "running",
    });
    expect(reduceAdminGoalAction("draft", "resume")).toMatchObject({
      ok: false,
    });
    expect(
      authorizeConfirmedGoalContract(goalId, goal().contract),
    ).toMatchObject({
      authorization: {
        type: "goal_contract",
        sourceId: goalId,
        networkEnabled: true,
      },
    });
  });

  it("目标详情显示合同、预算和结构化步骤但不返回内部原始载荷", () => {
    const step: DbGoalStep = {
      id: "10000000-0000-4000-8000-000000000311",
      agentId: scope.agentId,
      goalId,
      round: 1,
      phase: "committed",
      intent: "核对权威来源",
      evidence: [{ source: "NIST", summary: "安全框架" }],
      candidate: "候选报告正文",
      verifyResult: { progressed: true, raw_prompt: "secret" },
      failedPaths: ["无效来源"],
      tokensUsed: 100,
      durationMs: 2_000,
      error: null,
      createdAt: new Date("2026-07-27T02:00:00Z"),
    };
    const detail = projectGoalDetail(scope, goal(), [step]);

    expect(detail).toMatchObject({
      id: goalId,
      revision: 1,
      budget_used: { rounds: 0, tokens: 0, cost_usd: 0 },
      steps: [
        expect.objectContaining({
          round: 1,
          phase: "committed",
          evidence_count: 1,
        }),
      ],
    });
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain("candidate");
    expect(serialized).not.toContain("raw_prompt");
    expect(serialized).not.toContain("secret");
  });

  it("目标状态动作强制携带 revision 与操作 ID", async () => {
    const actOnGoal = vi
      .fn<AdminEvolutionService["actOnGoal"]>()
      .mockResolvedValue({
        id: goalId,
        status: "paused",
        revision: 2,
      });
    const handler = createGoalActionHandler({
      actOnGoal,
    } as unknown as AdminEvolutionService);
    const operationId =
      "10000000-0000-4000-8000-000000000399";
    const context = {
      request: new Request(
        `https://mate.example/api/admin/compat/goals/${goalId}/actions/pause`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            revision: 1,
            operation_id: operationId,
          }),
        },
      ),
      params: { goalId, action: "pause" },
      scope,
      csrfVerified: true,
      resources: {},
      signal: new AbortController().signal,
    } as unknown as AdminCompatContext;

    await expect(handler(context)).resolves.toMatchObject({
      status: "paused",
      revision: 2,
    });
    expect(actOnGoal).toHaveBeenCalledWith(
      scope,
      goalId,
      "pause",
      {
        expectedRevision: 1,
        operationId,
      },
      context.signal,
    );
  });

  it("插话策略更新保留完整频率、静默与退避配置", async () => {
    const updateInterjectionPolicy = vi
      .fn<
        AdminEvolutionService["updateInterjectionPolicy"]
      >()
      .mockResolvedValue({
        policy: {
          minIntervalMinutes: 45,
          maxPerHour: 1,
          maxPerDay: 2,
          quietStart: "22:00",
          quietEnd: "08:30",
        },
        revision: 3,
      });
    const handler = createUpdateInterjectionPolicyHandler({
      updateInterjectionPolicy,
    } as unknown as AdminEvolutionService);
    const body = {
      revision: 2,
      operation_id:
        "10000000-0000-4000-8000-000000000398",
      policy: {
        min_interval_minutes: 45,
        max_per_hour: 1,
        max_per_day: 2,
        quiet_start: "22:00",
        quiet_end: "08:30",
      },
    };
    const context = {
      request: new Request(
        "https://mate.example/api/admin/compat/interjections/policy",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      ),
      params: {},
      scope,
      csrfVerified: true,
      resources: {},
      signal: new AbortController().signal,
    } as unknown as AdminCompatContext;

    await handler(context);
    expect(updateInterjectionPolicy).toHaveBeenCalledWith(
      scope,
      {
        minIntervalMinutes: 45,
        maxPerHour: 1,
        maxPerDay: 2,
        quietStart: "22:00",
        quietEnd: "08:30",
      },
      {
        expectedRevision: 2,
        operationId: body.operation_id,
      },
      context.signal,
    );
  });
});
