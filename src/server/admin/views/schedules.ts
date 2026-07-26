import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import type { AgentScope } from "@/server/agents/types";

export type AdminScheduleKind =
  | "reminder"
  | "follow_up"
  | "scheduled_digest"
  | "topic_subscription";

export type PersistentAuthorizationType =
  | "scheduled_digest"
  | "subscription"
  | "goal_contract";

export type HeartbeatAuthorization = Readonly<{
  type: PersistentAuthorizationType;
  sourceId: string;
}>;

export type HeartbeatConfigRecord = Readonly<{
  enabled: boolean;
  every: string;
  target: string;
  timeoutSeconds: number;
  activeHours: Readonly<{
    start: string;
    end: string;
  }> | null;
  revision: number;
  authorization: HeartbeatAuthorization | null;
}>;

export type AdminCronSchedule =
  | Readonly<{
      type: "cron";
      cron: string;
      timezone?: string;
    }>
  | Readonly<{
      type: "once";
      run_at: string;
      timezone?: string;
      repeat_every_days?: number;
      repeat_end_type?: "never" | "until" | "count";
      repeat_until?: string;
      repeat_count?: number;
    }>;

export type AdminCronSpec = Readonly<{
  id?: string;
  name: string;
  enabled?: boolean;
  save_result_to_inbox?: boolean;
  schedule: AdminCronSchedule;
  task_type?: "text" | "agent";
  text?: string;
  request?: Readonly<{
    input: unknown;
    session_id?: string | null;
    user_id?: string | null;
    [key: string]: unknown;
  }>;
  dispatch: Readonly<{
    type: "channel";
    channel?: string;
    target: Readonly<{
      user_id: string;
      session_id: string;
    }>;
    mode?: "stream" | "final";
    silent?: boolean;
    meta?: Record<string, unknown>;
  }>;
  runtime?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}>;

export type NormalizedAdminCronJob = Readonly<{
  id: string;
  name: string;
  enabled: boolean;
  kind: AdminScheduleKind;
  schedule: AdminCronSchedule;
  taskType: "text" | "agent";
  content: string;
  request: AdminCronSpec["request"] | null;
  dispatch: AdminCronSpec["dispatch"];
  runtime: Record<string, unknown>;
  meta: Record<string, unknown>;
  saveResultToInbox: boolean;
  networkEnabled: boolean;
  authorizationType: PersistentAuthorizationType | null;
  authorizationSourceId: string | null;
  nextRunAt: Date | null;
}>;

export type AdminSchedulesService = Readonly<{
  listJobs(
    scope: AgentScope,
    signal?: AbortSignal,
  ): Promise<unknown[]>;
  createJob(
    scope: AgentScope,
    spec: AdminCronSpec,
    signal?: AbortSignal,
  ): Promise<unknown>;
  getJob(
    scope: AgentScope,
    jobId: string,
    signal?: AbortSignal,
  ): Promise<unknown | null>;
  replaceJob(
    scope: AgentScope,
    jobId: string,
    spec: AdminCronSpec,
    signal?: AbortSignal,
  ): Promise<unknown | null>;
  deleteJob(
    scope: AgentScope,
    jobId: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
  setJobEnabled(
    scope: AgentScope,
    jobId: string,
    enabled: boolean,
    signal?: AbortSignal,
  ): Promise<boolean>;
  runJob(
    scope: AgentScope,
    jobId: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
  getJobState(
    scope: AgentScope,
    jobId: string,
    signal?: AbortSignal,
  ): Promise<unknown | null>;
  getJobHistory(
    scope: AgentScope,
    jobId: string,
    signal?: AbortSignal,
  ): Promise<unknown[] | null>;
  listDispatchTargets(
    scope: AgentScope,
    filters: Readonly<{
      channel?: string;
      userId?: string;
      sessionId?: string;
    }>,
    signal?: AbortSignal,
  ): Promise<unknown>;
  getHeartbeat(
    scope: AgentScope,
    signal?: AbortSignal,
  ): Promise<HeartbeatConfigRecord>;
  updateHeartbeat(
    scope: AgentScope,
    config: Omit<HeartbeatConfigRecord, "revision">,
    signal?: AbortSignal,
  ): Promise<HeartbeatConfigRecord>;
  runHeartbeat(
    scope: AgentScope,
    signal?: AbortSignal,
  ): Promise<unknown>;
}>;

export class AdminScheduleError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "AdminScheduleError";
    this.status = status;
    this.code = code;
  }
}

export function assertPersistentScheduleAuthorization(
  input: Readonly<{
    kind: AdminScheduleKind;
    enabled: boolean;
    networkEnabled: boolean;
    authorizationType: PersistentAuthorizationType | null;
    authorizationSourceId: string | null;
  }>,
): void {
  if (!input.enabled) return;
  const networkRequired =
    input.networkEnabled ||
    input.kind === "scheduled_digest" ||
    input.kind === "topic_subscription";
  if (!networkRequired) return;
  const expectedType =
    input.kind === "topic_subscription"
      ? "subscription"
      : input.kind === "scheduled_digest"
        ? "scheduled_digest"
        : null;
  if (
    input.authorizationType === null ||
    (
      expectedType !== null &&
      input.authorizationType !== expectedType
    ) ||
    !isCanonicalUuid(input.authorizationSourceId)
  ) {
    throw new AdminScheduleError(
      400,
      "persistent_authorization_required",
    );
  }
}

export function projectHeartbeatConfig(
  record: HeartbeatConfigRecord | null,
): HeartbeatConfigRecord {
  return record ?? {
    enabled: false,
    every: "6h",
    target: "inbox",
    timeoutSeconds: 300,
    activeHours: null,
    revision: 0,
    authorization: null,
  };
}

export function validateHeartbeatTrigger(
  input: Readonly<{
    enabled: boolean;
    target: string;
    authorization: HeartbeatAuthorization | null;
  }>,
): void {
  if (!input.enabled) return;
  if (
    input.authorization === null ||
    ![
      "scheduled_digest",
      "subscription",
      "goal_contract",
    ].includes(input.authorization.type) ||
    !isCanonicalUuid(input.authorization.sourceId)
  ) {
    throw new AdminScheduleError(
      400,
      "persistent_authorization_required",
    );
  }
}

export function normalizeAdminCronSpec(
  spec: AdminCronSpec,
  options: Readonly<{
    jobId: string;
    now?: Date;
  }>,
): NormalizedAdminCronJob {
  const taskType = spec.task_type ?? "text";
  const meta = spec.meta ?? {};
  const rawKind = meta.digitalmate_kind;
  const kind = normalizeScheduleKind(rawKind, taskType);
  const enabled = spec.enabled ?? false;
  const networkEnabled =
    meta.network_enabled === true || taskType === "agent";
  const authorizationType =
    isPersistentAuthorizationType(meta.authorization_type)
      ? meta.authorization_type
      : null;
  const authorizationSourceId =
    typeof meta.authorization_source_id === "string"
      ? meta.authorization_source_id
      : null;
  assertPersistentScheduleAuthorization({
    kind,
    enabled,
    networkEnabled,
    authorizationType,
    authorizationSourceId,
  });
  const content =
    taskType === "text"
      ? spec.text?.trim() ?? ""
      : extractAgentRequestText(spec.request?.input);
  if (!content) {
    throw new AdminScheduleError(400, "schedule_content_required");
  }
  return {
    id: options.jobId,
    name: spec.name.trim(),
    enabled,
    kind,
    schedule: normalizeSchedule(spec.schedule),
    taskType,
    content,
    request: spec.request ?? null,
    dispatch: spec.dispatch,
    runtime: spec.runtime ?? {},
    meta,
    saveResultToInbox: spec.save_result_to_inbox ?? true,
    networkEnabled,
    authorizationType,
    authorizationSourceId,
    nextRunAt: enabled
      ? computeNextScheduleTime(
          spec.schedule,
          options.now ?? new Date(),
        )
      : null,
  };
}

export function computeNextScheduleTime(
  schedule: AdminCronSchedule,
  after: Date,
): Date {
  if (schedule.type === "once") {
    const firstRun = parseZonedDateTime(
      schedule.run_at,
      schedule.timezone ?? "UTC",
    );
    if (firstRun.getTime() > after.getTime()) return firstRun;
    const repeatDays = schedule.repeat_every_days;
    if (
      !Number.isSafeInteger(repeatDays) ||
      repeatDays === undefined ||
      repeatDays < 1
    ) {
      throw new AdminScheduleError(400, "schedule_has_no_future_run");
    }
    const elapsedDays = Math.floor(
      (after.getTime() - firstRun.getTime()) / 86_400_000,
    );
    const repeatIndex =
      Math.floor(elapsedDays / repeatDays) + 1;
    if (
      schedule.repeat_end_type === "count" &&
      Number.isSafeInteger(schedule.repeat_count) &&
      repeatIndex >= Number(schedule.repeat_count)
    ) {
      throw new AdminScheduleError(400, "schedule_has_no_future_run");
    }
    const candidate = new Date(
      firstRun.getTime() +
        repeatIndex * repeatDays * 86_400_000,
    );
    if (
      schedule.repeat_end_type === "until" &&
      schedule.repeat_until
    ) {
      const until = parseZonedDateTime(
        schedule.repeat_until,
        schedule.timezone ?? "UTC",
      );
      if (candidate > until) {
        throw new AdminScheduleError(
          400,
          "schedule_has_no_future_run",
        );
      }
    }
    return candidate;
  }

  const fields = schedule.cron.trim().split(/\s+/u);
  if (fields.length !== 5) {
    throw new AdminScheduleError(400, "invalid_cron_expression");
  }
  const minute = parseCronField(fields[0]!, 0, 59);
  const hour = parseCronField(fields[1]!, 0, 23);
  const day = parseCronField(fields[2]!, 1, 31);
  const month = parseCronField(fields[3]!, 1, 12);
  const weekday = parseCronField(fields[4]!, 0, 7, true);
  const timezone = schedule.timezone ?? "UTC";
  let candidate = new Date(after);
  candidate.setUTCSeconds(0, 0);
  candidate = new Date(candidate.getTime() + 60_000);
  const maxMinutes = 370 * 24 * 60;
  for (let index = 0; index < maxMinutes; index += 1) {
    const parts = zonedDateParts(candidate, timezone);
    const normalizedWeekday =
      parts.weekday === 0 ? 7 : parts.weekday;
    const dayMatches = day.has(parts.day);
    const weekdayMatches =
      weekday.has(parts.weekday) ||
      weekday.has(normalizedWeekday);
    const bothRestricted =
      fields[2] !== "*" && fields[4] !== "*";
    const calendarDayMatches = bothRestricted
      ? dayMatches || weekdayMatches
      : dayMatches && weekdayMatches;
    if (
      minute.has(parts.minute) &&
      hour.has(parts.hour) &&
      month.has(parts.month) &&
      calendarDayMatches
    ) {
      return candidate;
    }
    candidate = new Date(candidate.getTime() + 60_000);
  }
  throw new AdminScheduleError(400, "schedule_has_no_future_run");
}

export function createPostgresAdminSchedulesService(
  pool: Pool,
): AdminSchedulesService {
  return {
    async listJobs(scope, signal) {
      signal?.throwIfAborted();
      const result = await pool.query(
        `SELECT *
         FROM scheduled_jobs
         WHERE user_id = $1 AND agent_id = $2
         ORDER BY created_at DESC, id DESC
         LIMIT 500`,
        [scope.userId, scope.agentId],
      );
      signal?.throwIfAborted();
      return result.rows.map((row) => projectCronJob(row));
    },

    async createJob(scope, spec, signal) {
      signal?.throwIfAborted();
      const requestedId =
        typeof spec.id === "string" && isCanonicalUuid(spec.id)
          ? spec.id
          : randomUUID();
      const normalized = normalizeAdminCronSpec(spec, {
        jobId: requestedId,
      });
      await assertJobReferences(
        pool,
        scope,
        normalized,
        signal,
      );
      const result = await pool.query(
        `INSERT INTO scheduled_jobs (
           id, user_id, agent_id, conversation_id, name, enabled,
           kind, schedule, task_type, content, request, dispatch,
           runtime, meta, save_result_to_inbox, network_enabled,
           authorization_type, authorization_source_id, status,
           next_run_at
         )
         SELECT $3, $1, $2, conversation.id, $4, $5, $6,
                $7::jsonb, $8, $9, $10::jsonb, $11::jsonb,
                $12::jsonb, $13::jsonb, $14, $15, $16, $17,
                $18, $19
         FROM conversations AS conversation
         WHERE conversation.user_id = $1
           AND conversation.agent_id = $2
           AND conversation.id = $20
         RETURNING *`,
        [
          scope.userId,
          scope.agentId,
          normalized.id,
          normalized.name,
          normalized.enabled,
          normalized.kind,
          JSON.stringify(normalized.schedule),
          normalized.taskType,
          normalized.content,
          JSON.stringify(normalized.request),
          JSON.stringify(normalized.dispatch),
          JSON.stringify(normalized.runtime),
          JSON.stringify(normalized.meta),
          normalized.saveResultToInbox,
          normalized.networkEnabled,
          normalized.authorizationType,
          normalized.authorizationSourceId,
          normalized.enabled ? "idle" : "paused",
          normalized.nextRunAt,
          normalized.dispatch.target.session_id,
        ],
      );
      const row = result.rows[0];
      if (!row) {
        throw new AdminScheduleError(
          404,
          "schedule_dispatch_target_not_found",
        );
      }
      return projectCronJob(row);
    },

    async getJob(scope, jobId, signal) {
      const row = await readJob(pool, scope, jobId, signal);
      return row ? projectCronJob(row, true) : null;
    },

    async replaceJob(scope, jobId, spec, signal) {
      signal?.throwIfAborted();
      const existing = await readJob(
        pool,
        scope,
        jobId,
        signal,
      );
      if (!existing) return null;
      const normalized = normalizeAdminCronSpec(spec, {
        jobId,
      });
      await assertJobReferences(
        pool,
        scope,
        normalized,
        signal,
      );
      const result = await pool.query(
        `UPDATE scheduled_jobs
         SET conversation_id = $4,
             name = $5,
             enabled = $6,
             kind = $7,
             schedule = $8::jsonb,
             task_type = $9,
             content = $10,
             request = $11::jsonb,
             dispatch = $12::jsonb,
             runtime = $13::jsonb,
             meta = $14::jsonb,
             save_result_to_inbox = $15,
             network_enabled = $16,
             authorization_type = $17,
             authorization_source_id = $18,
             status = $19,
             next_run_at = $20,
             revision = revision + 1,
             updated_at = now()
         WHERE user_id = $1 AND agent_id = $2 AND id = $3
         RETURNING *`,
        [
          scope.userId,
          scope.agentId,
          jobId,
          normalized.dispatch.target.session_id,
          normalized.name,
          normalized.enabled,
          normalized.kind,
          JSON.stringify(normalized.schedule),
          normalized.taskType,
          normalized.content,
          JSON.stringify(normalized.request),
          JSON.stringify(normalized.dispatch),
          JSON.stringify(normalized.runtime),
          JSON.stringify(normalized.meta),
          normalized.saveResultToInbox,
          normalized.networkEnabled,
          normalized.authorizationType,
          normalized.authorizationSourceId,
          normalized.enabled ? "idle" : "paused",
          normalized.nextRunAt,
        ],
      );
      return result.rows[0]
        ? projectCronJob(result.rows[0])
        : null;
    },

    async deleteJob(scope, jobId, signal) {
      signal?.throwIfAborted();
      const result = await pool.query(
        `DELETE FROM scheduled_jobs
         WHERE user_id = $1 AND agent_id = $2 AND id = $3`,
        [scope.userId, scope.agentId, jobId],
      );
      signal?.throwIfAborted();
      return (result.rowCount ?? 0) > 0;
    },

    async setJobEnabled(scope, jobId, enabled, signal) {
      signal?.throwIfAborted();
      const row = await readJob(pool, scope, jobId, signal);
      if (!row) return false;
      const normalized = normalizeStoredJob(row, enabled);
      await assertJobReferences(
        pool,
        scope,
        normalized,
        signal,
      );
      const result = await pool.query(
        `UPDATE scheduled_jobs
         SET enabled = $4,
             next_run_at = $5,
             status = $6,
             revision = revision + 1,
             updated_at = now()
         WHERE user_id = $1 AND agent_id = $2 AND id = $3`,
        [
          scope.userId,
          scope.agentId,
          jobId,
          enabled,
          normalized.nextRunAt,
          enabled ? "idle" : "paused",
        ],
      );
      signal?.throwIfAborted();
      return (result.rowCount ?? 0) > 0;
    },

    async runJob(scope, jobId, signal) {
      const row = await readJob(pool, scope, jobId, signal);
      if (!row) return false;
      await dispatchScheduledJob(
        pool,
        scope,
        row,
        "manual",
        signal,
      );
      return true;
    },

    async getJobState(scope, jobId, signal) {
      const row = await readJob(pool, scope, jobId, signal);
      if (!row) return null;
      return {
        enabled: Boolean(row.enabled),
        status: row.status,
        next_run_time: toEpochSeconds(row.next_run_at),
        last_run_time: toEpochSeconds(row.last_run_at),
        last_error_code:
          typeof row.last_error_code === "string"
            ? row.last_error_code
            : null,
        revision: Number(row.revision),
      };
    },

    async getJobHistory(scope, jobId, signal) {
      const exists = await readJob(pool, scope, jobId, signal);
      if (!exists) return null;
      const result = await pool.query(
        `SELECT run_at, status, error_code, trigger
         FROM scheduled_job_runs
         WHERE user_id = $1 AND agent_id = $2 AND job_id = $3
         ORDER BY run_at DESC
         LIMIT 200`,
        [scope.userId, scope.agentId, jobId],
      );
      signal?.throwIfAborted();
      return result.rows.map((row) => ({
        run_at: new Date(row.run_at as string | Date).toISOString(),
        status: row.status,
        error:
          typeof row.error_code === "string"
            ? row.error_code
            : null,
        trigger: row.trigger,
      }));
    },

    async listDispatchTargets(scope, filters, signal) {
      signal?.throwIfAborted();
      const result = await pool.query(
        `SELECT conversations.channel,
                conversations.id AS session_id
         FROM conversations
         WHERE conversations.user_id = $1
           AND conversations.agent_id = $2
           AND ($3::text IS NULL OR conversations.channel = $3)
           AND ($4::uuid IS NULL OR conversations.id = $4)
         ORDER BY conversations.updated_at DESC
         LIMIT 500`,
        [
          scope.userId,
          scope.agentId,
          filters.channel ?? null,
          filters.sessionId ?? null,
        ],
      );
      signal?.throwIfAborted();
      const items = result.rows.map((row) => ({
        channel: String(row.channel),
        user_id: scope.userId,
        session_id: String(row.session_id),
      }));
      return {
        channels: [...new Set(items.map((item) => item.channel))],
        items:
          filters.userId && filters.userId !== scope.userId
            ? []
            : items,
      };
    },

    async getHeartbeat(scope, signal) {
      signal?.throwIfAborted();
      const result = await pool.query(
        `SELECT heartbeat, revision
         FROM agent_settings
         WHERE user_id = $1 AND agent_id = $2`,
        [scope.userId, scope.agentId],
      );
      signal?.throwIfAborted();
      const row = result.rows[0];
      if (!row) return projectHeartbeatConfig(null);
      return heartbeatFromJson(
        row.heartbeat,
        Number(row.revision),
      );
    },

    async updateHeartbeat(scope, config, signal) {
      signal?.throwIfAborted();
      validateHeartbeatTrigger(config);
      await assertHeartbeatAuthorizationSource(
        pool,
        scope,
        config,
        signal,
      );
      const result = await pool.query(
        `UPDATE agent_settings
         SET heartbeat = $3::jsonb,
             revision = revision + 1,
             updated_at = now()
         WHERE user_id = $1 AND agent_id = $2
         RETURNING heartbeat, revision`,
        [
          scope.userId,
          scope.agentId,
          JSON.stringify(config),
        ],
      );
      const row = result.rows[0];
      if (!row) {
        throw new AdminScheduleError(404, "agent_not_found");
      }
      signal?.throwIfAborted();
      return heartbeatFromJson(
        row.heartbeat,
        Number(row.revision),
      );
    },

    async runHeartbeat(scope, signal) {
      const config = await this.getHeartbeat(scope, signal);
      validateHeartbeatTrigger(config);
      if (
        config.authorization?.type !== "goal_contract"
      ) {
        throw new AdminScheduleError(
          501,
          "heartbeat_runtime_not_available",
        );
      }
      const result = await pool.query(
        `UPDATE goals
         SET next_run_at = now(),
             updated_at = now(),
             revision = revision + 1
         WHERE user_id = $1
           AND agent_id = $2
           AND id = $3
           AND status IN ('confirmed', 'running')
           AND contract->'authorization'->>'type' = 'goal_contract'
           AND contract->'authorization'->>'sourceId' = id::text
           AND contract->'authorization'->>'networkEnabled' = 'true'
         RETURNING id`,
        [
          scope.userId,
          scope.agentId,
          config.authorization.sourceId,
        ],
      );
      if (!result.rows[0]) {
        throw new AdminScheduleError(
          409,
          "authorization_source_inactive",
        );
      }
      signal?.throwIfAborted();
      return {
        accepted: true,
        source_id: config.authorization.sourceId,
      };
    },
  };
}

export async function processDueScheduledJobs(input: Readonly<{
  pool: Pool;
  scope: AgentScope;
  now?: Date;
  signal?: AbortSignal;
}>): Promise<Readonly<{ dispatched: number; failed: number }>> {
  input.signal?.throwIfAborted();
  const now = input.now ?? new Date();
  const result = await input.pool.query(
    `SELECT *
     FROM scheduled_jobs
     WHERE user_id = $1
       AND agent_id = $2
       AND enabled = true
       AND next_run_at <= $3
     ORDER BY next_run_at ASC
     LIMIT 20`,
    [input.scope.userId, input.scope.agentId, now],
  );
  let dispatched = 0;
  let failed = 0;
  for (const row of result.rows) {
    input.signal?.throwIfAborted();
    try {
      const created = await dispatchScheduledJob(
        input.pool,
        input.scope,
        row,
        "scheduled",
        input.signal,
        new Date(row.next_run_at as string | Date),
      );
      if (created) dispatched += 1;
    } catch (error) {
      input.signal?.throwIfAborted();
      failed += 1;
      const errorCode =
        error instanceof AdminScheduleError
          ? error.code
          : "scheduled_job_dispatch_failed";
      await input.pool.query(
        `UPDATE scheduled_jobs
         SET enabled = false,
             status = 'error',
             last_error_code = $4,
             updated_at = now()
         WHERE user_id = $1 AND agent_id = $2 AND id = $3`,
        [
          input.scope.userId,
          input.scope.agentId,
          row.id,
          errorCode,
        ],
      );
    }
  }
  return { dispatched, failed };
}

function isCanonicalUuid(value: string | null): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value,
    )
  );
}

type ScheduledJobRow = Record<string, unknown>;

function projectCronJob(
  row: ScheduledJobRow,
  includeState = false,
) {
  const projected = {
    id: String(row.id),
    name: String(row.name),
    enabled: Boolean(row.enabled),
    save_result_to_inbox: Boolean(row.save_result_to_inbox),
    schedule: asJsonObject(row.schedule),
    task_type: row.task_type,
    ...(row.task_type === "text"
      ? { text: String(row.content ?? "") }
      : { request: asJsonObject(row.request) }),
    dispatch: asJsonObject(row.dispatch),
    runtime: asJsonObject(row.runtime),
    meta: {
      ...asJsonObject(row.meta),
      digitalmate_kind: row.kind,
      network_enabled: Boolean(row.network_enabled),
      authorization_type: row.authorization_type ?? null,
      authorization_source_id:
        row.authorization_source_id ?? null,
      revision: Number(row.revision),
    },
    next_run_time: toEpochSeconds(row.next_run_at),
    last_run_time: toEpochSeconds(row.last_run_at),
  };
  return includeState
    ? {
        ...projected,
        state: {
          status: row.status,
          last_error_code: row.last_error_code ?? null,
        },
      }
    : projected;
}

async function readJob(
  pool: Pool,
  scope: AgentScope,
  jobId: string,
  signal?: AbortSignal,
): Promise<ScheduledJobRow | null> {
  signal?.throwIfAborted();
  if (!isCanonicalUuid(jobId)) {
    throw new AdminScheduleError(400, "invalid_job_id");
  }
  const result = await pool.query(
    `SELECT *
     FROM scheduled_jobs
     WHERE user_id = $1 AND agent_id = $2 AND id = $3`,
    [scope.userId, scope.agentId, jobId],
  );
  signal?.throwIfAborted();
  return result.rows[0] ?? null;
}

function normalizeStoredJob(
  row: ScheduledJobRow,
  enabled: boolean,
): NormalizedAdminCronJob {
  const normalized = normalizeAdminCronSpec(
    {
      id: String(row.id),
      name: String(row.name),
      enabled: false,
      save_result_to_inbox: Boolean(row.save_result_to_inbox),
      schedule: asJsonObject(row.schedule) as AdminCronSchedule,
      task_type: row.task_type as "text" | "agent",
      ...(row.task_type === "text"
        ? { text: String(row.content ?? "") }
        : {
            request: asJsonObject(
              row.request,
            ) as AdminCronSpec["request"],
          }),
      dispatch: asJsonObject(
        row.dispatch,
      ) as AdminCronSpec["dispatch"],
      runtime: asJsonObject(row.runtime),
      meta: {
        ...asJsonObject(row.meta),
        digitalmate_kind: row.kind,
        network_enabled: Boolean(row.network_enabled),
        authorization_type: row.authorization_type,
        authorization_source_id: row.authorization_source_id,
      },
    },
    { jobId: String(row.id) },
  );
  if (!enabled) return normalized;
  assertPersistentScheduleAuthorization({
    kind: normalized.kind,
    enabled: true,
    networkEnabled: normalized.networkEnabled,
    authorizationType: normalized.authorizationType,
    authorizationSourceId: normalized.authorizationSourceId,
  });
  return {
    ...normalized,
    enabled: true,
    nextRunAt: computeNextScheduleTime(
      normalized.schedule,
      new Date(),
    ),
  };
}

async function assertJobReferences(
  pool: Pool,
  scope: AgentScope,
  job: NormalizedAdminCronJob,
  signal?: AbortSignal,
): Promise<void> {
  if (job.dispatch.target.user_id !== scope.userId) {
    throw new AdminScheduleError(
      404,
      "schedule_dispatch_target_not_found",
    );
  }
  const target = await pool.query(
    `SELECT 1
     FROM conversations
     WHERE user_id = $1 AND agent_id = $2 AND id = $3`,
    [
      scope.userId,
      scope.agentId,
      job.dispatch.target.session_id,
    ],
  );
  signal?.throwIfAborted();
  if (!target.rows[0]) {
    throw new AdminScheduleError(
      404,
      "schedule_dispatch_target_not_found",
    );
  }
  if (!job.enabled || !job.networkEnabled) return;
  if (
    job.authorizationType === "goal_contract" &&
    job.authorizationSourceId
  ) {
    const source = await pool.query(
      `SELECT 1
       FROM goals
       WHERE user_id = $1
         AND agent_id = $2
         AND id = $3
         AND status IN (
           'confirmed', 'running', 'paused', 'needs_human'
         )
         AND contract->'authorization'->>'type' = 'goal_contract'
         AND contract->'authorization'->>'sourceId' = id::text
         AND contract->'authorization'->>'networkEnabled' = 'true'`,
      [
        scope.userId,
        scope.agentId,
        job.authorizationSourceId,
      ],
    );
    signal?.throwIfAborted();
    if (source.rows[0]) return;
    throw new AdminScheduleError(
      409,
      "authorization_source_inactive",
    );
  }
  if (
    job.authorizationType === "scheduled_digest" &&
    job.authorizationSourceId === job.id
  ) {
    throw new AdminScheduleError(
      501,
      "scheduled_digest_runtime_frozen",
    );
  }
  throw new AdminScheduleError(
    409,
    "authorization_source_inactive",
  );
}

async function dispatchScheduledJob(
  pool: Pool,
  scope: AgentScope,
  row: ScheduledJobRow,
  trigger: "manual" | "scheduled",
  signal?: AbortSignal,
  scheduledFor?: Date,
): Promise<boolean> {
  const normalized = normalizeStoredJobForDispatch(row);
  await assertJobReferences(
    pool,
    scope,
    normalized,
    signal,
  );
  signal?.throwIfAborted();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const run = await client.query(
      trigger === "scheduled"
        ? `INSERT INTO scheduled_job_runs (
             user_id, agent_id, job_id, scheduled_for,
             run_at, status, trigger
           )
           VALUES ($1, $2, $3, $4, now(), 'running', $5)
           ON CONFLICT (job_id, scheduled_for)
             WHERE trigger = 'scheduled'
               AND scheduled_for IS NOT NULL
           DO NOTHING
           RETURNING id`
        : `INSERT INTO scheduled_job_runs (
             user_id, agent_id, job_id, scheduled_for,
             run_at, status, trigger
           )
           VALUES ($1, $2, $3, NULL, now(), 'running', $5)
           RETURNING id`,
      [
        scope.userId,
        scope.agentId,
        normalized.id,
        scheduledFor ?? null,
        trigger,
      ],
    );
    const runId = run.rows[0]?.id;
    if (!runId) {
      await client.query("ROLLBACK");
      return false;
    }
    if (
      normalized.taskType === "agent" &&
      normalized.authorizationType === "goal_contract" &&
      normalized.authorizationSourceId
    ) {
      const wake = await client.query(
        `UPDATE goals
         SET next_run_at = now(),
             updated_at = now(),
             revision = revision + 1
         WHERE user_id = $1
           AND agent_id = $2
           AND id = $3
           AND status IN ('confirmed', 'running')
         RETURNING id`,
        [
          scope.userId,
          scope.agentId,
          normalized.authorizationSourceId,
        ],
      );
      if (!wake.rows[0]) {
        throw new AdminScheduleError(
          409,
          "authorization_source_inactive",
        );
      }
      await client.query(
        `UPDATE scheduled_job_runs
         SET status = 'success', completed_at = now()
         WHERE id = $1`,
        [runId],
      );
    } else {
      const task = await client.query(
        `INSERT INTO proactive_tasks (
           user_id, agent_id, conversation_id, kind, content,
           scheduled_at, metadata
         )
         VALUES ($1, $2, $3, $4, $5, now(), $6::jsonb)
         RETURNING id`,
        [
          scope.userId,
          scope.agentId,
          normalized.dispatch.target.session_id,
          normalized.kind,
          normalized.content,
          JSON.stringify({
            scheduledJobId: normalized.id,
            scheduledJobRunId: runId,
            trigger,
          }),
        ],
      );
      await client.query(
        `UPDATE scheduled_job_runs
         SET proactive_task_id = $2
         WHERE id = $1`,
        [runId, task.rows[0]?.id],
      );
    }
    const nextState =
      trigger === "scheduled" && scheduledFor
        ? nextScheduledState(
            normalized.schedule,
            scheduledFor,
          )
        : null;
    await client.query(
      `UPDATE scheduled_jobs
       SET last_run_at = now(),
           enabled = CASE
             WHEN $4::boolean IS NULL THEN enabled
             ELSE $4
           END,
           next_run_at = CASE
             WHEN $4::boolean IS NULL THEN next_run_at
             ELSE $5
           END,
           status = $6,
           last_error_code = NULL,
           updated_at = now()
       WHERE user_id = $1 AND agent_id = $2 AND id = $3`,
      [
        scope.userId,
        scope.agentId,
        normalized.id,
        nextState?.enabled ?? null,
        nextState?.nextRunAt ?? null,
        normalized.taskType === "agent"
          ? "success"
          : "running",
      ],
    );
    signal?.throwIfAborted();
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function normalizeStoredJobForDispatch(
  row: ScheduledJobRow,
): NormalizedAdminCronJob {
  const normalized = normalizeStoredJob(row, false);
  assertPersistentScheduleAuthorization({
    kind: normalized.kind,
    enabled: true,
    networkEnabled: normalized.networkEnabled,
    authorizationType: normalized.authorizationType,
    authorizationSourceId: normalized.authorizationSourceId,
  });
  return {
    ...normalized,
    enabled: true,
    nextRunAt: null,
  };
}

function nextScheduledState(
  schedule: AdminCronSchedule,
  scheduledFor: Date,
): Readonly<{
  enabled: boolean;
  nextRunAt: Date | null;
}> {
  try {
    return {
      enabled: true,
      nextRunAt: computeNextScheduleTime(
        schedule,
        scheduledFor,
      ),
    };
  } catch (error) {
    if (
      error instanceof AdminScheduleError &&
      error.code === "schedule_has_no_future_run"
    ) {
      return { enabled: false, nextRunAt: null };
    }
    throw error;
  }
}

async function assertHeartbeatAuthorizationSource(
  pool: Pool,
  scope: AgentScope,
  config: Omit<HeartbeatConfigRecord, "revision">,
  signal?: AbortSignal,
): Promise<void> {
  if (!config.enabled) return;
  if (config.authorization?.type !== "goal_contract") {
    throw new AdminScheduleError(
      501,
      "heartbeat_runtime_not_available",
    );
  }
  const result = await pool.query(
    `SELECT 1
     FROM goals
     WHERE user_id = $1
       AND agent_id = $2
       AND id = $3
       AND status IN ('confirmed', 'running', 'paused', 'needs_human')
       AND contract->'authorization'->>'type' = 'goal_contract'
       AND contract->'authorization'->>'sourceId' = id::text
       AND contract->'authorization'->>'networkEnabled' = 'true'`,
    [
      scope.userId,
      scope.agentId,
      config.authorization.sourceId,
    ],
  );
  signal?.throwIfAborted();
  if (!result.rows[0]) {
    throw new AdminScheduleError(
      409,
      "authorization_source_inactive",
    );
  }
}

function heartbeatFromJson(
  value: unknown,
  revision: number,
): HeartbeatConfigRecord {
  const record = asJsonObject(value);
  const activeHours = asJsonObject(record.activeHours);
  const authorization = asJsonObject(record.authorization);
  return projectHeartbeatConfig({
    enabled: record.enabled === true,
    every:
      typeof record.every === "string"
        ? record.every
        : "6h",
    target:
      typeof record.target === "string"
        ? record.target
        : "inbox",
    timeoutSeconds:
      typeof record.timeoutSeconds === "number"
        ? record.timeoutSeconds
        : 300,
    activeHours:
      typeof activeHours.start === "string" &&
      typeof activeHours.end === "string"
        ? {
            start: activeHours.start,
            end: activeHours.end,
          }
        : null,
    revision,
    authorization:
      isPersistentAuthorizationType(authorization.type) &&
      typeof authorization.sourceId === "string"
        ? {
            type: authorization.type,
            sourceId: authorization.sourceId,
          }
        : null,
  });
}

function asJsonObject(
  value: unknown,
): Record<string, unknown> {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toEpochSeconds(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const time = new Date(value as string | Date).getTime();
  return Number.isFinite(time)
    ? Math.floor(time / 1_000)
    : undefined;
}

function normalizeScheduleKind(
  value: unknown,
  taskType: "text" | "agent",
): AdminScheduleKind {
  if (
    value === "reminder" ||
    value === "follow_up" ||
    value === "scheduled_digest" ||
    value === "topic_subscription"
  ) {
    return value;
  }
  return taskType === "text" ? "reminder" : "scheduled_digest";
}

function isPersistentAuthorizationType(
  value: unknown,
): value is PersistentAuthorizationType {
  return (
    value === "scheduled_digest" ||
    value === "subscription" ||
    value === "goal_contract"
  );
}

function extractAgentRequestText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((message) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("content" in message) ||
        !Array.isArray(message.content)
      ) {
        return [];
      }
      return message.content
        .map((part: unknown) => {
          if (
            typeof part === "object" &&
            part !== null &&
            "text" in part &&
            typeof part.text === "string"
          ) {
            return part.text;
          }
          return "";
        })
        .filter(Boolean);
    })
    .join("\n")
    .trim();
}

function normalizeSchedule(
  schedule: AdminCronSchedule,
): AdminCronSchedule {
  if (schedule.type === "cron") {
    return {
      type: "cron",
      cron: schedule.cron.trim(),
      ...(schedule.timezone
        ? { timezone: schedule.timezone }
        : {}),
    };
  }
  return {
    type: "once",
    run_at: schedule.run_at,
    ...(schedule.timezone
      ? { timezone: schedule.timezone }
      : {}),
    ...(schedule.repeat_every_days !== undefined
      ? { repeat_every_days: schedule.repeat_every_days }
      : {}),
    ...(schedule.repeat_end_type
      ? { repeat_end_type: schedule.repeat_end_type }
      : {}),
    ...(schedule.repeat_until
      ? { repeat_until: schedule.repeat_until }
      : {}),
    ...(schedule.repeat_count !== undefined
      ? { repeat_count: schedule.repeat_count }
      : {}),
  };
}

function parseCronField(
  value: string,
  minimum: number,
  maximum: number,
  allowSundaySeven = false,
): Set<number> {
  const values = new Set<number>();
  for (const segment of value.split(",")) {
    const [rangePart, stepPart] = segment.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isSafeInteger(step) || step < 1) {
      throw new AdminScheduleError(400, "invalid_cron_expression");
    }
    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = minimum;
      end = maximum;
    } else if (rangePart?.includes("-")) {
      const [rawStart, rawEnd] = rangePart.split("-");
      start = Number(rawStart);
      end = Number(rawEnd);
    } else {
      start = Number(rangePart);
      end = start;
    }
    const allowedMaximum =
      allowSundaySeven ? Math.max(maximum, 7) : maximum;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < minimum ||
      end > allowedMaximum ||
      start > end
    ) {
      throw new AdminScheduleError(400, "invalid_cron_expression");
    }
    for (let current = start; current <= end; current += step) {
      values.add(current);
    }
  }
  if (values.size === 0) {
    throw new AdminScheduleError(400, "invalid_cron_expression");
  }
  return values;
}

function parseZonedDateTime(
  value: string,
  timezone: string,
): Date {
  if (/[zZ]|[+-]\d{2}:\d{2}$/u.test(value)) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new AdminScheduleError(400, "invalid_run_at");
    }
    return parsed;
  }
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(
      value,
    );
  if (!match) {
    throw new AdminScheduleError(400, "invalid_run_at");
  }
  const desiredUtc = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] ?? 0),
  );
  let candidate = new Date(desiredUtc);
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const parts = zonedDateParts(candidate, timezone);
    const representedUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    candidate = new Date(
      candidate.getTime() + desiredUtc - representedUtc,
    );
  }
  if (Number.isNaN(candidate.getTime())) {
    throw new AdminScheduleError(400, "invalid_run_at");
  }
  return candidate;
}

function zonedDateParts(
  value: Date,
  timezone: string,
): Readonly<{
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}> {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    });
  } catch {
    throw new AdminScheduleError(400, "invalid_timezone");
  }
  const parts = Object.fromEntries(
    formatter
      .formatToParts(value)
      .map((part) => [part.type, part.value]),
  );
  const weekday = [
    "Sun",
    "Mon",
    "Tue",
    "Wed",
    "Thu",
    "Fri",
    "Sat",
  ].indexOf(parts.weekday ?? "");
  if (weekday < 0) {
    throw new AdminScheduleError(400, "invalid_timezone");
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday,
  };
}
