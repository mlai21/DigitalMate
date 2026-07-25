import type { Pool, PoolClient } from "pg";

import type { AgentScope } from "@/server/agents/types";
import type {
  AdminChannelConfigCollection,
  AdminChannelConfigSnapshot,
  AdminChannelConfigWrite,
  AdminChannelSecretStatus,
} from "@/server/admin/compat/handlers/channels";
import {
  containsSecretExposure,
  containsSecretFingerprintExposure,
} from "@/server/admin/secret-content";
import {
  lockUserCredentialExposure,
  readUserCredentialExposureState,
  rememberSecretExposureFingerprint,
  type UserCredentialExposureState,
} from "@/server/admin/secret-exposure-store";
import {
  CHANNEL_TYPES,
  getChannelManifest,
  type ChannelType,
} from "@/server/channels/manifests/catalog";
import {
  connectPoolClient,
  guardPoolClientWithAbort,
  type AbortablePoolClientGuard,
} from "@/server/db/abortable-client";
import {
  validateSecretPlaintext,
  type ChannelSecretsKey,
} from "@/server/security/encrypted-secret";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 30_000;
const RECOVERY_TIMEOUT_MS = 3_000;
const OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DECLARED_SECRET_FIELDS = Object.freeze([
  ...new Set(
    CHANNEL_TYPES.flatMap(
      (type) => getChannelManifest(type).secretFields,
    ),
  ),
]);

type ConnectionRow = {
  id: string;
  user_id: string;
  agent_id: string;
  channel_type: ChannelType;
  enabled: boolean;
  config: Record<string, unknown>;
  revision: number;
  health_status:
    | "blocked"
    | "disabled"
    | "starting"
    | "connected"
    | "degraded"
    | "disconnected";
  health_detail: Record<string, unknown>;
  last_connected_at?: Date | string | null;
  last_disconnected_at?: Date | string | null;
  last_event_at?: Date | string | null;
};

type ConnectionSecretRow = ConnectionRow & {
  field_name: string | null;
  rotated_at: Date | string | null;
};

type PreparedWrite = AdminChannelConfigWrite & {
  config: Record<string, unknown>;
  fingerprint: string;
};

export type AdminChannelConfigServiceOptions = Readonly<{
  lifecycleTimeoutMs?: number;
}>;

export class AdminChannelConfigError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "AdminChannelConfigError";
    this.status = status;
    this.code = code;
  }
}

export function createAdminChannelConfigService(
  pool: Pool,
  secretKey: ChannelSecretsKey | null,
  options: AdminChannelConfigServiceOptions = {},
) {
  const timeoutMs = normalizeTimeout(options.lifecycleTimeoutMs);
  return {
    async read(
      scope: AgentScope,
      outerSignal?: AbortSignal,
    ): Promise<AdminChannelConfigCollection> {
      const lifecycle = createLifecycle(timeoutMs, outerSignal);
      let client: PoolClient | undefined;
      let guard: AbortablePoolClientGuard | undefined;
      let transactionState:
        | "none"
        | "starting"
        | "active"
        | "committing"
        | "finished" = "none";
      try {
        lifecycle.signal.throwIfAborted();
        client = await connectPoolClient(pool, lifecycle.signal);
        guard = guardPoolClientWithAbort(client, lifecycle.signal);
        transactionState = "starting";
        await client.query("BEGIN");
        transactionState = "active";
        await setTimeouts(client, timeoutMs);
        const rows = await readAllRows(client, scope);
        lifecycle.signal.throwIfAborted();
        const result = collectionFromRows(rows);
        transactionState = "committing";
        await client.query("COMMIT");
        transactionState = "finished";
        return result;
      } catch (error) {
        if (client && guard && !guard.destroyed) {
          if (transactionState === "active") {
            if (!await rollbackChannelTransaction(client)) {
              guard.destroy();
            }
          } else if (
            transactionState === "starting"
            || transactionState === "committing"
          ) {
            guard.destroy();
          }
        }
        throw classifyFailure(error, "channel_config_read_failed", lifecycle.signal);
      } finally {
        lifecycle.dispose();
        guard?.dispose();
        if (client && guard?.destroyed !== true) client.release();
      }
    },

    async update(
      input: AdminChannelConfigWrite,
      outerSignal?: AbortSignal,
    ): Promise<AdminChannelConfigSnapshot> {
      if (secretKey === null) {
        throw new AdminChannelConfigError(
          409,
          "channel_secret_storage_blocked",
        );
      }
      const prepared = prepareWrite(input, secretKey);
      const lifecycle = createLifecycle(timeoutMs, outerSignal);
      let client: PoolClient | undefined;
      let guard: AbortablePoolClientGuard | undefined;
      let transactionState:
        | "none"
        | "starting"
        | "active"
        | "committing"
        | "finished" = "none";
      try {
        lifecycle.signal.throwIfAborted();
        client = await connectPoolClient(pool, lifecycle.signal);
        guard = guardPoolClientWithAbort(client, lifecycle.signal);
        transactionState = "starting";
        await client.query("BEGIN");
        transactionState = "active";
        await setTimeouts(client, timeoutMs);
        await lockUserCredentialExposure(
          client,
          prepared.scope.userId,
        );
        await lockCanonicalType(client, prepared);
        lifecycle.signal.throwIfAborted();
        const recovered = await recoverInTransaction(client, prepared);
        if (recovered) {
          transactionState = "committing";
          try {
            await client.query("COMMIT");
            transactionState = "finished";
            return recovered;
          } catch {
            guard.destroy();
            const committed = await recoverCommittedUpdate(
              pool,
              prepared,
            );
            if (committed) return committed;
            throw updateFailed();
          }
        }

        const active = await lockActiveConnections(client, prepared);
        if (active.length > 1) throw ambiguousConnection();
        validateLockedRevision(prepared, active);
        const exposure = await readUserCredentialExposureState(
          client,
          prepared.scope.userId,
          secretKey,
        );
        await validatePublicConfigSecrets(
          prepared,
          exposure,
          preparedSecretValues([prepared]),
          secretKey,
        );
        let updated: ConnectionRow;
        let beforeSnapshot: AdminChannelConfigSnapshot;
        let action: "channel_connection.create" | "channel_connection.update";
        if (active.length === 0) {
          if (prepared.expectedRevision !== 0) throw revisionConflict();
          beforeSnapshot = virtualSnapshot(prepared.type);
          updated = await insertConnection(client, prepared);
          action = "channel_connection.create";
        } else {
          const before = active[0];
          if (
            prepared.expectedRevision === 0 ||
            before.revision !== prepared.expectedRevision
          ) {
            throw revisionConflict();
          }
          beforeSnapshot = await readSnapshot(client, before);
          updated = await updateConnection(client, before, prepared);
          action = "channel_connection.update";
        }
        await applySecrets(client, updated, prepared, secretKey, lifecycle.signal);
        const snapshot = await readSnapshot(client, updated);
        await insertAudit(
          client,
          prepared,
          updated,
          beforeSnapshot,
          snapshot,
          action,
        );
        await notifyConfigChanged(client, updated);
        lifecycle.signal.throwIfAborted();
        transactionState = "committing";
        try {
          await client.query("COMMIT");
          transactionState = "finished";
          return snapshot;
        } catch {
          guard.destroy();
          const recovered = await recoverCommittedUpdate(
            pool,
            prepared,
          );
          if (recovered) return recovered;
          throw updateFailed();
        }
      } catch (error) {
        if (
          client &&
          guard &&
          !guard.destroyed
        ) {
          if (transactionState === "active") {
            if (!await rollbackChannelTransaction(client)) {
              guard.destroy();
            }
          } else if (
            transactionState === "starting"
            || transactionState === "committing"
          ) {
            guard.destroy();
          }
        }
        throw classifyFailure(error, "channel_config_update_failed", lifecycle.signal);
      } finally {
        lifecycle.dispose();
        guard?.dispose();
        if (client && guard?.destroyed !== true) client.release();
      }
    },

    async updateMany(
      inputs: readonly AdminChannelConfigWrite[],
      outerSignal?: AbortSignal,
    ): Promise<AdminChannelConfigCollection> {
      if (secretKey === null) {
        throw new AdminChannelConfigError(
          409,
          "channel_secret_storage_blocked",
        );
      }
      if (
        inputs.length !== CHANNEL_TYPES.length ||
        new Set(inputs.map((input) => input.type)).size !==
          CHANNEL_TYPES.length ||
        CHANNEL_TYPES.some(
          (type) => !inputs.some((input) => input.type === type),
        ) ||
        new Set(inputs.map((input) => input.operationId)).size !==
          inputs.length
        || inputs.some((input) =>
          input.scope.userId !== inputs[0]?.scope.userId
          || input.scope.agentId !== inputs[0]?.scope.agentId
        )
      ) {
        throw new AdminChannelConfigError(
          400,
          "invalid_channel_batch",
        );
      }
      const preparedByType = new Map(
        inputs.map((input) => [
          input.type,
          prepareWrite(input, secretKey),
        ]),
      );
      const prepared = CHANNEL_TYPES.map((type) => {
        const item = preparedByType.get(type);
        if (!item) {
          throw new AdminChannelConfigError(
            400,
            "invalid_channel_batch",
          );
        }
        return item;
      });
      const lifecycle = createLifecycle(timeoutMs, outerSignal);
      let client: PoolClient | undefined;
      let guard: AbortablePoolClientGuard | undefined;
      let transactionState:
        | "none"
        | "starting"
        | "active"
        | "committing"
        | "finished" = "none";
      try {
        lifecycle.signal.throwIfAborted();
        client = await connectPoolClient(pool, lifecycle.signal);
        guard = guardPoolClientWithAbort(client, lifecycle.signal);
        transactionState = "starting";
        await client.query("BEGIN");
        transactionState = "active";
        await setTimeouts(client, timeoutMs);
        await lockUserCredentialExposure(
          client,
          prepared[0]!.scope.userId,
        );
        for (const item of prepared) {
          await lockCanonicalType(client, item);
          lifecycle.signal.throwIfAborted();
        }

        const recovered = new Map<
          ChannelType,
          AdminChannelConfigSnapshot
        >();
        for (const item of prepared) {
          const snapshot = await recoverInTransaction(client, item);
          if (snapshot) recovered.set(item.type, snapshot);
        }
        if (recovered.size > 0) {
          if (recovered.size !== prepared.length) {
            throw new AdminChannelConfigError(
              409,
              "bulk_operation_incomplete",
            );
          }
          transactionState = "committing";
          try {
            await client.query("COMMIT");
            transactionState = "finished";
            return collectionFromSnapshots(recovered);
          } catch {
            guard.destroy();
            const committed = await recoverCommittedBatch(
              pool,
              prepared,
            );
            if (committed) return committed;
            throw updateFailed();
          }
        }

        const locked = new Map<
          ChannelType,
          readonly ConnectionRow[]
        >();
        for (const item of prepared) {
          const active = await lockActiveConnections(client, item);
          validateLockedRevision(item, active);
          locked.set(item.type, active);
        }
        const exposure = await readUserCredentialExposureState(
          client,
          prepared[0]!.scope.userId,
          secretKey,
        );
        const newPlaintextValues = preparedSecretValues(prepared);
        for (const item of prepared) {
          await validatePublicConfigSecrets(
            item,
            exposure,
            newPlaintextValues,
            secretKey,
          );
          lifecycle.signal.throwIfAborted();
        }

        const snapshots = new Map<
          ChannelType,
          AdminChannelConfigSnapshot
        >();
        for (const item of prepared) {
          const active = locked.get(item.type) ?? [];
          const before = active[0];
          const beforeSnapshot = before
            ? await readSnapshot(client, before)
            : virtualSnapshot(item.type);
          const updated = before
            ? await updateConnection(client, before, item)
            : await insertConnection(client, item);
          await applySecrets(
            client,
            updated,
            item,
            secretKey,
            lifecycle.signal,
          );
          const snapshot = await readSnapshot(client, updated);
          await insertAudit(
            client,
            item,
            updated,
            beforeSnapshot,
            snapshot,
            before
              ? "channel_connection.update"
              : "channel_connection.create",
          );
          await notifyConfigChanged(client, updated);
          snapshots.set(item.type, snapshot);
          lifecycle.signal.throwIfAborted();
        }
        transactionState = "committing";
        try {
          await client.query("COMMIT");
          transactionState = "finished";
          return collectionFromSnapshots(snapshots);
        } catch {
          guard.destroy();
          const recovered = await recoverCommittedBatch(
            pool,
            prepared,
          );
          if (recovered) return recovered;
          throw updateFailed();
        }
      } catch (error) {
        if (
          client &&
          guard &&
          !guard.destroyed
        ) {
          if (transactionState === "active") {
            if (!await rollbackChannelTransaction(client)) {
              guard.destroy();
            }
          } else if (
            transactionState === "starting"
            || transactionState === "committing"
          ) {
            guard.destroy();
          }
        }
        throw classifyFailure(
          error,
          "channel_config_update_failed",
          lifecycle.signal,
        );
      } finally {
        lifecycle.dispose();
        guard?.dispose();
        if (client && guard?.destroyed !== true) client.release();
      }
    },
  };
}

function validateLockedRevision(
  input: PreparedWrite,
  active: readonly ConnectionRow[],
): void {
  if (active.length > 1) throw ambiguousConnection();
  const before = active[0];
  if (
    (
      before === undefined &&
      input.expectedRevision !== 0
    ) ||
    (
      before !== undefined &&
      (
        input.expectedRevision === 0 ||
        before.revision !== input.expectedRevision
      )
    )
  ) {
    throw revisionConflict();
  }
}

function collectionFromSnapshots(
  snapshots: ReadonlyMap<ChannelType, AdminChannelConfigSnapshot>,
): AdminChannelConfigCollection {
  return Object.fromEntries(
    CHANNEL_TYPES.map((type) => {
      const snapshot = snapshots.get(type);
      if (!snapshot) throw updateFailed();
      return [type, snapshot];
    }),
  ) as AdminChannelConfigCollection;
}

function prepareWrite(
  input: AdminChannelConfigWrite,
  key: ChannelSecretsKey,
): PreparedWrite {
  if (!OPERATION_ID_PATTERN.test(input.operationId)) {
    throw new AdminChannelConfigError(400, "invalid_operation_id");
  }
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0
  ) {
    throw new AdminChannelConfigError(400, "invalid_config_revision");
  }
  const manifest = getChannelManifest(input.type);
  const parsed = manifest.configSchema.parse({
    ...input.config,
    enabled: input.enabled,
  });
  const config = { ...parsed };
  delete config.enabled;
  for (const secretField of manifest.secretFields) {
    if (Object.hasOwn(input.config, secretField)) {
      throw new AdminChannelConfigError(400, "secret_in_public_config");
    }
    delete config[secretField];
  }
  const declared = new Set(manifest.secretFields);
  const changed = new Set<string>();
  for (const change of input.secretChanges) {
    if (
      !declared.has(change.fieldName) ||
      changed.has(change.fieldName)
    ) {
      throw new AdminChannelConfigError(400, "invalid_secret_change");
    }
    changed.add(change.fieldName);
    if (change.operation === "set") {
      if (change.value.length === 0) {
        throw new AdminChannelConfigError(400, "invalid_secret_change");
      }
      try {
        validateSecretPlaintext(change.value);
      } catch {
        throw new AdminChannelConfigError(400, "invalid_secret_change");
      }
    }
  }
  const fingerprint = key.fingerprint(
    stableJson({
      type: input.type,
      expectedRevision: input.expectedRevision,
      enabled: input.enabled,
      config,
      secretChanges: input.secretChanges,
    }),
  );
  return { ...input, config, fingerprint };
}

async function readAllRows(
  client: PoolClient,
  scope: AgentScope,
): Promise<ConnectionSecretRow[]> {
  const result = await client.query<ConnectionSecretRow>(
    `WITH ranked_connections AS (
       SELECT channel_connections.*,
              row_number() OVER (
                PARTITION BY channel_connections.channel_type
                ORDER BY channel_connections.created_at
              ) AS active_rank
       FROM channel_connections
       WHERE channel_connections.user_id = $1
         AND channel_connections.agent_id = $2
         AND channel_connections.channel_type = ANY($3::text[])
         AND channel_connections.deleted_at IS NULL
     ),
     bounded_connections AS (
       SELECT *
       FROM ranked_connections
       WHERE active_rank <= 2
     )
     SELECT connection.id, connection.user_id, connection.agent_id,
            connection.channel_type, connection.enabled, connection.config,
            connection.revision, connection.health_status,
            connection.health_detail, connection.last_connected_at,
            connection.last_disconnected_at, connection.last_event_at,
            secret.field_name, secret.rotated_at
     FROM bounded_connections AS connection
     LEFT JOIN channel_secrets AS secret
       ON secret.connection_id = connection.id
      AND secret.field_name = ANY($4::text[])
     ORDER BY connection.channel_type, connection.created_at, secret.field_name`,
    [
      scope.userId,
      scope.agentId,
      CHANNEL_TYPES,
      DECLARED_SECRET_FIELDS,
    ],
  );
  return result.rows;
}

function collectionFromRows(
  rows: readonly ConnectionSecretRow[],
): AdminChannelConfigCollection {
  const grouped = new Map<
    ChannelType,
    Map<string, { row: ConnectionRow; secrets: Record<string, AdminChannelSecretStatus> }>
  >();
  for (const row of rows) {
    const byId = grouped.get(row.channel_type) ?? new Map();
    const value = byId.get(row.id) ?? {
      row,
      secrets: {},
    };
    if (row.field_name !== null) {
      value.secrets[row.field_name] = {
        configured: true,
        lastRotatedAt: toIso(row.rotated_at),
      };
    }
    byId.set(row.id, value);
    grouped.set(row.channel_type, byId);
  }
  return Object.fromEntries(
    CHANNEL_TYPES.map((type) => {
      const candidates = [...(grouped.get(type)?.values() ?? [])];
      if (candidates.length > 1) throw ambiguousConnection();
      return [
        type,
        candidates[0]
          ? snapshotFromRow(candidates[0].row, candidates[0].secrets)
          : virtualSnapshot(type),
      ];
    }),
  ) as AdminChannelConfigCollection;
}

function virtualSnapshot(type: ChannelType): AdminChannelConfigSnapshot {
  const manifest = getChannelManifest(type);
  const parsed = manifest.configSchema.parse({});
  const config = { ...parsed };
  delete config.enabled;
  for (const secretField of manifest.secretFields) delete config[secretField];
  return {
    type,
    enabled: false,
    revision: 0,
    config,
    secrets: Object.fromEntries(
      manifest.secretFields.map((fieldName) => [
        fieldName,
        { configured: false, lastRotatedAt: null },
      ]),
    ),
    health: { status: "disabled", detail: {} },
  };
}

function snapshotFromRow(
  row: ConnectionRow,
  configuredSecrets: Readonly<Record<string, AdminChannelSecretStatus>>,
): AdminChannelConfigSnapshot {
  const manifest = getChannelManifest(row.channel_type);
  const parsed = manifest.configSchema.parse({
    ...row.config,
    enabled: row.enabled,
  });
  const config = { ...parsed };
  const lastConnectedAt = toIso(row.last_connected_at ?? null);
  const lastDisconnectedAt = toIso(row.last_disconnected_at ?? null);
  const lastEventAt = toIso(row.last_event_at ?? null);
  delete config.enabled;
  for (const secretField of manifest.secretFields) delete config[secretField];
  return {
    type: row.channel_type,
    enabled: row.enabled,
    revision: Number(row.revision),
    config,
    secrets: Object.fromEntries(
      manifest.secretFields.map((fieldName) => [
        fieldName,
        configuredSecrets[fieldName] ?? {
          configured: false,
          lastRotatedAt: null,
        },
      ]),
    ),
    health: {
      status: row.health_status,
      detail: row.health_detail,
      ...(lastConnectedAt ? { lastConnectedAt } : {}),
      ...(lastDisconnectedAt ? { lastDisconnectedAt } : {}),
      ...(lastEventAt ? { lastEventAt } : {}),
    },
  };
}

async function lockCanonicalType(
  client: PoolClient,
  input: PreparedWrite,
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended($1, 0)
     )`,
    [`${input.scope.userId}:${input.scope.agentId}:${input.type}`],
  );
}

async function lockActiveConnections(
  client: PoolClient,
  input: PreparedWrite,
): Promise<ConnectionRow[]> {
  const result = await client.query<ConnectionRow>(
    `SELECT id, user_id, agent_id, channel_type, enabled, config,
            revision, health_status, health_detail
     FROM channel_connections
     WHERE user_id = $1
       AND agent_id = $2
       AND channel_type = $3
       AND deleted_at IS NULL
     ORDER BY created_at
     LIMIT 2
     FOR UPDATE`,
    [input.scope.userId, input.scope.agentId, input.type],
  );
  return result.rows;
}

async function validatePublicConfigSecrets(
  input: PreparedWrite,
  exposure: UserCredentialExposureState,
  newPlaintextValues: readonly string[],
  key: ChannelSecretsKey,
): Promise<void> {
  if (
    containsSecretExposure(input.config, [
      ...exposure.plaintextValues,
      ...newPlaintextValues,
    ])
    || containsSecretFingerprintExposure(
      input.config,
      exposure.fingerprints,
      key,
    )
  ) {
    throw new AdminChannelConfigError(
      400,
      "secret_in_public_config",
    );
  }
}

async function insertConnection(
  client: PoolClient,
  input: PreparedWrite,
): Promise<ConnectionRow> {
  const health = intendedHealth(input.enabled);
  const result = await client.query<ConnectionRow>(
    `INSERT INTO channel_connections (
       user_id, agent_id, channel_type, display_name, enabled,
       config, revision, health_status, health_detail
     )
     VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8)
     RETURNING id, user_id, agent_id, channel_type, enabled, config,
               revision, health_status, health_detail`,
    [
      input.scope.userId,
      input.scope.agentId,
      input.type,
      getChannelManifest(input.type).label,
      input.enabled,
      input.config,
      health.status,
      health.detail,
    ],
  );
  const row = result.rows[0];
  if (!row) throw updateFailed();
  return row;
}

async function updateConnection(
  client: PoolClient,
  before: ConnectionRow,
  input: PreparedWrite,
): Promise<ConnectionRow> {
  const health = intendedHealth(input.enabled);
  const result = await client.query<ConnectionRow>(
    `UPDATE channel_connections
     SET enabled = $4,
         config = $5,
         revision = revision + 1,
         health_status = $6,
         health_detail = $7,
         updated_at = now()
     WHERE id = $1
       AND user_id = $2
       AND agent_id = $3
       AND revision = $8
       AND deleted_at IS NULL
     RETURNING id, user_id, agent_id, channel_type, enabled, config,
               revision, health_status, health_detail`,
    [
      before.id,
      input.scope.userId,
      input.scope.agentId,
      input.enabled,
      input.config,
      health.status,
      health.detail,
      input.expectedRevision,
    ],
  );
  const row = result.rows[0];
  if (!row) throw revisionConflict();
  return row;
}

async function applySecrets(
  client: PoolClient,
  connection: ConnectionRow,
  input: PreparedWrite,
  key: ChannelSecretsKey,
  signal: AbortSignal,
): Promise<void> {
  for (const change of input.secretChanges) {
    if (change.operation === "delete") {
      await client.query(
        `DELETE FROM channel_secrets
         WHERE connection_id = $1 AND field_name = $2`,
        [connection.id, change.fieldName],
      );
    } else {
      await rememberSecretExposureFingerprint(
        client,
        input.scope.userId,
        connection.id,
        change.fieldName,
        change.value,
        key,
      );
      signal.throwIfAborted();
      const encrypted = key.encrypt(change.value, {
        userId: input.scope.userId,
        agentId: input.scope.agentId,
        connectionId: connection.id,
        fieldName: change.fieldName,
      });
      const storage = encrypted.toStorageRecord();
      await client.query(
        `INSERT INTO channel_secrets (
           connection_id, field_name, ciphertext, nonce, auth_tag,
           key_version, rotated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (connection_id, field_name) DO UPDATE
         SET ciphertext = EXCLUDED.ciphertext,
             nonce = EXCLUDED.nonce,
             auth_tag = EXCLUDED.auth_tag,
             key_version = EXCLUDED.key_version,
             rotated_at = now()`,
        [
          connection.id,
          change.fieldName,
          storage.ciphertext,
          storage.nonce,
          storage.authTag,
          storage.keyVersion,
        ],
      );
    }
    signal.throwIfAborted();
  }
}

function preparedSecretValues(
  inputs: readonly PreparedWrite[],
): string[] {
  return inputs.flatMap((input) =>
    input.secretChanges.flatMap((change) =>
      change.operation === "set" ? [change.value] : []
    )
  );
}

async function readSnapshot(
  client: PoolClient,
  connection: ConnectionRow,
): Promise<AdminChannelConfigSnapshot> {
  const result = await client.query<{
    field_name: string;
    rotated_at: Date | string;
  }>(
    `SELECT field_name, rotated_at
     FROM channel_secrets
     WHERE connection_id = $1
       AND field_name = ANY($2::text[])`,
    [connection.id, getChannelManifest(connection.channel_type).secretFields],
  );
  return snapshotFromRow(
    connection,
    Object.fromEntries(
      result.rows.map((row) => [
        row.field_name,
        { configured: true, lastRotatedAt: toIso(row.rotated_at) },
      ]),
    ),
  );
}

async function insertAudit(
  client: PoolClient,
  input: PreparedWrite,
  connection: ConnectionRow,
  beforeSnapshot: AdminChannelConfigSnapshot,
  snapshot: AdminChannelConfigSnapshot,
  action: "channel_connection.create" | "channel_connection.update",
): Promise<void> {
  await client.query(
    `INSERT INTO admin_audit_logs (
       user_id, agent_id, action, resource_type, resource_id,
       before_summary, after_summary, confirmation_source,
       status, error_code
     )
     VALUES (
       $1, $2, $3, 'channel_connection', $4,
       $5, $6, $7, 'success', NULL
     )`,
    [
      input.scope.userId,
      input.scope.agentId,
      action,
      connection.id,
      auditSummary(beforeSnapshot),
      auditSummary(snapshot),
      {
        type: input.confirmationSource ?? "console",
        requestId: input.operationId,
        inputFingerprint: input.fingerprint,
      },
    ],
  );
}

async function recoverInTransaction(
  client: PoolClient,
  input: PreparedWrite,
): Promise<AdminChannelConfigSnapshot | null> {
  const audit = await client.query<{
    resource_id: string;
    input_fingerprint: string | null;
    revision: string;
  }>(
    `SELECT resource_id,
            confirmation_source->>'inputFingerprint' AS input_fingerprint,
            after_summary->>'revision' AS revision
     FROM admin_audit_logs
     WHERE user_id = $1
       AND agent_id = $2
       AND resource_type = 'channel_connection'
       AND status = 'success'
       AND confirmation_source->>'type' = $5
       AND confirmation_source->>'requestId' = $3
       AND after_summary->>'channel_type' = $4
     ORDER BY created_at DESC
     LIMIT 1`,
    [
      input.scope.userId,
      input.scope.agentId,
      input.operationId,
      input.type,
      input.confirmationSource ?? "console",
    ],
  );
  const row = audit.rows[0];
  if (!row) return null;
  if (
    row.input_fingerprint !== input.fingerprint ||
    Number(row.revision) !== input.expectedRevision + 1
  ) {
    throw new AdminChannelConfigError(409, "operation_id_reused");
  }
  const connection = await readCanonicalById(client, input, row.resource_id);
  if (!connection) throw updateFailed();
  if (connection.revision !== input.expectedRevision + 1) {
    throw revisionConflict();
  }
  return readSnapshot(client, connection);
}

function auditSummary(
  snapshot: AdminChannelConfigSnapshot,
): Record<string, unknown> {
  return {
    revision: snapshot.revision,
    channel_type: snapshot.type,
    enabled: snapshot.enabled,
    config: snapshot.config,
    secrets: Object.fromEntries(
      Object.entries(snapshot.secrets).map(([name, state]) => [
        name,
        { configured: state.configured },
      ]),
    ),
  };
}

async function readCanonicalById(
  client: PoolClient,
  input: PreparedWrite,
  id: string,
): Promise<ConnectionRow | null> {
  const result = await client.query<ConnectionRow>(
    `SELECT id, user_id, agent_id, channel_type, enabled, config,
            revision, health_status, health_detail
     FROM channel_connections
     WHERE id = $1
       AND user_id = $2
       AND agent_id = $3
       AND channel_type = $4
       AND deleted_at IS NULL`,
    [id, input.scope.userId, input.scope.agentId, input.type],
  );
  return result.rows[0] ?? null;
}

async function recoverCommittedUpdate(
  pool: Pool,
  input: PreparedWrite,
): Promise<AdminChannelConfigSnapshot | null> {
  const lifecycle = createLifecycle(RECOVERY_TIMEOUT_MS);
  let client: PoolClient | undefined;
  let guard: AbortablePoolClientGuard | undefined;
  let transactionState:
    | "none"
    | "starting"
    | "active"
    | "committing"
    | "finished" = "none";
  try {
    client = await connectPoolClient(pool, lifecycle.signal);
    guard = guardPoolClientWithAbort(client, lifecycle.signal);
    transactionState = "starting";
    await client.query("BEGIN");
    transactionState = "active";
    await setTimeouts(client, RECOVERY_TIMEOUT_MS);
    const recovered = await recoverInTransaction(client, input);
    transactionState = "committing";
    await client.query("COMMIT");
    transactionState = "finished";
    return recovered;
  } catch {
    if (client && guard && !guard.destroyed) {
      if (transactionState === "active") {
        if (!await rollbackChannelTransaction(client)) guard.destroy();
      } else if (
        transactionState === "starting"
        || transactionState === "committing"
      ) {
        guard.destroy();
      }
    }
    return null;
  } finally {
    lifecycle.dispose();
    guard?.dispose();
    if (client && guard?.destroyed !== true) client.release();
  }
}

async function recoverCommittedBatch(
  pool: Pool,
  inputs: readonly PreparedWrite[],
): Promise<AdminChannelConfigCollection | null> {
  const lifecycle = createLifecycle(RECOVERY_TIMEOUT_MS);
  let client: PoolClient | undefined;
  let guard: AbortablePoolClientGuard | undefined;
  let transactionState:
    | "none"
    | "starting"
    | "active"
    | "committing"
    | "finished" = "none";
  try {
    client = await connectPoolClient(pool, lifecycle.signal);
    guard = guardPoolClientWithAbort(client, lifecycle.signal);
    transactionState = "starting";
    await client.query("BEGIN");
    transactionState = "active";
    await setTimeouts(client, RECOVERY_TIMEOUT_MS);
    const snapshots = new Map<
      ChannelType,
      AdminChannelConfigSnapshot
    >();
    for (const input of inputs) {
      const recovered = await recoverInTransaction(client, input);
      if (!recovered) {
        if (!await rollbackChannelTransaction(client)) {
          guard.destroy();
        }
        transactionState = "finished";
        return null;
      }
      snapshots.set(input.type, recovered);
    }
    transactionState = "committing";
    await client.query("COMMIT");
    transactionState = "finished";
    return collectionFromSnapshots(snapshots);
  } catch {
    if (client && guard && !guard.destroyed) {
      if (transactionState === "active") {
        if (!await rollbackChannelTransaction(client)) guard.destroy();
      } else if (
        transactionState === "starting"
        || transactionState === "committing"
      ) {
        guard.destroy();
      }
    }
    return null;
  } finally {
    lifecycle.dispose();
    guard?.dispose();
    if (client && guard?.destroyed !== true) client.release();
  }
}

async function setTimeouts(
  client: PoolClient,
  lifecycleTimeoutMs: number,
): Promise<void> {
  const statement = Math.max(1, lifecycleTimeoutMs - 1);
  const lock = Math.min(10_000, statement);
  await client.query(`SET LOCAL lock_timeout = '${lock}ms'`);
  await client.query(`SET LOCAL statement_timeout = '${statement}ms'`);
}

async function rollbackChannelTransaction(
  client: PoolClient,
): Promise<boolean> {
  try {
    await client.query("ROLLBACK");
    return true;
  } catch {
    return false;
  }
}

function intendedHealth(enabled: boolean): {
  status: "starting" | "disabled";
  detail: Record<string, unknown>;
} {
  return enabled
    ? {
        status: "starting",
        detail: {},
      }
    : { status: "disabled", detail: {} };
}

async function notifyConfigChanged(
  client: PoolClient,
  connection: ConnectionRow,
): Promise<void> {
  await client.query(
    "SELECT pg_notify('channel_config_changed', $1)",
    [
      JSON.stringify({
        connection_id: connection.id,
        revision: Number(connection.revision),
      }),
    ],
  );
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

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function ambiguousConnection(): AdminChannelConfigError {
  return new AdminChannelConfigError(409, "channel_connection_ambiguous");
}

function revisionConflict(): AdminChannelConfigError {
  return new AdminChannelConfigError(409, "config_revision_conflict");
}

function updateFailed(): AdminChannelConfigError {
  return new AdminChannelConfigError(500, "channel_config_update_failed");
}

function classifyFailure(
  error: unknown,
  fallbackCode: string,
  signal: AbortSignal,
): unknown {
  if (error instanceof AdminChannelConfigError) return error;
  if (signal.aborted || isTimeoutError(error)) {
    return new AdminChannelConfigError(500, fallbackCode);
  }
  return error;
}

function isTimeoutError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = Reflect.get(error, "code");
  return code === "55P03" || code === "57014";
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_TIMEOUT_MS
  ) {
    throw new Error("invalid_channel_config_lifecycle_timeout");
  }
  return value;
}

function createLifecycle(
  timeoutMs: number,
  outerSignal?: AbortSignal,
): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new Error("channel_config_aborted"));
    }
  };
  if (outerSignal?.aborted) abort();
  else outerSignal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, timeoutMs);
  timeout.unref?.();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      outerSignal?.removeEventListener("abort", abort);
    },
  };
}
