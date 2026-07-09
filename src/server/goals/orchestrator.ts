import { randomUUID } from "node:crypto";
import type { createRepositories, DbGoal, DbGoalStep } from "@/server/db/repositories";
import {
  cadenceIntervalMinutes,
  checkGoalBudget,
  isGoalEvidenceItem,
  type GoalEvidenceItem,
} from "@/server/goals/contract";
import type { GoalStepCandidate } from "@/server/goals/executor";
import type { GoalVerifyResult } from "@/server/goals/verifier";
import { reduceGoalStatus, type GoalStatus } from "@/server/goals/state-machine";

export type GoalRoundServices = {
  executeStep(goal: DbGoal, recentSteps: DbGoalStep[]): Promise<GoalStepCandidate>;
  verifyStep(goal: DbGoal, candidate: GoalStepCandidate, priorEvidence: GoalEvidenceItem[]): Promise<GoalVerifyResult>;
};

type GoalLoopDeps = {
  repositories: ReturnType<typeof createRepositories>;
  services: GoalRoundServices;
  now?: Date;
};

export type GoalLoopOutcome = {
  pickedUp: number;
  rounds: number;
  succeeded: number;
  stopped: number;
  skipped: number;
};

const DEFAULT_MAX_NO_PROGRESS_ROUNDS = 3;

/**
 * Control-plane loop driver, called from the agent-service tick. For every due
 * goal it runs one round: budget pre-check -> execute (LLM plans + read-only
 * tools) -> independent verify -> commit (ledger + state machine decision).
 * State transitions only ever go through reduceGoalStatus; LLM verdicts are
 * inputs, never the transition itself.
 */
export async function processGoalLoops({ repositories, services, now = new Date() }: GoalLoopDeps): Promise<GoalLoopOutcome> {
  const outcome: GoalLoopOutcome = { pickedUp: 0, rounds: 0, succeeded: 0, stopped: 0, skipped: 0 };
  const dueGoals = await repositories.goals.listDue(now);

  for (const goal of dueGoals) {
    let status: GoalStatus = goal.status;

    if (status === "confirmed") {
      const transition = reduceGoalStatus(status, { type: "picked_up" });
      if (!transition.ok) continue;
      await repositories.goals.setStatus(goal.id, transition.status, { nextRunAt: now });
      status = transition.status;
      outcome.pickedUp += 1;
    }

    if (status !== "running") continue;

    const claimed = await repositories.goals.claimRunningStep(goal.id, randomUUID());
    if (!claimed) {
      outcome.skipped += 1;
      continue;
    }

    await runGoalRound({ repositories, services, goal, now, outcome });
  }

  return outcome;
}

async function runGoalRound(context: {
  repositories: ReturnType<typeof createRepositories>;
  services: GoalRoundServices;
  goal: DbGoal;
  now: Date;
  outcome: GoalLoopOutcome;
}): Promise<void> {
  const { repositories, services, goal, now, outcome } = context;
  const startedAt = Date.now();
  const priorSteps = await repositories.goalSteps.listByGoal(goal.id);
  const round = (priorSteps[priorSteps.length - 1]?.round ?? 0) + 1;

  // 1. Budget is a hard control-plane boundary: checked before the model runs.
  const budgetVerdict = checkGoalBudget(goal.contract, goal.budgetUsed, now);
  if (budgetVerdict.exhausted) {
    const transition = reduceGoalStatus("running", { type: "budget_exhausted" });
    if (transition.ok) {
      await repositories.goalSteps.create({
        goalId: goal.id,
        round,
        phase: "failed",
        intent: "预算前置检查",
        error: `预算耗尽：${budgetVerdict.reason}`,
      });
      await repositories.goals.setStatus(goal.id, transition.status, { finished: true, nextRunAt: null });
      outcome.stopped += 1;
    }
    await repositories.goals.releaseRunningStep(goal.id, null);
    return;
  }

  try {
    // 2-3. Execute one round on the execution plane.
    const candidate = await services.executeStep(goal, priorSteps);

    // 4. Independent verification (separate call, checklist + evidence only).
    const priorEvidence = collectEvidence(priorSteps);
    const verify = await services.verifyStep(goal, candidate, priorEvidence);

    // 5. Commit: ledger row, aggregates, then the state machine decision.
    const verifyForLedger = {
      progressed: verify.progressed,
      criteriaStatus: verify.criteriaStatus,
      allMet: verify.allMet,
      evidenceRefs: verify.evidenceRefs,
      summary: verify.summary,
    };
    await repositories.goalSteps.create({
      goalId: goal.id,
      round,
      phase: "committed",
      intent: candidate.intent,
      evidence: candidate.evidence,
      candidate: candidate.candidate,
      verifyResult: verifyForLedger,
      failedPaths: candidate.failedPaths,
      tokensUsed: candidate.tokensUsed + verify.tokensUsed,
      durationMs: Date.now() - startedAt,
    });

    const noProgressRounds = verify.progressed ? 0 : goal.noProgressRounds + 1;
    await repositories.goals.updateProgress(goal.id, {
      progressSummary: candidate.progressSummary || undefined,
      reportDraft: appendReportDraft(goal.reportDraft, round, candidate.candidate),
      budgetUsed: {
        rounds: goal.budgetUsed.rounds + 1,
        tokens: goal.budgetUsed.tokens + candidate.tokensUsed + verify.tokensUsed,
        costUsd: goal.budgetUsed.costUsd,
      },
      noProgressRounds,
    });
    outcome.rounds += 1;

    if (verify.allMet) {
      const transition = reduceGoalStatus("running", { type: "verified_success", evidenceRefs: verify.evidenceRefs });
      if (transition.ok) {
        await repositories.goals.setStatus(goal.id, transition.status, { finished: true, nextRunAt: null });
        await repositories.goals.releaseRunningStep(goal.id, null);
        outcome.succeeded += 1;
        return;
      }
    }

    const maxNoProgress = goal.contract.stopConditions?.maxNoProgressRounds ?? DEFAULT_MAX_NO_PROGRESS_ROUNDS;
    if (noProgressRounds >= maxNoProgress) {
      const transition = reduceGoalStatus("running", { type: "no_progress_limit_reached" });
      if (transition.ok) {
        await repositories.goals.setStatus(goal.id, transition.status, { finished: true, nextRunAt: null });
        await repositories.goals.releaseRunningStep(goal.id, null);
        outcome.stopped += 1;
        return;
      }
    }

    await repositories.goals.releaseRunningStep(goal.id, nextRunAtByCadence(goal, now));
  } catch (error) {
    // Execution/verification failure: leave a ledger row, count it as a
    // no-progress round, and let the next round retry. Backoff lands in M-D.
    const message = error instanceof Error ? error.message : String(error);
    await repositories.goalSteps
      .create({
        goalId: goal.id,
        round,
        phase: "failed",
        error: message.slice(0, 1000),
        durationMs: Date.now() - startedAt,
      })
      .catch(() => undefined);

    const noProgressRounds = goal.noProgressRounds + 1;
    await repositories.goals
      .updateProgress(goal.id, {
        budgetUsed: { ...goal.budgetUsed, rounds: goal.budgetUsed.rounds + 1 },
        noProgressRounds,
      })
      .catch(() => undefined);
    outcome.rounds += 1;

    const maxNoProgress = goal.contract.stopConditions?.maxNoProgressRounds ?? DEFAULT_MAX_NO_PROGRESS_ROUNDS;
    if (noProgressRounds >= maxNoProgress) {
      const transition = reduceGoalStatus("running", { type: "no_progress_limit_reached" });
      if (transition.ok) {
        await repositories.goals.setStatus(goal.id, transition.status, { finished: true, nextRunAt: null });
        await repositories.goals.releaseRunningStep(goal.id, null);
        outcome.stopped += 1;
        return;
      }
    }
    await repositories.goals.releaseRunningStep(goal.id, nextRunAtByCadence(goal, now));
  }
}

function collectEvidence(steps: DbGoalStep[]): GoalEvidenceItem[] {
  return steps.flatMap((step) => (Array.isArray(step.evidence) ? step.evidence.filter(isGoalEvidenceItem) : []));
}

export function appendReportDraft(existing: string, round: number, increment: string): string | undefined {
  const trimmed = increment.trim();
  if (!trimmed) return undefined;
  const section = `<!-- round ${round} -->\n${trimmed}`;
  return existing.trim() ? `${existing.trim()}\n\n${section}` : section;
}

function nextRunAtByCadence(goal: DbGoal, now: Date): Date {
  return new Date(now.getTime() + cadenceIntervalMinutes(goal.contract) * 60_000);
}
