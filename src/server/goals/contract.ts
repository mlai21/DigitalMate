export type GoalSuccessCriterion = {
  id: string;
  description: string;
  verification: string;
};

export type GoalContract = {
  objective: string;
  successCriteria: GoalSuccessCriterion[];
  cadence: {
    mode: "continuous" | "interval";
    intervalMinutes?: number;
  };
  scope: {
    allowedTools: string[];
    forbidden: string[];
  };
  budget: {
    maxRounds: number;
    maxTokens: number;
    maxCostUsd?: number;
    deadlineAt?: string;
  };
  stopConditions: {
    maxNoProgressRounds: number;
    escalation: string[];
  };
  deliverable: {
    format: "report";
    milestones?: string[];
  };
};

export type GoalBudgetUsed = {
  rounds: number;
  tokens: number;
  costUsd: number;
};

export const DEFAULT_GOAL_BUDGET_USED: GoalBudgetUsed = { rounds: 0, tokens: 0, costUsd: 0 };

/** Minutes to defer next_run_at between rounds, derived from contract cadence. */
export function cadenceIntervalMinutes(contract: GoalContract): number {
  if (contract.cadence?.mode === "interval" && contract.cadence.intervalMinutes && contract.cadence.intervalMinutes > 0) {
    return contract.cadence.intervalMinutes;
  }
  // Continuous mode still yields between rounds so a single goal cannot
  // monopolize every tick; one round per tick interval is the floor.
  return 1;
}

export type GoalEvidenceItem = {
  source: string;
  url?: string;
  summary: string;
};

export function isGoalEvidenceItem(value: unknown): value is GoalEvidenceItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.source === "string" && typeof item.summary === "string";
}

export function formatGoalEvidence(item: GoalEvidenceItem): string {
  return item.url ? `${item.source}：${item.summary}（${item.url}）` : `${item.source}：${item.summary}`;
}

export type GoalBudgetVerdict = { exhausted: false } | { exhausted: true; reason: string };

/**
 * Hard budget boundary, enforced by the control plane before every round.
 * The model can never override this check.
 */
export function checkGoalBudget(contract: GoalContract, used: GoalBudgetUsed, now: Date): GoalBudgetVerdict {
  const budget = contract.budget;
  if (!budget) return { exhausted: false };
  if (budget.maxRounds > 0 && used.rounds >= budget.maxRounds) {
    return { exhausted: true, reason: `轮数已达上限 ${budget.maxRounds}` };
  }
  if (budget.maxTokens > 0 && used.tokens >= budget.maxTokens) {
    return { exhausted: true, reason: `token 消耗已达上限 ${budget.maxTokens}` };
  }
  if (budget.maxCostUsd !== undefined && budget.maxCostUsd > 0 && used.costUsd >= budget.maxCostUsd) {
    return { exhausted: true, reason: `费用已达上限 $${budget.maxCostUsd}` };
  }
  if (budget.deadlineAt) {
    const deadline = new Date(budget.deadlineAt);
    if (!Number.isNaN(deadline.getTime()) && now >= deadline) {
      return { exhausted: true, reason: `已到时间上限 ${budget.deadlineAt}` };
    }
  }
  return { exhausted: false };
}
