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
