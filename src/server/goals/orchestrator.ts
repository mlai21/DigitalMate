import { randomUUID } from "node:crypto";
import type { createRepositories } from "@/server/db/repositories";
import { cadenceIntervalMinutes } from "@/server/goals/contract";
import { reduceGoalStatus } from "@/server/goals/state-machine";

type GoalLoopDeps = {
  repositories: ReturnType<typeof createRepositories>;
  now?: Date;
};

export type GoalLoopOutcome = {
  pickedUp: number;
  deferred: number;
  skipped: number;
};

/**
 * Control-plane loop driver, called from the agent-service tick. Picks up due
 * goals and advances the state machine.
 *
 * M-A skeleton: no executor yet — confirmed goals transition to running, due
 * running goals are claimed then immediately released with next_run_at
 * deferred by contract cadence. M-B replaces the idle block with
 * executeGoalStep/verifyGoalStep.
 */
export async function processGoalLoops({ repositories, now = new Date() }: GoalLoopDeps): Promise<GoalLoopOutcome> {
  const outcome: GoalLoopOutcome = { pickedUp: 0, deferred: 0, skipped: 0 };
  const dueGoals = await repositories.goals.listDue(now);

  for (const goal of dueGoals) {
    let status = goal.status;

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

    const nextRunAt = new Date(now.getTime() + cadenceIntervalMinutes(goal.contract) * 60_000);
    await repositories.goals.releaseRunningStep(goal.id, nextRunAt);
    outcome.deferred += 1;
  }

  return outcome;
}
