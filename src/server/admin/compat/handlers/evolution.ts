import { z } from "zod";
import { readAdminCompatJson } from "@/server/admin/compat/json";
import {
  AdminCompatError,
  type AdminCompatHandler,
} from "@/server/admin/compat/types";
import {
  AdminEvolutionError,
  type AdminEvolutionService,
  type AdminGoalAction,
} from "@/server/admin/views/evolution";
import {
  GOAL_STATUSES,
  type GoalStatus,
} from "@/server/goals/state-machine";

export type { AdminEvolutionService } from "@/server/admin/views/evolution";

const clockSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u);
const interjectionPolicyMutationSchema = z
  .object({
    revision: z.number().int().min(1),
    operation_id: z.string().uuid(),
    policy: z
      .object({
        min_interval_minutes: z.number().int().min(1).max(1_440),
        max_per_hour: z.number().int().min(1).max(100),
        max_per_day: z.number().int().min(1).max(1_000),
        quiet_start: clockSchema,
        quiet_end: clockSchema,
      })
      .strict(),
  })
  .strict();
const goalActionMutationSchema = z
  .object({
    revision: z.number().int().min(1),
    operation_id: z.string().uuid(),
  })
  .strict();
const goalActionSchema = z.enum([
  "confirm",
  "pause",
  "resume",
  "cancel",
  "human_replied",
]);

export function createGetInterjectionsHandler(
  service: AdminEvolutionService,
): AdminCompatHandler {
  return async (context) =>
    service.getInterjections(context.scope, context.signal);
}

export function createUpdateInterjectionPolicyHandler(
  service: AdminEvolutionService,
): AdminCompatHandler {
  return async (context) => {
    try {
      const body = interjectionPolicyMutationSchema.parse(
        await readAdminCompatJson(context.request),
      );
      return await service.updateInterjectionPolicy(
        context.scope,
        {
          minIntervalMinutes:
            body.policy.min_interval_minutes,
          maxPerHour: body.policy.max_per_hour,
          maxPerDay: body.policy.max_per_day,
          quietStart: body.policy.quiet_start,
          quietEnd: body.policy.quiet_end,
        },
        {
          expectedRevision: body.revision,
          operationId: body.operation_id,
        },
        context.signal,
      );
    } catch (error) {
      throw mapEvolutionError(error);
    }
  };
}

export function createListGoalsHandler(
  service: AdminEvolutionService,
): AdminCompatHandler {
  return async (context) => {
    const url = new URL(context.request.url);
    const rawStatus = url.searchParams.get("status");
    let status: GoalStatus | undefined;
    if (rawStatus !== null) {
      const parsed = z.enum(GOAL_STATUSES).safeParse(rawStatus);
      if (!parsed.success) {
        throw new AdminCompatError(
          400,
          "invalid_request",
          "invalid_goal_status",
        );
      }
      status = parsed.data;
    }
    return service.listGoals(
      context.scope,
      status ? { status } : {},
      context.signal,
    );
  };
}

export function createGetGoalHandler(
  service: AdminEvolutionService,
): AdminCompatHandler {
  return async (context) => {
    try {
      const goal = await service.getGoal(
        context.scope,
        readGoalId(context.params.goalId),
        context.signal,
      );
      if (!goal) throw goalNotFound();
      return goal;
    } catch (error) {
      throw mapEvolutionError(error);
    }
  };
}

export function createGoalActionHandler(
  service: AdminEvolutionService,
): AdminCompatHandler {
  return async (context) => {
    try {
      const action = goalActionSchema.safeParse(
        context.params.action,
      );
      if (!action.success) {
        throw new AdminCompatError(
          400,
          "invalid_request",
          "invalid_goal_action",
        );
      }
      const body = goalActionMutationSchema.parse(
        await readAdminCompatJson(context.request),
      );
      const goal = await service.actOnGoal(
        context.scope,
        readGoalId(context.params.goalId),
        action.data as AdminGoalAction,
        {
          expectedRevision: body.revision,
          operationId: body.operation_id,
        },
        context.signal,
      );
      if (!goal) throw goalNotFound();
      return goal;
    } catch (error) {
      throw mapEvolutionError(error);
    }
  };
}

function readGoalId(value: string | undefined): string {
  const result = z.string().uuid().safeParse(value);
  if (!result.success) {
    throw new AdminCompatError(
      400,
      "invalid_request",
      "invalid_goal_id",
    );
  }
  return result.data;
}

function goalNotFound(): AdminCompatError {
  return new AdminCompatError(
    404,
    "not_found",
    "goal_not_found",
  );
}

function mapEvolutionError(error: unknown): unknown {
  if (error instanceof AdminEvolutionError) {
    return new AdminCompatError(
      error.status,
      error.code,
      error.code,
    );
  }
  return error;
}
