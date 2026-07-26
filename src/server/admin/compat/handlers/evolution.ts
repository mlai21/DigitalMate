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
const memoryKindSchema = z.enum([
  "episodic",
  "profile",
  "agent_self",
]);
const memoryMutationSchema = z
  .object({
    kind: memoryKindSchema,
    content: z.string().trim().min(1).max(8_000),
    confidence: z.number().min(0).max(1),
    operation_id: z.string().uuid(),
    confirmed: z.boolean(),
  })
  .strict();
const confirmedMutationSchema = z
  .object({
    operation_id: z.string().uuid(),
    confirmed: z.boolean(),
  })
  .strict();
const reflectionActionSchema = z.enum(["apply", "dismiss"]);
const reflectionActionMutationSchema = z
  .object({
    revision: z.number().int().min(1),
    operation_id: z.string().uuid(),
    confirmed: z.boolean(),
    suggestion_indexes: z
      .array(z.number().int().min(0))
      .max(100),
  })
  .strict();
const reflectionStatusSchema = z.enum([
  "recorded",
  "applied",
  "dismissed",
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

export function createListMemoriesHandler(
  service: AdminEvolutionService,
): AdminCompatHandler {
  return async (context) => {
    const url = new URL(context.request.url);
    const rawKind = url.searchParams.get("kind");
    const parsedKind =
      rawKind === null
        ? null
        : memoryKindSchema.safeParse(rawKind);
    if (parsedKind && !parsedKind.success) {
      throw new AdminCompatError(
        400,
        "invalid_request",
        "invalid_memory_kind",
      );
    }
    return service.listMemories(
      context.scope,
      {
        ...(parsedKind?.success
          ? { kind: parsedKind.data }
          : {}),
        limit: readLimit(url),
      },
      context.signal,
    );
  };
}

export function createUpdateMemoryHandler(
  service: AdminEvolutionService,
): AdminCompatHandler {
  return async (context) => {
    try {
      const body = memoryMutationSchema.parse(
        await readAdminCompatJson(context.request),
      );
      if (!body.confirmed) throw confirmationRequired();
      const result = await service.updateMemory(
        context.scope,
        readResourceId(
          context.params.memoryId,
          "memory",
        ),
        {
          kind: body.kind,
          content: body.content,
          confidence: body.confidence,
        },
        {
          operationId: body.operation_id,
          confirmed: body.confirmed,
        },
        context.signal,
      );
      if (!result) throw memoryNotFound();
      return result;
    } catch (error) {
      throw mapEvolutionError(error);
    }
  };
}

export function createDeleteMemoryHandler(
  service: AdminEvolutionService,
): AdminCompatHandler {
  return async (context) => {
    try {
      const body = confirmedMutationSchema.parse(
        await readAdminCompatJson(context.request),
      );
      if (!body.confirmed) throw confirmationRequired();
      const result = await service.deleteMemory(
        context.scope,
        readResourceId(
          context.params.memoryId,
          "memory",
        ),
        {
          operationId: body.operation_id,
          confirmed: body.confirmed,
        },
        context.signal,
      );
      if (!result) throw memoryNotFound();
      return result;
    } catch (error) {
      throw mapEvolutionError(error);
    }
  };
}

export function createListReflectionsHandler(
  service: AdminEvolutionService,
): AdminCompatHandler {
  return async (context) => {
    const url = new URL(context.request.url);
    const rawStatus = url.searchParams.get("status");
    const parsedStatus =
      rawStatus === null
        ? null
        : reflectionStatusSchema.safeParse(rawStatus);
    if (parsedStatus && !parsedStatus.success) {
      throw new AdminCompatError(
        400,
        "invalid_request",
        "invalid_reflection_status",
      );
    }
    return service.listReflections(
      context.scope,
      {
        ...(parsedStatus?.success
          ? { status: parsedStatus.data }
          : {}),
        limit: readLimit(url),
      },
      context.signal,
    );
  };
}

export function createReflectionActionHandler(
  service: AdminEvolutionService,
): AdminCompatHandler {
  return async (context) => {
    try {
      const action = reflectionActionSchema.safeParse(
        context.params.action,
      );
      if (!action.success) {
        throw new AdminCompatError(
          400,
          "invalid_request",
          "invalid_reflection_action",
        );
      }
      const body = reflectionActionMutationSchema.parse(
        await readAdminCompatJson(context.request),
      );
      if (!body.confirmed) throw confirmationRequired();
      if (
        action.data === "apply" &&
        body.suggestion_indexes.length === 0
      ) {
        throw new AdminCompatError(
          400,
          "invalid_request",
          "reflection_suggestion_required",
        );
      }
      const result = await service.actOnReflection(
        context.scope,
        readResourceId(
          context.params.reflectionId,
          "reflection",
        ),
        action.data,
        {
          expectedRevision: body.revision,
          operationId: body.operation_id,
          confirmed: body.confirmed,
          suggestionIndexes: body.suggestion_indexes,
        },
        context.signal,
      );
      if (!result) {
        throw new AdminCompatError(
          404,
          "not_found",
          "reflection_not_found",
        );
      }
      return result;
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

function readResourceId(
  value: string | undefined,
  resource: "memory" | "reflection",
): string {
  const result = z.string().uuid().safeParse(value);
  if (!result.success) {
    throw new AdminCompatError(
      400,
      "invalid_request",
      `invalid_${resource}_id`,
    );
  }
  return result.data;
}

function readLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null) return 100;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 500) {
    throw new AdminCompatError(
      400,
      "invalid_request",
      "invalid_limit",
    );
  }
  return value;
}

function confirmationRequired(): AdminCompatError {
  return new AdminCompatError(
    409,
    "confirmation_required",
    "confirmation_required",
  );
}

function memoryNotFound(): AdminCompatError {
  return new AdminCompatError(
    404,
    "not_found",
    "memory_not_found",
  );
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
