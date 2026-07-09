export const GOAL_STATUSES = [
  "draft",
  "confirmed",
  "running",
  "paused",
  "needs_human",
  "succeeded",
  "failed_budget",
  "failed_no_progress",
  "cancelled",
] as const;

export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const TERMINAL_GOAL_STATUSES: readonly GoalStatus[] = [
  "succeeded",
  "failed_budget",
  "failed_no_progress",
  "cancelled",
];

export type GoalEvent =
  | { type: "contract_confirmed" }
  | { type: "user_cancelled" }
  | { type: "picked_up" }
  | { type: "user_paused" }
  | { type: "user_resumed" }
  | { type: "escalated"; prompt: string }
  | { type: "human_replied" }
  // Success requires the verifier's evidence references; "I think it's done"
  // without citations must never transition a goal to succeeded.
  | { type: "verified_success"; evidenceRefs: string[] }
  | { type: "budget_exhausted" }
  | { type: "no_progress_limit_reached" };

export type GoalTransitionResult =
  | { ok: true; status: GoalStatus }
  | { ok: false; reason: string };

const TRANSITIONS: Partial<Record<GoalStatus, Partial<Record<GoalEvent["type"], GoalStatus>>>> = {
  draft: {
    contract_confirmed: "confirmed",
    user_cancelled: "cancelled",
  },
  confirmed: {
    picked_up: "running",
    user_cancelled: "cancelled",
  },
  running: {
    user_paused: "paused",
    escalated: "needs_human",
    verified_success: "succeeded",
    budget_exhausted: "failed_budget",
    no_progress_limit_reached: "failed_no_progress",
    user_cancelled: "cancelled",
  },
  paused: {
    user_resumed: "running",
    user_cancelled: "cancelled",
  },
  needs_human: {
    human_replied: "running",
    user_cancelled: "cancelled",
  },
};

/**
 * Pure state transition function: the single entry point for advancing goal
 * status. Control-plane code applies the result; LLM verdicts are only inputs.
 */
export function reduceGoalStatus(current: GoalStatus, event: GoalEvent): GoalTransitionResult {
  if (isTerminalGoalStatus(current)) {
    return { ok: false, reason: `goal is in terminal status "${current}"` };
  }
  if (event.type === "verified_success" && event.evidenceRefs.length === 0) {
    return { ok: false, reason: "verified_success requires non-empty evidence references" };
  }
  const next = TRANSITIONS[current]?.[event.type];
  if (!next) {
    return { ok: false, reason: `event "${event.type}" is not allowed in status "${current}"` };
  }
  return { ok: true, status: next };
}

export function isTerminalGoalStatus(status: GoalStatus): boolean {
  return TERMINAL_GOAL_STATUSES.includes(status);
}
