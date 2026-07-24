import type { Pool, PoolClient } from "pg";

import type { AgentScope } from "@/server/agents/types";
import type {
  ChannelSecretsKey,
  EncryptedSecret,
} from "@/server/security/encrypted-secret";

type JsonObject = Record<string, unknown>;

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

type ChannelConnectionRow = {
  id: string;
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
};

type PreparedSecretChange =
  | Readonly<{
      fieldName: string;
      operation: "set";
      encrypted: EncryptedSecret;
    }>
  | Readonly<{
      fieldName: string;
      operation: "delete";
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
) {
  return {
    async update(
      input: ChannelConnectionConfigUpdate,
    ): Promise<ChannelConnectionConfigUpdateResult> {
      const prepared = prepareUpdate(input, secretKey);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const before = await lockConnection(client, input);
        if (
          before === null ||
          before.revision !== input.expectedRevision
        ) {
          throw revisionConflict();
        }

        const beforeConfiguredSecrets = await readConfiguredSecretFields(
          client,
          before.id,
          prepared.secretFieldNames,
        );
        const updated = await updateConnection(
          client,
          input,
          prepared.config,
        );
        if (updated === null) throw revisionConflict();
        await applySecretChanges(
          client,
          before.id,
          prepared.secretChanges,
        );
        const afterConfiguredSecrets = applyConfiguredChanges(
          beforeConfiguredSecrets,
          prepared.secretChanges,
        );
        await insertSuccessAudit(client, input, prepared, {
          before,
          updated,
          beforeConfiguredSecrets,
          afterConfiguredSecrets,
        });
        await client.query("COMMIT");
        return { revision: updated.revision };
      } catch (caught) {
        await rollbackPreservingOriginalError(client);
        throw caught;
      } finally {
        client.release();
      }
    },
  };
}

async function lockConnection(
  client: PoolClient,
  input: ChannelConnectionConfigUpdate,
): Promise<ChannelConnectionRow | null> {
  const result = await client.query<ChannelConnectionRow>(
    `SELECT id, channel_type, display_name, enabled, config, revision
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
     RETURNING id, channel_type, display_name, enabled, config, revision`,
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

async function readConfiguredSecretFields(
  client: PoolClient,
  connectionId: string,
  secretFieldNames: readonly string[],
): Promise<ReadonlySet<string>> {
  if (secretFieldNames.length === 0) return new Set();
  const result = await client.query<{ field_name: string }>(
    `SELECT field_name
     FROM channel_secrets
     WHERE connection_id = $1
       AND field_name = ANY($2::text[])`,
    [connectionId, secretFieldNames],
  );
  return new Set(result.rows.map((row) => row.field_name));
}

async function applySecretChanges(
  client: PoolClient,
  connectionId: string,
  changes: readonly PreparedSecretChange[],
): Promise<void> {
  for (const change of changes) {
    if (change.operation === "delete") {
      await client.query(
        `DELETE FROM channel_secrets
         WHERE connection_id = $1
           AND field_name = $2`,
        [connectionId, change.fieldName],
      );
      continue;
    }
    const storage = change.encrypted.toStorageRecord();
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
        connectionId,
        change.fieldName,
        storage.ciphertext,
        storage.nonce,
        storage.authTag,
        storage.keyVersion,
      ],
    );
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
      prepared.confirmationSource ?? null,
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
  secretKey: ChannelSecretsKey,
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
      secretValues.push(change.value);
      return {
        fieldName: change.fieldName,
        operation: "set",
        encrypted: secretKey.encrypt(change.value),
      };
    },
  );
  const configText = JSON.stringify(config);
  if (
    secretValues.some(
      (secret) =>
        configText.includes(secret) ||
        auditConfigFields.includes(secret),
    )
  ) {
    throw new AdminAuditError(400, "secret_in_public_config");
  }
  return {
    config,
    secretFieldNames,
    secretChanges,
    auditConfigFields,
    confirmationSource: validateConfirmationSource(
      input.confirmationSource,
    ),
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

async function rollbackPreservingOriginalError(
  client: PoolClient,
): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The original operation error is the useful and safely classified error.
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
