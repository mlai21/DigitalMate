import type {
  Pool,
  PoolClient,
} from "pg";

import type { AgentScope } from "@/server/agents/types";
import type {
  BackupArchiveContents,
  BackupJob,
  BackupJobKind,
} from "@/server/admin/backups/types";

type BackupRows = BackupArchiveContents["tables"];

type TableDefinition = Readonly<{
  name: string;
  scope: "agent" | "agent_row" | "user" | "agent_only";
  insertOrder: number;
  redact?: (
    row: Record<string, unknown>,
  ) => Record<string, unknown>;
}>;

const TABLES: readonly TableDefinition[] = [
  {
    name: "digital_agents",
    scope: "agent_row",
    insertOrder: 10,
  },
  { name: "settings", scope: "user", insertOrder: 20 },
  { name: "skills", scope: "user", insertOrder: 21 },
  { name: "skill_revisions", scope: "user", insertOrder: 22 },
  {
    name: "tool_registrations",
    scope: "user",
    insertOrder: 23,
    redact: (row) => ({
      ...row,
      command: "",
      status: "disabled",
    }),
  },
  { name: "agent_settings", scope: "agent", insertOrder: 30 },
  { name: "agent_resource_grants", scope: "agent", insertOrder: 31 },
  { name: "projects", scope: "agent", insertOrder: 40 },
  { name: "conversations", scope: "agent", insertOrder: 41 },
  { name: "proactive_tasks", scope: "agent", insertOrder: 42 },
  {
    name: "messages",
    scope: "agent",
    insertOrder: 43,
    redact: (row) => ({ ...row, source_task_id: null }),
  },
  { name: "message_attachments", scope: "agent", insertOrder: 44 },
  { name: "conversation_summaries", scope: "agent", insertOrder: 45 },
  { name: "memory_entries", scope: "agent", insertOrder: 46 },
  { name: "goals", scope: "agent", insertOrder: 47 },
  { name: "goal_steps", scope: "agent_only", insertOrder: 48 },
  {
    name: "tool_call_logs",
    scope: "agent",
    insertOrder: 49,
    redact: (row) => ({
      ...row,
      input_summary: "",
      output_summary: "",
      error: null,
    }),
  },
  {
    name: "scheduled_jobs",
    scope: "agent",
    insertOrder: 50,
    redact: (row) => ({
      ...row,
      status: row.enabled === true ? "idle" : "paused",
      last_error_code: null,
    }),
  },
  {
    name: "scheduled_job_runs",
    scope: "agent",
    insertOrder: 51,
    redact: (row) => ({ ...row, proactive_task_id: null }),
  },
  { name: "channel_identities", scope: "agent", insertOrder: 60 },
  {
    name: "channel_connections",
    scope: "agent",
    insertOrder: 61,
    redact: (row) => ({
      ...row,
      enabled: false,
      runtime_node_id: null,
      config: sanitizeConfiguration(row.config),
      health_status: "disabled",
      health_detail: {},
      last_connected_at: null,
      last_disconnected_at: null,
    }),
  },
  {
    name: "channel_inbound_events",
    scope: "agent",
    insertOrder: 62,
    redact: (row) => ({
      ...row,
      status:
        row.status === "running" ? "failed" : row.status,
      claim_owner: null,
      claim_expires_at: null,
      failure_code:
        row.status === "running"
          ? "restored_interrupted"
          : row.failure_code,
    }),
  },
  { name: "channel_access_rules", scope: "agent", insertOrder: 63 },
  { name: "channel_access_requests", scope: "agent", insertOrder: 64 },
  {
    name: "channel_messages",
    scope: "agent",
    insertOrder: 65,
    redact: omitKeys("raw_payload"),
  },
  { name: "interjection_decisions", scope: "agent", insertOrder: 66 },
  { name: "reflections", scope: "agent", insertOrder: 70 },
  { name: "skill_usage_logs", scope: "agent", insertOrder: 71 },
  {
    name: "task_runs",
    scope: "agent",
    insertOrder: 72,
    redact: (row) => ({
      ...row,
      input_summary: "",
      output_summary: "",
      error: null,
      metadata: sanitizeConfiguration(row.metadata),
    }),
  },
  { name: "task_artifacts", scope: "agent", insertOrder: 73 },
  { name: "llm_usage_logs", scope: "agent", insertOrder: 74 },
  { name: "memory_jobs", scope: "agent", insertOrder: 75 },
  {
    name: "admin_audit_logs",
    scope: "agent",
    insertOrder: 76,
    redact: (row) => ({
      ...row,
      before_summary: {},
      after_summary: {},
      confirmation_source: null,
    }),
  },
  { name: "admin_inbox_states", scope: "agent", insertOrder: 77 },
] as const;

const TABLE_BY_NAME = new Map(
  TABLES.map((table) => [table.name, table]),
);

export type BackupDatabaseSnapshot = Readonly<{
  tables: BackupRows;
  attachmentFiles: readonly Readonly<{
    storageKey: string;
    mimeType: string;
  }>[];
  matrixConnectionIds: readonly string[];
  agentName: string;
}>;

export type BackupRestorePreview = Readonly<{
  tables: Readonly<
    Record<string, Readonly<{ incoming: number; existing: number }>>
  >;
  attachments: number;
  matrixStores: number;
}>;

export type BackupRepository = Readonly<{
  createJob(input: Readonly<{
    scope: AgentScope;
    name: string;
    description: string;
    kind: BackupJobKind;
    expiresAt: Date;
  }>): Promise<BackupJob>;
  setJobRunning(scope: AgentScope, id: string): Promise<void>;
  completeJob(
    scope: AgentScope,
    id: string,
    archive: Readonly<{
      storageKey: string;
      checksum: string;
      sizeBytes: number;
    }>,
  ): Promise<BackupJob>;
  failJob(
    scope: AgentScope,
    id: string,
    errorCode: string,
  ): Promise<void>;
  listJobs(scope: AgentScope): Promise<readonly BackupJob[]>;
  getJob(scope: AgentScope, id: string): Promise<BackupJob | null>;
  deleteJobs(
    scope: AgentScope,
    ids: readonly string[],
  ): Promise<readonly BackupJob[]>;
  snapshot(
    scope: AgentScope,
    signal?: AbortSignal,
  ): Promise<BackupDatabaseSnapshot>;
  previewRestore(
    scope: AgentScope,
    tables: BackupRows,
    signal?: AbortSignal,
  ): Promise<BackupRestorePreview>;
  restore(
    scope: AgentScope,
    tables: BackupRows,
    backupId: string,
    publishFiles: () => Promise<Readonly<{
      rollback(): Promise<void>;
      commit(): Promise<void>;
    }>>,
    signal?: AbortSignal,
  ): Promise<void>;
}>;

export function createPostgresBackupRepository(
  pool: Pool,
): BackupRepository {
  return {
    async createJob(input) {
      const result = await pool.query(
        `INSERT INTO backup_jobs (
           user_id, agent_id, name, description, status,
           kind, expires_at
         )
         VALUES ($1, $2, $3, $4, 'pending', $5, $6)
         RETURNING *`,
        [
          input.scope.userId,
          input.scope.agentId,
          input.name,
          input.description,
          input.kind,
          input.expiresAt,
        ],
      );
      return mapJob(result.rows[0]);
    },
    async setJobRunning(scope, id) {
      await assertJobMutation(
        pool,
        scope,
        id,
        `UPDATE backup_jobs
         SET status = 'running', error_code = NULL
         WHERE user_id = $1 AND agent_id = $2 AND id = $3`,
      );
    },
    async completeJob(scope, id, archive) {
      const result = await pool.query(
        `UPDATE backup_jobs
         SET status = 'ready',
             storage_key = $4,
             checksum = $5,
             size_bytes = $6,
             error_code = NULL
         WHERE user_id = $1 AND agent_id = $2 AND id = $3
         RETURNING *`,
        [
          scope.userId,
          scope.agentId,
          id,
          archive.storageKey,
          archive.checksum,
          archive.sizeBytes,
        ],
      );
      if (!result.rows[0]) throw new Error("backup_not_found");
      return mapJob(result.rows[0]);
    },
    async failJob(scope, id, errorCode) {
      await assertJobMutation(
        pool,
        scope,
        id,
        `UPDATE backup_jobs
         SET status = 'failed',
             storage_key = NULL,
             checksum = NULL,
             size_bytes = NULL,
             error_code = $4
         WHERE user_id = $1 AND agent_id = $2 AND id = $3`,
        [errorCode],
      );
    },
    async listJobs(scope) {
      const result = await pool.query(
        `SELECT *
         FROM backup_jobs
         WHERE user_id = $1
           AND agent_id = $2
           AND expires_at > now()
         ORDER BY created_at DESC, id DESC`,
        [scope.userId, scope.agentId],
      );
      return result.rows.map(mapJob);
    },
    async getJob(scope, id) {
      const result = await pool.query(
        `SELECT *
         FROM backup_jobs
         WHERE user_id = $1 AND agent_id = $2 AND id = $3`,
        [scope.userId, scope.agentId, id],
      );
      return result.rows[0] ? mapJob(result.rows[0]) : null;
    },
    async deleteJobs(scope, ids) {
      const result = await pool.query(
        `DELETE FROM backup_jobs
         WHERE user_id = $1
           AND agent_id = $2
           AND id = ANY($3::uuid[])
         RETURNING *`,
        [scope.userId, scope.agentId, ids],
      );
      return result.rows.map(mapJob);
    },
    async snapshot(scope, signal) {
      const client = await pool.connect();
      try {
        signal?.throwIfAborted();
        await client.query(
          "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        const tables: Record<
          string,
          readonly Record<string, unknown>[]
        > = {};
        for (const definition of TABLES) {
          signal?.throwIfAborted();
          const rows = await readTable(
            client,
            definition,
            scope,
          );
          tables[definition.name] = definition.redact
            ? rows.map(definition.redact)
            : rows;
        }
        tables.channel_secrets = await readChannelSecrets(
          client,
          scope,
        );
        const attachments =
          tables.message_attachments ?? [];
        const connections =
          tables.channel_connections ?? [];
        const agent = tables.digital_agents?.[0];
        await client.query("COMMIT");
        return {
          tables,
          attachmentFiles: attachments
            .filter(
              (row) =>
                row.status === "ready"
                || row.status === "bound",
            )
            .map((row) => ({
              storageKey: requireString(row.storage_key),
              mimeType: requireString(row.mime_type),
            })),
          matrixConnectionIds: connections
            .filter((row) => row.channel_type === "matrix")
            .map((row) => requireString(row.id)),
          agentName:
            typeof agent?.display_name === "string"
              ? agent.display_name
              : "DigitalMate",
        };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async previewRestore(scope, tables, signal) {
      const preview: Record<
        string,
        { incoming: number; existing: number }
      > = {};
      for (const [name, rows] of Object.entries(tables)) {
        signal?.throwIfAborted();
        if (name === "channel_secrets") {
          const result = await pool.query<{ count: string }>(
            `SELECT count(*)::text AS count
             FROM channel_secrets AS secret
             JOIN channel_connections AS connection
               ON connection.id = secret.connection_id
             WHERE connection.user_id = $1
               AND connection.agent_id = $2`,
            [scope.userId, scope.agentId],
          );
          preview[name] = {
            incoming: rows.length,
            existing: Number(result.rows[0]?.count ?? 0),
          };
          continue;
        }
        const definition = TABLE_BY_NAME.get(name);
        if (!definition) throw new Error("backup_archive_invalid");
        const result = await pool.query<{ count: string }>(
          buildCountSql(definition),
          [...buildScopeParams(definition, scope)],
        );
        preview[name] = {
          incoming: rows.length,
          existing: Number(result.rows[0]?.count ?? 0),
        };
      }
      return {
        tables: preview,
        attachments:
          tables.message_attachments?.length ?? 0,
        matrixStores:
          (tables.channel_connections ?? [])
            .filter((row) => row.channel_type === "matrix")
            .length,
      };
    },
    async restore(
      scope,
      tables,
      backupId,
      publishFiles,
      signal,
    ) {
      assertRestoreTables(tables);
      const client = await pool.connect();
      let publishedFiles:
        | Readonly<{
            rollback(): Promise<void>;
            commit(): Promise<void>;
          }>
        | undefined;
      try {
        signal?.throwIfAborted();
        await client.query("BEGIN");
        await client.query(
          `SELECT id
           FROM digital_agents
           WHERE user_id = $1 AND id = $2
           FOR UPDATE`,
          [scope.userId, scope.agentId],
        );
        const count = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM digital_agents
           WHERE user_id = $1`,
          [scope.userId],
        );
        if (Number(count.rows[0]?.count ?? 0) > 1) {
          throw new Error("backup_multi_agent_restore_blocked");
        }
        await client.query(
          `DELETE FROM admin_audit_logs
           WHERE user_id = $1 AND agent_id = $2`,
          [scope.userId, scope.agentId],
        );
        await client.query(
          `DELETE FROM digital_agents
           WHERE user_id = $1 AND id = $2`,
          [scope.userId, scope.agentId],
        );
        await client.query(
          "DELETE FROM settings WHERE user_id = $1",
          [scope.userId],
        );
        await client.query(
          "DELETE FROM skills WHERE user_id = $1",
          [scope.userId],
        );
        await client.query(
          "DELETE FROM tool_registrations WHERE user_id = $1",
          [scope.userId],
        );
        for (
          const definition of [...TABLES].sort(
            (left, right) =>
              left.insertOrder - right.insertOrder,
          )
        ) {
          signal?.throwIfAborted();
          await insertRows(
            client,
            definition,
            tables[definition.name] ?? [],
          );
        }
        await insertChannelSecrets(
          client,
          tables.channel_secrets ?? [],
        );
        await client.query(
          `INSERT INTO admin_audit_logs (
             user_id, agent_id, action, resource_type,
             resource_id, before_summary, after_summary,
             confirmation_source, status
           )
           VALUES (
             $1, $2, 'backup.restore', 'backup', $3,
             '{}'::jsonb,
             '{"channels_disabled":true}'::jsonb,
             '{"kind":"console_confirmation"}'::jsonb,
             'success'
           )`,
          [scope.userId, scope.agentId, backupId],
        );
        publishedFiles = await publishFiles();
        signal?.throwIfAborted();
        await client.query("COMMIT");
        await publishedFiles.commit();
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (publishedFiles) {
          await publishedFiles.rollback().catch(() => undefined);
        }
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

async function readTable(
  client: PoolClient,
  definition: TableDefinition,
  scope: AgentScope,
): Promise<Record<string, unknown>[]> {
  try {
    const result = await client.query<{
      value: Record<string, unknown>;
    }>(
      `SELECT to_jsonb(scoped_row) AS value
       FROM ${definition.name} AS scoped_row
       WHERE ${
         definition.scope === "user"
           ? "scoped_row.user_id = $1"
           : definition.scope === "agent_row"
             ? "scoped_row.user_id = $1 AND scoped_row.id = $2"
           : definition.scope === "agent_only"
             ? "scoped_row.agent_id = $1"
             : "scoped_row.user_id = $1 AND scoped_row.agent_id = $2"
       }`,
      [...buildScopeParams(definition, scope)],
    );
    return result.rows.map((row) => row.value);
  } catch (error) {
    throw new Error(
      `backup_snapshot_table_failed:${definition.name}`,
      { cause: error },
    );
  }
}

async function readChannelSecrets(
  client: PoolClient,
  scope: AgentScope,
): Promise<Record<string, unknown>[]> {
  const result = await client.query<{
    value: Record<string, unknown>;
  }>(
    `SELECT to_jsonb(secret_row) AS value
     FROM channel_secrets AS secret_row
     JOIN channel_connections AS connection
       ON connection.id = secret_row.connection_id
     WHERE connection.user_id = $1
       AND connection.agent_id = $2`,
    [scope.userId, scope.agentId],
  );
  return result.rows.map((row) => row.value);
}

async function insertRows(
  client: PoolClient,
  definition: TableDefinition,
  rows: readonly Record<string, unknown>[],
): Promise<void> {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]!).sort();
  assertColumns(columns);
  if (
    rows.some((row) =>
      Object.keys(row).sort().join("\0")
      !== columns.join("\0")
    )
  ) {
    throw new Error("backup_archive_invalid");
  }
  const identifiers = columns.map(quoteIdentifier).join(", ");
  await client.query(
    `INSERT INTO ${definition.name} (${identifiers})
     SELECT ${identifiers}
     FROM jsonb_populate_recordset(
       NULL::${definition.name},
       $1::jsonb
     )`,
    [JSON.stringify(rows)],
  );
}

async function insertChannelSecrets(
  client: PoolClient,
  rows: readonly Record<string, unknown>[],
): Promise<void> {
  if (rows.length === 0) return;
  await insertRows(
    client,
    {
      name: "channel_secrets",
      scope: "agent_only",
      insertOrder: 62,
    },
    rows,
  );
}

function assertRestoreTables(tables: BackupRows): void {
  for (const [name, rows] of Object.entries(tables)) {
    if (
      name !== "channel_secrets"
      && !TABLE_BY_NAME.has(name)
    ) {
      throw new Error("backup_archive_invalid");
    }
    if (
      !Array.isArray(rows)
      || rows.some(
        (row) =>
          typeof row !== "object"
          || row === null
          || Array.isArray(row),
      )
    ) {
      throw new Error("backup_archive_invalid");
    }
  }
}

function buildCountSql(
  definition: TableDefinition,
): string {
  return `SELECT count(*)::text AS count
          FROM ${definition.name} AS scoped_row
          WHERE ${
            definition.scope === "user"
              ? "scoped_row.user_id = $1"
              : definition.scope === "agent_row"
                ? "scoped_row.user_id = $1 AND scoped_row.id = $2"
              : definition.scope === "agent_only"
                ? "scoped_row.agent_id = $1"
                : "scoped_row.user_id = $1 AND scoped_row.agent_id = $2"
          }`;
}

function buildScopeParams(
  definition: TableDefinition,
  scope: AgentScope,
): readonly string[] {
  return definition.scope === "user"
    ? [scope.userId]
    : definition.scope === "agent_only"
      ? [scope.agentId]
    : [scope.userId, scope.agentId];
}

function omitKeys(
  ...keys: readonly string[]
): (
  row: Record<string, unknown>,
) => Record<string, unknown> {
  return (row) => {
    const projected = { ...row };
    for (const key of keys) delete projected[key];
    return projected;
  };
}

function sanitizeConfiguration(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeConfiguration);
  }
  if (
    typeof value !== "object"
    || value === null
  ) {
    return value;
  }
  const projected: Record<string, unknown> = {};
  for (
    const [key, nested]
      of Object.entries(value as Record<string, unknown>)
  ) {
    const concept = key
      .toLowerCase()
      .replace(/[^a-z0-9]/gu, "");
    if (
      concept.includes("secret")
      || concept.includes("token")
      || concept.includes("password")
      || concept.includes("credential")
      || concept.includes("privatekey")
      || concept.includes("storagekey")
      || concept.includes("temporaryurl")
      || concept.includes("rawpayload")
      || concept.includes("providerpayload")
    ) {
      continue;
    }
    projected[key] = sanitizeConfiguration(nested);
  }
  return projected;
}

function assertColumns(columns: readonly string[]): void {
  if (
    columns.length === 0
    || columns.some(
      (column) => !/^[a-z][a-z0-9_]{0,62}$/u.test(column),
    )
  ) {
    throw new Error("backup_archive_invalid");
  }
}

function quoteIdentifier(value: string): string {
  return `"${value}"`;
}

function requireString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("backup_archive_invalid");
  }
  return value;
}

function mapJob(row: Record<string, unknown>): BackupJob {
  if (!row) throw new Error("backup_not_found");
  return {
    id: String(row.id),
    userId: String(row.user_id),
    agentId: String(row.agent_id),
    name: String(row.name),
    description: String(row.description),
    status: row.status as BackupJob["status"],
    kind: row.kind as BackupJob["kind"],
    storageKey:
      typeof row.storage_key === "string"
        ? row.storage_key
        : null,
    checksum:
      typeof row.checksum === "string" ? row.checksum : null,
    sizeBytes:
      row.size_bytes === null || row.size_bytes === undefined
        ? null
        : Number(row.size_bytes),
    errorCode:
      typeof row.error_code === "string"
        ? row.error_code
        : null,
    createdAt: new Date(String(row.created_at)),
    expiresAt: new Date(String(row.expires_at)),
  };
}

async function assertJobMutation(
  pool: Pool,
  scope: AgentScope,
  id: string,
  sql: string,
  extra: readonly unknown[] = [],
): Promise<void> {
  const result = await pool.query(sql, [
    scope.userId,
    scope.agentId,
    id,
    ...extra,
  ]);
  if (result.rowCount !== 1) throw new Error("backup_not_found");
}
