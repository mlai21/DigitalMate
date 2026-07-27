import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import type { AgentScope } from "@/server/agents/types";
import {
  defaultSettings,
  type CadenceSettings,
  type PersonaSettings,
  type ProactivitySettings,
  type SearchSettings,
} from "@/server/settings/defaults";
import {
  connectPoolClient,
  guardPoolClientWithAbort,
  type AbortablePoolClientGuard,
} from "@/server/db/abortable-client";

export type AdminAgentProfileUpdate = Readonly<{
  scope: AgentScope;
  operationId: string;
  expectedRevision: number;
  displayName: string;
  persona: PersonaSettings;
  settings: Readonly<{
    proactivity: ProactivitySettings;
    cadence: CadenceSettings;
    search: SearchSettings;
  }>;
}>;

export type AdminAgentProfileUpdateResult = Readonly<{
  revision: number;
}>;

export type AdminAgentProfileSnapshot = Readonly<{
  id: string;
  displayName: string;
  persona: PersonaSettings;
  proactivity: ProactivitySettings;
  cadence: CadenceSettings;
  search: SearchSettings;
  revision: number;
}>;

export type AdminAgentProfileServiceOptions = Readonly<{
  lifecycleTimeoutMs?: number;
}>;

type LockedProfile = {
  display_name: string;
  digital_persona: Record<string, unknown>;
  settings_persona: Record<string, unknown>;
  proactivity: Record<string, unknown>;
  cadence: Record<string, unknown>;
  search: Record<string, unknown>;
  model_routing_override: Record<string, unknown>;
  revision: number;
};

type ProfileSnapshotRow = {
  id: string;
  display_name: string;
  persona: unknown;
  proactivity: unknown;
  cadence: unknown;
  search: unknown;
  revision: number;
};

export class AdminAgentProfileError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "AdminAgentProfileError";
    this.status = status;
    this.code = code;
  }
}

const MAX_LIFECYCLE_TIMEOUT_MS = 30_000;
const DEFAULT_LIFECYCLE_TIMEOUT_MS = 30_000;
const COMMIT_RECOVERY_TIMEOUT_MS = 3_000;
const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function createAdminAgentProfileService(
  pool: Pool,
  options: AdminAgentProfileServiceOptions = {},
) {
  const lifecycleTimeoutMs = normalizeLifecycleTimeout(
    options.lifecycleTimeoutMs,
  );
  return {
    async read(
      scope: AgentScope,
      outerSignal?: AbortSignal,
    ): Promise<AdminAgentProfileSnapshot> {
      const lifecycle = createBoundedLifecycle(
        lifecycleTimeoutMs,
        outerSignal,
      );
      let client: PoolClient | undefined;
      let guard: AbortablePoolClientGuard | undefined;
      try {
        lifecycle.signal.throwIfAborted();
        client = await connectPoolClient(pool, lifecycle.signal);
        guard = guardPoolClientWithAbort(client, lifecycle.signal);
        lifecycle.signal.throwIfAborted();
        await client.query("BEGIN");
        await setTransactionTimeouts(client, lifecycleTimeoutMs);
        await ensureDefaultProfileSettings(client, scope);
        lifecycle.signal.throwIfAborted();
        const snapshot = await readDefaultProfileSnapshot(
          client,
          scope,
        );
        if (!snapshot) {
          throw new AdminAgentProfileError(404, "agent_not_found");
        }
        lifecycle.signal.throwIfAborted();
        await client.query("COMMIT");
        return snapshot;
      } catch (error) {
        if (client && guard?.destroyed !== true) {
          await client.query("ROLLBACK").catch(() => undefined);
        }
        if (
          lifecycle.signal.aborted ||
          isPostgresTimeoutError(error)
        ) {
          throw new AdminAgentProfileError(
            500,
            "agent_profile_read_failed",
          );
        }
        throw error;
      } finally {
        lifecycle.dispose();
        guard?.dispose();
        if (client && guard?.destroyed !== true) {
          client.release();
        }
      }
    },

    async update(
      input: AdminAgentProfileUpdate,
      outerSignal?: AbortSignal,
    ): Promise<AdminAgentProfileUpdateResult> {
      validateOperationId(input.operationId);
      const inputFingerprint = profileUpdateFingerprint(input);
      const lifecycle = createBoundedLifecycle(
        lifecycleTimeoutMs,
        outerSignal,
      );
      let client: PoolClient | undefined;
      let guard: AbortablePoolClientGuard | undefined;
      let commitOutcomeUnknown = false;
      try {
        lifecycle.signal.throwIfAborted();
        client = await connectPoolClient(pool, lifecycle.signal);
        guard = guardPoolClientWithAbort(client, lifecycle.signal);
        lifecycle.signal.throwIfAborted();
        await client.query("BEGIN");
        await setTransactionTimeouts(
          client,
          lifecycleTimeoutMs,
        );
        const before = await lockDefaultProfile(client, input.scope);
        if (!before) {
          throw new AdminAgentProfileError(404, "agent_not_found");
        }
        const replay = await recoverProfileUpdateInTransaction(
          client,
          input,
          before,
          inputFingerprint,
        );
        if (replay !== null) {
          lifecycle.signal.throwIfAborted();
          await client.query("COMMIT");
          return { revision: replay };
        }
        if (before.revision !== input.expectedRevision) {
          throw new AdminAgentProfileError(409, "revision_conflict");
        }
        lifecycle.signal.throwIfAborted();
        await client.query(
          `UPDATE digital_agents
           SET display_name = $3,
               persona = $4,
               updated_at = now()
           WHERE user_id = $1
             AND id = $2
             AND status = 'active'`,
          [
            input.scope.userId,
            input.scope.agentId,
            input.displayName,
            input.persona,
          ],
        );
        const updated = await client.query<{ revision: number }>(
          `UPDATE agent_settings
           SET persona = $3,
               proactivity = $4,
               cadence = $5,
               search = $6,
               revision = revision + 1,
               updated_at = now()
           WHERE user_id = $1
             AND agent_id = $2
             AND revision = $7
           RETURNING revision`,
          [
            input.scope.userId,
            input.scope.agentId,
            input.persona,
            input.settings.proactivity,
            input.settings.cadence,
            input.settings.search,
            input.expectedRevision,
          ],
        );
        const revision = Number(updated.rows[0]?.revision);
        if (!Number.isSafeInteger(revision)) {
          throw new AdminAgentProfileError(409, "revision_conflict");
        }
        await insertSafeAudit(
          client,
          input,
          before,
          revision,
          inputFingerprint,
        );
        lifecycle.signal.throwIfAborted();
        try {
          await client.query("COMMIT");
          return { revision };
        } catch {
          commitOutcomeUnknown = true;
          guard.destroy();
          const recoveredRevision =
            await recoverCommittedProfileUpdate(
              pool,
              input,
              inputFingerprint,
            );
          if (recoveredRevision !== null) {
            return { revision: recoveredRevision };
          }
          throw new AdminAgentProfileError(
            500,
            "agent_profile_update_failed",
          );
        }
      } catch (error) {
        if (
          !commitOutcomeUnknown &&
          client &&
          guard?.destroyed !== true
        ) {
          await client.query("ROLLBACK").catch(() => undefined);
        }
        if (
          lifecycle.signal.aborted ||
          isPostgresTimeoutError(error)
        ) {
          throw new AdminAgentProfileError(
            500,
            "agent_profile_update_failed",
          );
        }
        throw error;
      } finally {
        lifecycle.dispose();
        guard?.dispose();
        if (client && guard?.destroyed !== true) {
          client.release();
        }
      }
    },
  };
}

function validateOperationId(operationId: string): void {
  if (
    typeof operationId !== "string" ||
    !CANONICAL_UUID_PATTERN.test(operationId)
  ) {
    throw new AdminAgentProfileError(400, "invalid_operation_id");
  }
}

async function recoverCommittedProfileUpdate(
  pool: Pool,
  input: AdminAgentProfileUpdate,
  inputFingerprint: string,
): Promise<number | null> {
  const lifecycle = createBoundedLifecycle(
    COMMIT_RECOVERY_TIMEOUT_MS,
  );
  let client: PoolClient | undefined;
  let guard: AbortablePoolClientGuard | undefined;
  let commitStarted = false;
  try {
    client = await connectPoolClient(pool, lifecycle.signal);
    guard = guardPoolClientWithAbort(client, lifecycle.signal);
    lifecycle.signal.throwIfAborted();
    await client.query("BEGIN");
    await setTransactionTimeouts(
      client,
      COMMIT_RECOVERY_TIMEOUT_MS,
    );
    const expectedRevision = input.expectedRevision + 1;
    const result = await client.query<{ revision: string }>(
      `SELECT after_summary->>'revision' AS revision
       FROM admin_audit_logs
       WHERE user_id = $1
         AND agent_id = $2
         AND action = 'agent_profile.update'
         AND resource_type = 'digital_agent'
         AND resource_id = ($2::uuid)::text
         AND status = 'success'
         AND error_code IS NULL
         AND confirmation_source->>'type' = 'console'
         AND confirmation_source->>'requestId' = $3
         AND confirmation_source->>'inputFingerprint' = $5
         AND jsonb_typeof(after_summary->'revision') = 'number'
         AND after_summary->>'revision' = $4
       ORDER BY created_at DESC
       LIMIT 1`,
      [
        input.scope.userId,
        input.scope.agentId,
        input.operationId,
        String(expectedRevision),
        inputFingerprint,
      ],
    );
    lifecycle.signal.throwIfAborted();
    commitStarted = true;
    await client.query("COMMIT");
    const revision = Number(result.rows[0]?.revision);
    return revision === expectedRevision ? revision : null;
  } catch {
    if (client && guard?.destroyed !== true) {
      if (commitStarted) {
        guard?.destroy();
      } else {
        await client.query("ROLLBACK").catch(() => {
          guard?.destroy();
        });
      }
    }
    return null;
  } finally {
    lifecycle.dispose();
    guard?.dispose();
    if (client && guard?.destroyed !== true) {
      client.release();
    }
  }
}

async function ensureDefaultProfileSettings(
  client: PoolClient,
  scope: AgentScope,
): Promise<void> {
  await client.query(
    `INSERT INTO agent_settings (
       user_id, agent_id, persona, proactivity, cadence, search
     )
     SELECT $1, $2, $3, $4, $5, $6
     FROM digital_agents
     WHERE digital_agents.user_id = $1
       AND digital_agents.id = $2
       AND digital_agents.status = 'active'
     ON CONFLICT (user_id, agent_id) DO NOTHING`,
    [
      scope.userId,
      scope.agentId,
      defaultSettings.persona,
      defaultSettings.proactivity,
      defaultSettings.cadence,
      defaultSettings.search,
    ],
  );
}

async function readDefaultProfileSnapshot(
  client: PoolClient,
  scope: AgentScope,
): Promise<AdminAgentProfileSnapshot | null> {
  const result = await client.query<ProfileSnapshotRow>(
    `SELECT digital_agents.id,
            digital_agents.display_name,
            agent_settings.persona,
            agent_settings.proactivity,
            agent_settings.cadence,
            agent_settings.search,
            agent_settings.revision
     FROM digital_agents
     JOIN agent_settings
       ON agent_settings.user_id = digital_agents.user_id
      AND agent_settings.agent_id = digital_agents.id
     WHERE digital_agents.user_id = $1
       AND digital_agents.id = $2
       AND digital_agents.status = 'active'`,
    [scope.userId, scope.agentId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    displayName: row.display_name,
    persona: mergeSettings(defaultSettings.persona, row.persona),
    proactivity: mergeSettings(
      defaultSettings.proactivity,
      row.proactivity,
    ),
    cadence: mergeSettings(defaultSettings.cadence, row.cadence),
    search: mergeSettings(defaultSettings.search, row.search),
    revision: Number(row.revision),
  };
}

async function setTransactionTimeouts(
  client: PoolClient,
  lifecycleTimeoutMs: number,
): Promise<void> {
  const statementTimeoutMs = Math.max(
    1,
    lifecycleTimeoutMs - 1,
  );
  const lockTimeoutMs = Math.min(10_000, statementTimeoutMs);
  await client.query(
    `SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`,
  );
  await client.query(
    `SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`,
  );
}

async function lockDefaultProfile(
  client: PoolClient,
  scope: AgentScope,
): Promise<LockedProfile | null> {
  const result = await client.query<LockedProfile>(
    `SELECT digital_agents.display_name,
            digital_agents.persona AS digital_persona,
            agent_settings.persona AS settings_persona,
            agent_settings.proactivity,
            agent_settings.cadence,
            agent_settings.search,
            agent_settings.model_routing_override,
            agent_settings.revision
     FROM digital_agents
     JOIN agent_settings
       ON agent_settings.user_id = digital_agents.user_id
      AND agent_settings.agent_id = digital_agents.id
     WHERE digital_agents.user_id = $1
       AND digital_agents.id = $2
       AND digital_agents.status = 'active'
     FOR UPDATE OF digital_agents, agent_settings`,
    [scope.userId, scope.agentId],
  );
  return result.rows[0] ?? null;
}

async function insertSafeAudit(
  client: PoolClient,
  input: AdminAgentProfileUpdate,
  before: LockedProfile,
  revision: number,
  inputFingerprint: string,
): Promise<void> {
  const changedFields = [
    !isJsonEqual(before.display_name, input.displayName)
      ? "display_name"
      : null,
    !isJsonEqual(before.settings_persona, input.persona)
      ? "persona"
      : null,
    !isJsonEqual(before.proactivity, input.settings.proactivity)
      ? "proactivity"
      : null,
    !isJsonEqual(before.cadence, input.settings.cadence)
      ? "cadence"
      : null,
    !isJsonEqual(before.search, input.settings.search)
      ? "search"
      : null,
  ].filter((field): field is string => field !== null);
  await client.query(
    `INSERT INTO admin_audit_logs (
       user_id, agent_id, action, resource_type, resource_id,
       before_summary, after_summary, confirmation_source,
       status, error_code
     )
     VALUES (
       $1, $2::uuid, 'agent_profile.update', 'digital_agent',
       ($2::uuid)::text,
       $3, $4, $5, 'success', NULL
     )`,
    [
      input.scope.userId,
      input.scope.agentId,
      {
        display_name: before.display_name,
        revision: Number(before.revision),
      },
      {
        display_name: input.displayName,
        revision,
        changed_fields: changedFields,
      },
      {
        type: "console",
        requestId: input.operationId,
        inputFingerprint,
      },
    ],
  );
}

async function recoverProfileUpdateInTransaction(
  client: PoolClient,
  input: AdminAgentProfileUpdate,
  current: LockedProfile,
  inputFingerprint: string,
): Promise<number | null> {
  const expectedRevision = input.expectedRevision + 1;
  const result = await client.query<{
    input_fingerprint: string | null;
    revision: string;
  }>(
    `SELECT
       confirmation_source->>'inputFingerprint'
         AS input_fingerprint,
       after_summary->>'revision' AS revision
     FROM admin_audit_logs
     WHERE user_id = $1
       AND agent_id = $2
       AND action = 'agent_profile.update'
       AND resource_type = 'digital_agent'
       AND resource_id = ($2::uuid)::text
       AND status = 'success'
       AND error_code IS NULL
       AND confirmation_source->>'type' = 'console'
       AND confirmation_source->>'requestId' = $3
     ORDER BY created_at DESC
     LIMIT 1`,
    [
      input.scope.userId,
      input.scope.agentId,
      input.operationId,
    ],
  );
  const replay = result.rows[0];
  if (!replay) return null;
  if (replay.input_fingerprint === null) return null;
  if (
    replay.input_fingerprint !== inputFingerprint ||
    Number(replay.revision) !== expectedRevision ||
    current.revision !== expectedRevision ||
    !profileMatchesUpdate(current, input)
  ) {
    throw new AdminAgentProfileError(
      409,
      "revision_conflict",
    );
  }
  return expectedRevision;
}

function profileMatchesUpdate(
  current: LockedProfile,
  input: AdminAgentProfileUpdate,
): boolean {
  return (
    isJsonEqual(current.display_name, input.displayName) &&
    isJsonEqual(current.settings_persona, input.persona) &&
    isJsonEqual(
      current.proactivity,
      input.settings.proactivity,
    ) &&
    isJsonEqual(current.cadence, input.settings.cadence) &&
    isJsonEqual(current.search, input.settings.search)
  );
}

function profileUpdateFingerprint(
  input: AdminAgentProfileUpdate,
): string {
  return createHash("sha256")
    .update(
      stableJson({
        expectedRevision: input.expectedRevision,
        displayName: input.displayName,
        persona: input.persona,
        settings: input.settings,
      }),
      "utf8",
    )
    .digest("hex");
}

function isJsonEqual(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeLifecycleTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIFECYCLE_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_LIFECYCLE_TIMEOUT_MS
  ) {
    throw new Error("invalid_agent_profile_lifecycle_timeout");
  }
  return value;
}

function createBoundedLifecycle(
  timeoutMs: number,
  outerSignal?: AbortSignal,
): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new Error("agent_profile_update_aborted"));
    }
  };
  if (outerSignal?.aborted) {
    abort();
  } else {
    outerSignal?.addEventListener("abort", abort, { once: true });
  }
  const timeout = setTimeout(abort, timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      outerSignal?.removeEventListener("abort", abort);
    },
  };
}

function isPostgresTimeoutError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = Reflect.get(error, "code");
  return code === "55P03" || code === "57014";
}

function mergeSettings<T extends Record<string, unknown>>(
  defaults: T,
  value: unknown,
): T {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return defaults;
  }
  return { ...defaults, ...(value as Partial<T>) };
}
