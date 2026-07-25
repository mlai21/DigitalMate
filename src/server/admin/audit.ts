import type { Pool, PoolClient } from "pg";

import type { AgentScope } from "@/server/agents/types";
import {
  containsSecretExposure,
  containsSecretFingerprintExposure,
} from "@/server/admin/secret-content";
import {
  lockUserCredentialExposure,
  readUserCredentialExposureState,
  rememberSecretExposureFingerprint,
} from "@/server/admin/secret-exposure-store";
import {
  connectPoolClient,
  guardPoolClientWithAbort,
  type AbortablePoolClientGuard,
} from "@/server/db/abortable-client";
import {
  validateSecretPlaintext,
  type ChannelSecretsKey,
} from "@/server/security/encrypted-secret";

type JsonObject = Record<string, unknown>;

const COMPATIBILITY_TIMEOUT_MS = 120_000;
const MAX_LIFECYCLE_TIMEOUT_MS = COMPATIBILITY_TIMEOUT_MS - 1;
const DEFAULT_LIFECYCLE_TIMEOUT_MS = 30_000;
const TRANSACTION_LOCK_TIMEOUT_MS = 10_000;
const TRANSACTION_STATEMENT_TIMEOUT_MS = 110_000;
const COMMIT_RECOVERY_TIMEOUT_MS = 3_000;

export type ChannelSecretChange =
  | Readonly<{
      fieldName: string;
      operation: "set";
      value: string;
    }>
  | Readonly<{
      fieldName: string;
      operation: "delete";
    }>;

export type ChannelConfigConfirmationSource = Readonly<{
  type: "console";
  // Task 7 must persist requestId as the operation ID used to recover
  // safely from an ambiguous COMMIT result.
  requestId?: string;
}>;

export type ChannelConnectionConfigUpdate = Readonly<{
  scope: AgentScope;
  connectionId: string;
  expectedRevision: number;
  config: JsonObject;
  secretFieldNames: readonly string[];
  secretChanges: readonly ChannelSecretChange[];
  auditConfigFields: readonly string[];
  confirmationSource?: ChannelConfigConfirmationSource;
}>;

export type ChannelConnectionConfigUpdateResult = Readonly<{
  revision: number;
}>;

export type ChannelConnectionAuditServiceOptions = Readonly<{
  lifecycleTimeoutMs?: number;
}>;

type ChannelConnectionRow = {
  id: string;
  user_id: string;
  agent_id: string;
  channel_type: string;
  display_name: string;
  enabled: boolean;
  config: JsonObject;
  revision: number;
};

type PreparedUpdate = {
  config: JsonObject;
  secretFieldNames: readonly string[];
  secretChanges: readonly PreparedSecretChange[];
  auditConfigFields: readonly string[];
  confirmationSource?: ChannelConfigConfirmationSource;
  operationFingerprint: string;
};

type PreparedSecretChange =
  | Readonly<{
      fieldName: string;
      operation: "set";
      plaintext: string;
    }>
  | Readonly<{
      fieldName: string;
      operation: "delete";
    }>;

type DeclaredSecretState = Readonly<{
  configuredFields: ReadonlySet<string>;
}>;

export class AdminAuditError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "AdminAuditError";
    this.status = status;
    this.code = code;
  }

  toJSON(): Readonly<{
    status: number;
    code: string;
  }> {
    return {
      status: this.status,
      code: this.code,
    };
  }
}

/**
 * Commits a successful connection update and its success audit together.
 * Conflicts and transaction failures leave no audit row: a separately
 * committed failed-attempt log would be best-effort, not atomic with rollback.
 */
export function createChannelConnectionAuditService(
  pool: Pool,
  secretKey: ChannelSecretsKey,
  options: ChannelConnectionAuditServiceOptions = {},
) {
  const lifecycleTimeoutMs = normalizeLifecycleTimeout(
    options.lifecycleTimeoutMs,
  );
  return {
    async update(
      input: ChannelConnectionConfigUpdate,
      outerSignal?: AbortSignal,
    ): Promise<ChannelConnectionConfigUpdateResult> {
      const lifecycle = createBoundedLifecycle(
        lifecycleTimeoutMs,
        outerSignal,
      );
      let client: PoolClient | undefined;
      let clientGuard: AbortablePoolClientGuard | undefined;
      let transactionState:
        | "none"
        | "starting"
        | "active"
        | "committing"
        | "finished" = "none";
      try {
        lifecycle.signal.throwIfAborted();
        const prepared = prepareUpdate(input, secretKey);
        client = await connectPoolClient(pool, lifecycle.signal);
        clientGuard = guardPoolClientWithAbort(
          client,
          lifecycle.signal,
        );
        lifecycle.signal.throwIfAborted();
        transactionState = "starting";
        await client.query("BEGIN");
        transactionState = "active";
        lifecycle.signal.throwIfAborted();
        await setTransactionTimeouts(client);
        lifecycle.signal.throwIfAborted();
        await lockUserCredentialExposure(
          client,
          input.scope.userId,
        );
        lifecycle.signal.throwIfAborted();
        const recovered = await recoverInTransaction(
          client,
          input,
          prepared,
        );
        lifecycle.signal.throwIfAborted();
        if (recovered !== null) {
          transactionState = "committing";
          try {
            await client.query("COMMIT");
            transactionState = "finished";
            lifecycle.signal.throwIfAborted();
            return recovered;
          } catch {
            clientGuard.destroy();
            if (lifecycle.signal.aborted) throw updateFailed();
            return await recoverCommittedUpdate(
              pool,
              input,
              prepared,
            );
          }
        }
        const before = await lockConnection(client, input);
        lifecycle.signal.throwIfAborted();
        if (
          before === null ||
          before.revision !== input.expectedRevision
        ) {
          throw revisionConflict();
        }

        const beforeSecrets = await readDeclaredSecrets(
          client,
          before,
          prepared.secretFieldNames,
        );
        lifecycle.signal.throwIfAborted();
        const exposure = await readUserCredentialExposureState(
          client,
          input.scope.userId,
          secretKey,
        );
        lifecycle.signal.throwIfAborted();
        const newPlaintextValues = prepared.secretChanges.flatMap(
          (change) =>
            change.operation === "set" ? [change.plaintext] : [],
        );
        if (
          containsSecretExposure(
            prepared.config,
            [
              ...exposure.plaintextValues,
              ...newPlaintextValues,
            ],
            prepared.auditConfigFields,
          )
          || containsSecretFingerprintExposure(
            prepared.config,
            exposure.fingerprints,
            secretKey,
            prepared.auditConfigFields,
          )
        ) {
          throw new AdminAuditError(400, "secret_in_public_config");
        }
        const updated = await updateConnection(
          client,
          input,
          prepared.config,
        );
        lifecycle.signal.throwIfAborted();
        if (updated === null) throw revisionConflict();
        await applySecretChanges(
          client,
          before,
          prepared.secretChanges,
          secretKey,
          lifecycle.signal,
        );
        const afterConfiguredSecrets = applyConfiguredChanges(
          beforeSecrets.configuredFields,
          prepared.secretChanges,
        );
        await insertSuccessAudit(client, input, prepared, {
          before,
          updated,
          beforeConfiguredSecrets: beforeSecrets.configuredFields,
          afterConfiguredSecrets,
        });
        lifecycle.signal.throwIfAborted();
        transactionState = "committing";
        try {
          await client.query("COMMIT");
        } catch {
          clientGuard.destroy();
          if (lifecycle.signal.aborted) throw updateFailed();
          return await recoverCommittedUpdate(
            pool,
            input,
            prepared,
          );
        }
        transactionState = "finished";
        lifecycle.signal.throwIfAborted();
        return { revision: updated.revision };
      } catch (caught) {
        if (
          client !== undefined
          && clientGuard !== undefined
          && !clientGuard.destroyed
        ) {
          if (transactionState === "active") {
            const rolledBack = await rollbackTransaction(client);
            if (!rolledBack) clientGuard.destroy();
          } else if (
            transactionState === "starting"
            || transactionState === "committing"
          ) {
            clientGuard.destroy();
          }
        }
        if (
          lifecycle.signal.aborted ||
          isPostgresTimeoutError(caught)
        ) {
          throw updateFailed();
        }
        throw caught;
      } finally {
        lifecycle.dispose();
        clientGuard?.dispose();
        if (client !== undefined && clientGuard?.destroyed !== true) {
          client.release();
        }
      }
    },
  };
}

async function setTransactionTimeouts(
  client: PoolClient,
): Promise<void> {
  await client.query(
    `SET LOCAL lock_timeout = '${TRANSACTION_LOCK_TIMEOUT_MS}ms'`,
  );
  await client.query(
    `SET LOCAL statement_timeout = '${TRANSACTION_STATEMENT_TIMEOUT_MS}ms'`,
  );
}

async function lockConnection(
  client: PoolClient,
  input: ChannelConnectionConfigUpdate,
): Promise<ChannelConnectionRow | null> {
  const result = await client.query<ChannelConnectionRow>(
    `SELECT id, user_id, agent_id, channel_type, display_name,
            enabled, config, revision
     FROM channel_connections
     WHERE id = $1
       AND user_id = $2
       AND agent_id = $3
       AND deleted_at IS NULL
     FOR UPDATE`,
    [
      input.connectionId,
      input.scope.userId,
      input.scope.agentId,
    ],
  );
  return result.rows[0] ?? null;
}

async function recoverInTransaction(
  client: PoolClient,
  input: ChannelConnectionConfigUpdate,
  prepared: PreparedUpdate,
): Promise<ChannelConnectionConfigUpdateResult | null> {
  if (!prepared.confirmationSource?.requestId) return null;
  return readCommittedOperation(client, input, prepared);
}

async function readCommittedOperation(
  client: PoolClient,
  input: ChannelConnectionConfigUpdate,
  prepared: PreparedUpdate,
): Promise<ChannelConnectionConfigUpdateResult | null> {
  const requestId = prepared.confirmationSource?.requestId;
  if (!requestId) return null;
  const audit = await client.query<{
    resource_id: string;
    input_fingerprint: string | null;
    revision: string;
  }>(
    `SELECT resource_id,
            confirmation_source->>'inputFingerprint'
              AS input_fingerprint,
            after_summary->>'revision' AS revision
     FROM admin_audit_logs
     WHERE user_id = $1
       AND agent_id = $2
       AND resource_type = 'channel_connection'
       AND status = 'success'
       AND confirmation_source->>'type' = 'console'
       AND confirmation_source->>'requestId' = $3
     ORDER BY created_at DESC
     LIMIT 1`,
    [
      input.scope.userId,
      input.scope.agentId,
      requestId,
    ],
  );
  const row = audit.rows[0];
  if (!row) return null;
  if (
    row.resource_id !== input.connectionId
    || row.input_fingerprint !== prepared.operationFingerprint
    || Number(row.revision) !== input.expectedRevision + 1
  ) {
    throw operationIdReused();
  }
  const connection = await client.query<{ revision: number }>(
    `SELECT revision
     FROM channel_connections
     WHERE id = $1
       AND user_id = $2
       AND agent_id = $3
       AND deleted_at IS NULL`,
    [
      input.connectionId,
      input.scope.userId,
      input.scope.agentId,
    ],
  );
  const revision = connection.rows[0]?.revision;
  if (revision === undefined) throw updateFailed();
  if (revision !== input.expectedRevision + 1) {
    throw revisionConflict();
  }
  return { revision };
}

async function recoverCommittedUpdate(
  pool: Pool,
  input: ChannelConnectionConfigUpdate,
  prepared: PreparedUpdate,
): Promise<ChannelConnectionConfigUpdateResult> {
  if (!prepared.confirmationSource?.requestId) throw updateFailed();
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error("channel_config_recovery_timeout"));
  }, COMMIT_RECOVERY_TIMEOUT_MS);
  timer.unref?.();
  let client: PoolClient | undefined;
  let guard: AbortablePoolClientGuard | undefined;
  try {
    client = await connectPoolClient(pool, controller.signal);
    guard = guardPoolClientWithAbort(client, controller.signal);
    controller.signal.throwIfAborted();
    const recovered = await readCommittedOperation(
      client,
      input,
      prepared,
    );
    controller.signal.throwIfAborted();
    if (recovered === null) throw updateFailed();
    return recovered;
  } catch (error) {
    if (error instanceof AdminAuditError) throw error;
    guard?.destroy();
    throw updateFailed();
  } finally {
    clearTimeout(timer);
    guard?.dispose();
    if (client && guard?.destroyed !== true) client.release();
  }
}

async function updateConnection(
  client: PoolClient,
  input: ChannelConnectionConfigUpdate,
  config: JsonObject,
): Promise<ChannelConnectionRow | null> {
  const result = await client.query<ChannelConnectionRow>(
    `UPDATE channel_connections
     SET config = $4,
         revision = revision + 1,
         updated_at = now()
     WHERE id = $1
       AND user_id = $2
       AND agent_id = $3
       AND revision = $5
       AND deleted_at IS NULL
     RETURNING id, user_id, agent_id, channel_type, display_name,
               enabled, config, revision`,
    [
      input.connectionId,
      input.scope.userId,
      input.scope.agentId,
      config,
      input.expectedRevision,
    ],
  );
  return result.rows[0] ?? null;
}

async function readDeclaredSecrets(
  client: PoolClient,
  connection: ChannelConnectionRow,
  secretFieldNames: readonly string[],
): Promise<DeclaredSecretState> {
  if (secretFieldNames.length === 0) {
    return {
      configuredFields: new Set(),
    };
  }
  // Task 7 manifests are the authority for the complete secret-field list.
  // Never probe undeclared rows because that would weaken manifest isolation.
  const result = await client.query<{
    field_name: string;
  }>(
    `SELECT field_name
     FROM channel_secrets
     WHERE connection_id = $1
       AND field_name = ANY($2::text[])`,
    [connection.id, secretFieldNames],
  );
  return {
    configuredFields: new Set(
      result.rows.map((row) => row.field_name),
    ),
  };
}

async function applySecretChanges(
  client: PoolClient,
  connection: ChannelConnectionRow,
  changes: readonly PreparedSecretChange[],
  secretKey: ChannelSecretsKey,
  signal: AbortSignal,
): Promise<void> {
  for (const change of changes) {
    if (change.operation === "delete") {
      await client.query(
        `DELETE FROM channel_secrets
         WHERE connection_id = $1
           AND field_name = $2`,
        [connection.id, change.fieldName],
      );
      signal.throwIfAborted();
      continue;
    }
    const encrypted = secretKey.encrypt(change.plaintext, {
      userId: connection.user_id,
      agentId: connection.agent_id,
      connectionId: connection.id,
      fieldName: change.fieldName,
    });
    const storage = encrypted.toStorageRecord();
    await rememberSecretExposureFingerprint(
      client,
      connection.user_id,
      connection.id,
      change.fieldName,
      change.plaintext,
      secretKey,
    );
    signal.throwIfAborted();
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
    signal.throwIfAborted();
  }
}

async function insertSuccessAudit(
  client: PoolClient,
  input: ChannelConnectionConfigUpdate,
  prepared: PreparedUpdate,
  state: {
    before: ChannelConnectionRow;
    updated: ChannelConnectionRow;
    beforeConfiguredSecrets: ReadonlySet<string>;
    afterConfiguredSecrets: ReadonlySet<string>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO admin_audit_logs (
       user_id, agent_id, action, resource_type, resource_id,
       before_summary, after_summary, confirmation_source,
       status, error_code
     )
     VALUES (
       $1, $2, 'channel_connection.update', 'channel_connection', $3,
       $4, $5, $6, 'success', NULL
     )`,
    [
      input.scope.userId,
      input.scope.agentId,
      input.connectionId,
      buildAuditSummary(
        state.before,
        prepared.auditConfigFields,
        prepared.secretFieldNames,
        state.beforeConfiguredSecrets,
      ),
      buildAuditSummary(
        state.updated,
        prepared.auditConfigFields,
        prepared.secretFieldNames,
        state.afterConfiguredSecrets,
      ),
      prepared.confirmationSource?.requestId
        ? {
            ...prepared.confirmationSource,
            inputFingerprint: prepared.operationFingerprint,
          }
        : prepared.confirmationSource ?? null,
    ],
  );
}

function buildAuditSummary(
  connection: ChannelConnectionRow,
  configFields: readonly string[],
  secretFieldNames: readonly string[],
  configuredSecrets: ReadonlySet<string>,
): JsonObject {
  return {
    channel_type: connection.channel_type,
    display_name: connection.display_name,
    enabled: connection.enabled,
    revision: Number(connection.revision),
    config: pickConfig(connection.config, configFields),
    secrets: Object.fromEntries(
      secretFieldNames.map((fieldName) => [
        fieldName,
        { configured: configuredSecrets.has(fieldName) },
      ]),
    ),
  };
}

function prepareUpdate(
  input: ChannelConnectionConfigUpdate,
  key: ChannelSecretsKey,
): PreparedUpdate {
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1
  ) {
    throw new AdminAuditError(400, "invalid_config_revision");
  }
  const secretFieldNames = validateUniqueFieldNames(
    input.secretFieldNames,
    "invalid_secret_field",
  );
  const secretFields = new Set(secretFieldNames);
  const auditConfigFields = validateUniqueFieldNames(
    input.auditConfigFields,
    "invalid_audit_config_field",
  );
  if (auditConfigFields.some((field) => secretFields.has(field))) {
    throw new AdminAuditError(400, "secret_in_audit_config");
  }
  const config = normalizeJsonObject(input.config);
  for (const fieldName of secretFieldNames) {
    if (Object.hasOwn(config, fieldName)) {
      throw new AdminAuditError(400, "secret_in_public_config");
    }
  }
  const seenChanges = new Set<string>();
  const secretValues: string[] = [];
  const secretChanges = input.secretChanges.map(
    (change): PreparedSecretChange => {
      validateFieldName(change.fieldName, "invalid_secret_field");
      if (
        !secretFields.has(change.fieldName) ||
        seenChanges.has(change.fieldName)
      ) {
        throw new AdminAuditError(400, "invalid_secret_change");
      }
      seenChanges.add(change.fieldName);
      if (change.operation === "delete") {
        return {
          fieldName: change.fieldName,
          operation: "delete",
        };
      }
      if (
        change.operation !== "set" ||
        typeof change.value !== "string" ||
        change.value.length === 0
      ) {
        throw new AdminAuditError(400, "invalid_secret_change");
      }
      try {
        validateSecretPlaintext(change.value);
      } catch {
        throw new AdminAuditError(400, "invalid_secret_change");
      }
      secretValues.push(change.value);
      return {
        fieldName: change.fieldName,
        operation: "set",
        plaintext: change.value,
      };
    },
  );
  if (
    containsSecretExposure(
      config,
      secretValues,
      auditConfigFields,
    )
  ) {
    throw new AdminAuditError(400, "secret_in_public_config");
  }
  const confirmationSource = validateConfirmationSource(
    input.confirmationSource,
  );
  const operationFingerprint = key.channelConfigAuditFingerprint(
    stableJson({
      scope: input.scope,
      connectionId: input.connectionId,
      expectedRevision: input.expectedRevision,
      config,
      secretFieldNames,
      secretChanges: secretChanges.map((change) =>
        change.operation === "set"
          ? {
              fieldName: change.fieldName,
              operation: change.operation,
              value: change.plaintext,
            }
          : change
      ),
      auditConfigFields,
    }),
  );
  return {
    config,
    secretFieldNames,
    secretChanges,
    auditConfigFields,
    confirmationSource,
    operationFingerprint,
  };
}

function normalizeJsonObject(value: unknown): JsonObject {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new AdminAuditError(400, "invalid_channel_config");
  }
  try {
    const serialized = JSON.stringify(value);
    const normalized = JSON.parse(serialized) as unknown;
    if (
      typeof normalized !== "object" ||
      normalized === null ||
      Array.isArray(normalized)
    ) {
      throw new Error("not_object");
    }
    return normalized as JsonObject;
  } catch {
    throw new AdminAuditError(400, "invalid_channel_config");
  }
}

function validateConfirmationSource(
  value: ChannelConfigConfirmationSource | undefined,
): ChannelConfigConfirmationSource | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new AdminAuditError(400, "invalid_confirmation_source");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.some((key) => key !== "type" && key !== "requestId") ||
    record.type !== "console" ||
    (
      record.requestId !== undefined &&
      (
        typeof record.requestId !== "string" ||
        !isUuid(record.requestId)
      )
    )
  ) {
    throw new AdminAuditError(400, "invalid_confirmation_source");
  }
  return {
    type: "console",
    ...(
      typeof record.requestId === "string"
        ? { requestId: record.requestId }
        : {}
    ),
  };
}

function validateUniqueFieldNames(
  values: readonly string[],
  errorCode: string,
): readonly string[] {
  if (!Array.isArray(values)) {
    throw new AdminAuditError(400, errorCode);
  }
  const seen = new Set<string>();
  for (const value of values) {
    validateFieldName(value, errorCode);
    if (seen.has(value)) {
      throw new AdminAuditError(400, errorCode);
    }
    seen.add(value);
  }
  return Object.freeze([...values]);
}

function validateFieldName(value: string, errorCode: string): void {
  if (
    typeof value !== "string" ||
    !/^[a-z][a-z0-9_]{0,127}$/.test(value)
  ) {
    throw new AdminAuditError(400, errorCode);
  }
}

function pickConfig(
  config: JsonObject,
  fields: readonly string[],
): JsonObject {
  return Object.fromEntries(
    fields
      .filter((field) => Object.hasOwn(config, field))
      .map((field) => [field, config[field]]),
  );
}

function applyConfiguredChanges(
  before: ReadonlySet<string>,
  changes: readonly PreparedSecretChange[],
): ReadonlySet<string> {
  const after = new Set(before);
  for (const change of changes) {
    if (change.operation === "set") after.add(change.fieldName);
    else after.delete(change.fieldName);
  }
  return after;
}

function revisionConflict(): AdminAuditError {
  return new AdminAuditError(409, "config_revision_conflict");
}

function operationIdReused(): AdminAuditError {
  return new AdminAuditError(409, "operation_id_reused");
}

function updateFailed(): AdminAuditError {
  return new AdminAuditError(500, "channel_config_update_failed");
}

async function rollbackTransaction(
  client: PoolClient,
): Promise<boolean> {
  try {
    await client.query("ROLLBACK");
    return true;
  } catch {
    return false;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((name) =>
        `${JSON.stringify(name)}:${stableJson(record[name])}`
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function normalizeLifecycleTimeout(value: number | undefined): number {
  if (
    value === undefined ||
    !Number.isFinite(value) ||
    value <= 0
  ) {
    return DEFAULT_LIFECYCLE_TIMEOUT_MS;
  }
  return Math.min(
    Math.max(1, Math.trunc(value)),
    MAX_LIFECYCLE_TIMEOUT_MS,
  );
}

function createBoundedLifecycle(
  timeoutMs: number,
  outerSignal?: AbortSignal,
): Readonly<{
  signal: AbortSignal;
  dispose(): void;
}> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (outerSignal?.aborted) {
    abort();
  } else {
    outerSignal?.addEventListener("abort", abort, { once: true });
  }
  const timer = setTimeout(abort, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      outerSignal?.removeEventListener("abort", abort);
    },
  };
}

function isPostgresTimeoutError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "55P03" || code === "57014";
}
