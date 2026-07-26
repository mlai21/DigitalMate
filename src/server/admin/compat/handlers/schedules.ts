import { z } from "zod";
import { readAdminCompatJson } from "@/server/admin/compat/json";
import {
  AdminCompatError,
  type AdminCompatHandler,
} from "@/server/admin/compat/types";
import {
  AdminScheduleError,
  type AdminCronSpec,
  type AdminSchedulesService,
} from "@/server/admin/views/schedules";

export type { AdminSchedulesService } from "@/server/admin/views/schedules";

const cronScheduleSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("cron"),
      cron: z.string().trim().min(1).max(200),
      timezone: z.string().trim().min(1).max(100).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("once"),
      run_at: z.string().trim().min(1).max(100),
      timezone: z.string().trim().min(1).max(100).optional(),
      repeat_every_days: z.number().int().min(1).max(3_650).optional(),
      repeat_end_type: z
        .enum(["never", "until", "count"])
        .optional(),
      repeat_until: z.string().trim().min(1).max(100).optional(),
      repeat_count: z.number().int().min(1).max(10_000).optional(),
    })
    .strict(),
]);

const cronSpecSchema = z
  .object({
    id: z.string().max(200).optional(),
    name: z.string().trim().min(1).max(500),
    enabled: z.boolean().optional(),
    save_result_to_inbox: z.boolean().optional(),
    schedule: cronScheduleSchema,
    task_type: z.enum(["text", "agent"]).optional(),
    text: z.string().max(100_000).optional(),
    request: z
      .object({
        input: z.unknown(),
        session_id: z.string().max(500).nullable().optional(),
        user_id: z.string().max(500).nullable().optional(),
      })
      .catchall(z.unknown())
      .optional(),
    dispatch: z
      .object({
        type: z.literal("channel"),
        channel: z.string().trim().min(1).max(100).optional(),
        target: z
          .object({
            user_id: z.string().trim().min(1).max(500),
            session_id: z.string().trim().min(1).max(500),
          })
          .strict(),
        mode: z.enum(["stream", "final"]).optional(),
        silent: z.boolean().optional(),
        meta: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
    runtime: z.record(z.string(), z.unknown()).optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const heartbeatAuthorizationSchema = z
  .object({
    type: z.enum([
      "scheduled_digest",
      "subscription",
      "goal_contract",
    ]),
    sourceId: z.string().uuid(),
  })
  .strict();
const heartbeatSchema = z
  .object({
    enabled: z.boolean(),
    every: z
      .string()
      .regex(/^\d+[mhd]$/u)
      .max(20),
    target: z.string().trim().min(1).max(100),
    timeoutSeconds: z.number().int().min(1).max(3_600),
    activeHours: z
      .object({
        start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
        end: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
      })
      .strict()
      .nullable()
      .optional(),
    authorization: heartbeatAuthorizationSchema
      .nullable()
      .optional(),
  })
  .strict();

export function createListCronJobsHandler(
  service: AdminSchedulesService,
): AdminCompatHandler {
  return async (context) =>
    service.listJobs(context.scope, context.signal);
}

export function createCreateCronJobHandler(
  service: AdminSchedulesService,
): AdminCompatHandler {
  return async (context) => {
    try {
      const spec = cronSpecSchema.parse(
        await readAdminCompatJson(context.request),
      ) as AdminCronSpec;
      return await service.createJob(
        context.scope,
        spec,
        context.signal,
      );
    } catch (error) {
      throw mapScheduleError(error);
    }
  };
}

export function createGetCronJobHandler(
  service: AdminSchedulesService,
): AdminCompatHandler {
  return async (context) => {
    try {
      const job = await service.getJob(
        context.scope,
        readJobId(context.params.jobId),
        context.signal,
      );
      if (!job) throw jobNotFound();
      return job;
    } catch (error) {
      throw mapScheduleError(error);
    }
  };
}

export function createReplaceCronJobHandler(
  service: AdminSchedulesService,
): AdminCompatHandler {
  return async (context) => {
    try {
      const jobId = readJobId(context.params.jobId);
      const spec = cronSpecSchema.parse(
        await readAdminCompatJson(context.request),
      ) as AdminCronSpec;
      const job = await service.replaceJob(
        context.scope,
        jobId,
        spec,
        context.signal,
      );
      if (!job) throw jobNotFound();
      return job;
    } catch (error) {
      throw mapScheduleError(error);
    }
  };
}

export function createDeleteCronJobHandler(
  service: AdminSchedulesService,
): AdminCompatHandler {
  return async (context) => {
    try {
      const jobId = readJobId(context.params.jobId);
      const deleted = await service.deleteJob(
        context.scope,
        jobId,
        context.signal,
      );
      if (!deleted) throw jobNotFound();
      return { success: true };
    } catch (error) {
      throw mapScheduleError(error);
    }
  };
}

export function createSetCronJobEnabledHandler(
  service: AdminSchedulesService,
  enabled: boolean,
): AdminCompatHandler {
  return async (context) => {
    try {
      const updated = await service.setJobEnabled(
        context.scope,
        readJobId(context.params.jobId),
        enabled,
        context.signal,
      );
      if (!updated) throw jobNotFound();
      return { success: true };
    } catch (error) {
      throw mapScheduleError(error);
    }
  };
}

export function createRunCronJobHandler(
  service: AdminSchedulesService,
): AdminCompatHandler {
  return async (context) => {
    try {
      const accepted = await service.runJob(
        context.scope,
        readJobId(context.params.jobId),
        context.signal,
      );
      if (!accepted) throw jobNotFound();
      return { accepted: true };
    } catch (error) {
      throw mapScheduleError(error);
    }
  };
}

export function createGetCronJobStateHandler(
  service: AdminSchedulesService,
): AdminCompatHandler {
  return async (context) => {
    try {
      const state = await service.getJobState(
        context.scope,
        readJobId(context.params.jobId),
        context.signal,
      );
      if (!state) throw jobNotFound();
      return state;
    } catch (error) {
      throw mapScheduleError(error);
    }
  };
}

export function createGetCronJobHistoryHandler(
  service: AdminSchedulesService,
): AdminCompatHandler {
  return async (context) => {
    try {
      const history = await service.getJobHistory(
        context.scope,
        readJobId(context.params.jobId),
        context.signal,
      );
      if (!history) throw jobNotFound();
      return history;
    } catch (error) {
      throw mapScheduleError(error);
    }
  };
}

export function createListCronDispatchTargetsHandler(
  service: AdminSchedulesService,
): AdminCompatHandler {
  return async (context) => {
    const url = new URL(context.request.url);
    return service.listDispatchTargets(
      context.scope,
      {
        ...(url.searchParams.get("channel")
          ? { channel: url.searchParams.get("channel")! }
          : {}),
        ...(url.searchParams.get("user_id")
          ? { userId: url.searchParams.get("user_id")! }
          : {}),
        ...(url.searchParams.get("session_id")
          ? { sessionId: url.searchParams.get("session_id")! }
          : {}),
      },
      context.signal,
    );
  };
}

export function createGetHeartbeatHandler(
  service: AdminSchedulesService,
): AdminCompatHandler {
  return async (context) =>
    service.getHeartbeat(context.scope, context.signal);
}

export function createUpdateHeartbeatHandler(
  service: AdminSchedulesService,
): AdminCompatHandler {
  return async (context) => {
    try {
      const body = heartbeatSchema.parse(
        await readAdminCompatJson(context.request),
      );
      const current = await service.getHeartbeat(
        context.scope,
        context.signal,
      );
      return await service.updateHeartbeat(
        context.scope,
        {
          enabled: body.enabled,
          every: body.every,
          target: body.target,
          timeoutSeconds: body.timeoutSeconds,
          activeHours: body.activeHours ?? null,
          authorization:
            body.authorization === undefined
              ? current.authorization
              : body.authorization,
        },
        context.signal,
      );
    } catch (error) {
      throw mapScheduleError(error);
    }
  };
}

export function createRunHeartbeatHandler(
  service: AdminSchedulesService,
): AdminCompatHandler {
  return async (context) => {
    try {
      return await service.runHeartbeat(
        context.scope,
        context.signal,
      );
    } catch (error) {
      throw mapScheduleError(error);
    }
  };
}

function readJobId(value: string | undefined): string {
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) {
    throw new AdminCompatError(
      400,
      "invalid_request",
      "invalid_job_id",
    );
  }
  return parsed.data;
}

function jobNotFound(): AdminCompatError {
  return new AdminCompatError(
    404,
    "not_found",
    "cron_job_not_found",
  );
}

function mapScheduleError(error: unknown): unknown {
  if (error instanceof AdminScheduleError) {
    return new AdminCompatError(
      error.status,
      error.code,
      error.code,
    );
  }
  return error;
}
