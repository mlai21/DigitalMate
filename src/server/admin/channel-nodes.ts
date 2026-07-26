import {
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type { AgentScope } from "@/server/agents/types";
import {
  encryptChannelNodeBundle,
  type ChannelNodeCertificateIssuer,
  type IssuedChannelNodeCertificate,
} from "@/server/admin/channel-node-certificates";
import type {
  AdminChannelNodeEnrollment,
  AdminChannelNodeService,
  AdminChannelNodeSummary,
} from "@/server/admin/compat/handlers/nodes";
import type {
  ChannelType,
} from "@/server/channels/manifests/catalog";

const ENROLLMENT_TTL_MS = 10 * 60 * 1_000;
const NODE_CHANNEL_TYPES = new Set<ChannelType>([
  "imessage",
  "sip",
]);

type NodeRow = Readonly<{
  id: string;
  display_name: string;
  status: "connected" | "disconnected" | "revoked";
  supported_channel_types: ChannelType[];
  client_version: string | null;
  certificate_expires_at: Date | string | null;
  last_heartbeat_at: Date | string | null;
  bound_connection_ids: string[] | null;
  pending_items: number | string;
  pending_bytes: number | string;
}>;

export class AdminChannelNodeError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "AdminChannelNodeError";
    this.status = status;
    this.code = code;
  }
}

export function createAdminChannelNodeService(
  pool: Pool,
  options: Readonly<{
    issueCertificate: ChannelNodeCertificateIssuer | null;
    serverCertificateAuthority: string | null;
    serverUrl: string;
    now?: () => Date;
    randomToken?: () => string;
  }>,
): AdminChannelNodeService {
  const now = options.now ?? (() => new Date());
  const randomToken =
    options.randomToken
    ?? (() => randomBytes(32).toString("base64url"));

  return {
    async list(
      scope: AgentScope,
      signal?: AbortSignal,
    ): Promise<readonly AdminChannelNodeSummary[]> {
      signal?.throwIfAborted();
      const result = await pool.query<NodeRow>(
        `SELECT
           node.id,
           node.display_name,
           node.status,
           node.supported_channel_types,
           node.client_version,
           node.certificate_expires_at,
           node.last_heartbeat_at,
           COALESCE(
             (
               SELECT array_agg(
                 binding.connection_id::text
                 ORDER BY binding.connection_id
               )
               FROM channel_node_bindings AS binding
               WHERE binding.user_id = node.user_id
                 AND binding.agent_id = node.agent_id
                 AND binding.node_id = node.id
             ),
             '{}'::text[]
           ) AS bound_connection_ids,
           (
             SELECT count(*)
             FROM channel_node_outbox AS outbox
             WHERE outbox.node_id = node.id
               AND outbox.user_id = node.user_id
               AND outbox.agent_id = node.agent_id
               AND outbox.status = 'pending'
           ) AS pending_items,
           (
             SELECT COALESCE(sum(outbox.size_bytes), 0)
             FROM channel_node_outbox AS outbox
             WHERE outbox.node_id = node.id
               AND outbox.user_id = node.user_id
               AND outbox.agent_id = node.agent_id
               AND outbox.status = 'pending'
           ) AS pending_bytes
         FROM channel_runtime_nodes AS node
         WHERE node.user_id = $1
           AND node.agent_id = $2
         ORDER BY node.created_at ASC, node.id ASC`,
        [scope.userId, scope.agentId],
      );
      signal?.throwIfAborted();
      return result.rows.map(toSummary);
    },

    async createEnrollment(
      input,
      signal,
    ): Promise<AdminChannelNodeEnrollment> {
      assertNodeChannelTypes(input.supportedChannelTypes);
      const connectionIds =
        input.connectionIds
        ?? await resolveConnectionIds(
          pool,
          input.scope,
          input.supportedChannelTypes,
          signal,
        );
      if (connectionIds.length === 0) {
        throw new AdminChannelNodeError(
          409,
          "channel_node_connection_required",
        );
      }
      const createdAt = validNow(now());
      const nodeId = randomUUID();
      const issueCertificate = requireIssuer(
        options.issueCertificate,
      );
      const issued = await issueCertificate({
        nodeId,
        signal,
      });
      signal?.throwIfAborted();
      const token = assertToken(randomToken());
      const expiresAt = new Date(
        createdAt.getTime() + ENROLLMENT_TTL_MS,
      );
      const bundle = await createBundle({
        nodeId,
        connectionIds,
        issued,
        serverCertificateAuthority:
          requireServerCertificateAuthority(
            options.serverCertificateAuthority,
          ),
        serverUrl: options.serverUrl,
        token,
      });
      const enrollmentId = randomUUID();

      await transaction(pool, signal, async (client) => {
        await client.query(
          `INSERT INTO channel_runtime_nodes (
             id, user_id, agent_id, display_name,
             certificate_fingerprint,
             certificate_expires_at,
             supported_channel_types,
             status, created_at, updated_at
           )
           VALUES (
             $1, $2, $3, $4, $5, $6, $7::text[],
             'disconnected', $8, $8
           )`,
          [
            nodeId,
            input.scope.userId,
            input.scope.agentId,
            input.displayName,
            issued.fingerprint,
            issued.expiresAt,
            [...input.supportedChannelTypes],
            createdAt,
          ],
        );
        await bindConnections(
          client,
          input.scope,
          nodeId,
          connectionIds,
          input.supportedChannelTypes,
          createdAt,
        );
        await insertEnrollment(client, {
          id: enrollmentId,
          userId: input.scope.userId,
          nodeId,
          token,
          createdAt,
          expiresAt,
        });
      });
      return {
        enrollment_id: enrollmentId,
        node_id: nodeId,
        token,
        expires_at: expiresAt.toISOString(),
        bundle,
      };
    },

    async bind(input, signal): Promise<void> {
      const updatedAt = validNow(now());
      await transaction(pool, signal, async (client) => {
        const node = await lockNode(
          client,
          input.scope,
          input.nodeId,
        );
        await bindConnections(
          client,
          input.scope,
          input.nodeId,
          [input.connectionId],
          node.supportedChannelTypes,
          updatedAt,
        );
      });
    },

    async unbind(input, signal): Promise<void> {
      const updatedAt = validNow(now());
      await transaction(pool, signal, async (client) => {
        const removed = await client.query(
          `DELETE FROM channel_node_bindings
           WHERE connection_id = $1
             AND user_id = $2
             AND agent_id = $3
             AND node_id = $4`,
          [
            input.connectionId,
            input.scope.userId,
            input.scope.agentId,
            input.nodeId,
          ],
        );
        if (removed.rowCount !== 1) {
          throw new AdminChannelNodeError(
            404,
            "channel_node_binding_not_found",
          );
        }
        await client.query(
          `UPDATE channel_connections
           SET runtime_node_id = NULL,
               updated_at = $4
           WHERE id = $1
             AND user_id = $2
             AND agent_id = $3
             AND runtime_node_id = $5`,
          [
            input.connectionId,
            input.scope.userId,
            input.scope.agentId,
            updatedAt,
            input.nodeId,
          ],
        );
      });
    },

    async rotateCertificate(
      input,
      signal,
    ): Promise<AdminChannelNodeEnrollment> {
      signal?.throwIfAborted();
      const metadata = await readNodeForRotation(
        pool,
        input.scope,
        input.nodeId,
      );
      const issueCertificate = requireIssuer(
        options.issueCertificate,
      );
      const issued = await issueCertificate({
        nodeId: input.nodeId,
        signal,
      });
      signal?.throwIfAborted();
      const createdAt = validNow(now());
      const expiresAt = new Date(
        createdAt.getTime() + ENROLLMENT_TTL_MS,
      );
      const token = assertToken(randomToken());
      const bundle = await createBundle({
        nodeId: input.nodeId,
        connectionIds: metadata.connectionIds,
        issued,
        serverCertificateAuthority:
          requireServerCertificateAuthority(
            options.serverCertificateAuthority,
          ),
        serverUrl: options.serverUrl,
        token,
      });
      const enrollmentId = randomUUID();
      await transaction(pool, signal, async (client) => {
        const updated = await client.query(
          `UPDATE channel_runtime_nodes
           SET certificate_fingerprint = $4,
               certificate_expires_at = $5,
               status = 'disconnected',
               last_heartbeat_at = NULL,
               updated_at = $6
           WHERE id = $1
             AND user_id = $2
             AND agent_id = $7
             AND status <> 'revoked'
             AND certificate_fingerprint = $3`,
          [
            input.nodeId,
            input.scope.userId,
            metadata.fingerprint,
            issued.fingerprint,
            issued.expiresAt,
            createdAt,
            input.scope.agentId,
          ],
        );
        if (updated.rowCount !== 1) {
          throw new AdminChannelNodeError(
            409,
            "channel_node_certificate_conflict",
          );
        }
        await client.query(
          `UPDATE channel_node_enrollments
           SET consumed_at = COALESCE(consumed_at, $3)
           WHERE user_id = $1
             AND node_id = $2
             AND consumed_at IS NULL`,
          [input.scope.userId, input.nodeId, createdAt],
        );
        await insertEnrollment(client, {
          id: enrollmentId,
          userId: input.scope.userId,
          nodeId: input.nodeId,
          token,
          createdAt,
          expiresAt,
        });
      });
      return {
        enrollment_id: enrollmentId,
        node_id: input.nodeId,
        token,
        expires_at: expiresAt.toISOString(),
        bundle,
      };
    },

    async revoke(input, signal): Promise<void> {
      const revokedAt = validNow(now());
      await transaction(pool, signal, async (client) => {
        const revoked = await client.query(
          `UPDATE channel_runtime_nodes
           SET status = 'revoked',
               updated_at = $3
           WHERE id = $1
             AND user_id = $2
             AND agent_id = $4
             AND status <> 'revoked'`,
          [
            input.nodeId,
            input.scope.userId,
            revokedAt,
            input.scope.agentId,
          ],
        );
        if (revoked.rowCount !== 1) {
          const existing = await client.query(
            `SELECT 1
             FROM channel_runtime_nodes
             WHERE id = $1
               AND user_id = $2
               AND agent_id = $3`,
            [
              input.nodeId,
              input.scope.userId,
              input.scope.agentId,
            ],
          );
          if (existing.rowCount !== 1) {
            throw new AdminChannelNodeError(
              404,
              "channel_node_not_found",
            );
          }
        }
        await client.query(
          `UPDATE channel_node_enrollments
           SET consumed_at = COALESCE(consumed_at, $3)
           WHERE user_id = $1
             AND node_id = $2
             AND consumed_at IS NULL`,
          [input.scope.userId, input.nodeId, revokedAt],
        );
      });
    },
  };
}

function toSummary(row: NodeRow): AdminChannelNodeSummary {
  return {
    id: row.id,
    display_name: row.display_name,
    status: row.status,
    supported_channel_types: row.supported_channel_types,
    bound_connection_ids: row.bound_connection_ids ?? [],
    client_version: row.client_version,
    certificate_expires_at: isoOrNull(
      row.certificate_expires_at,
    ),
    last_heartbeat_at: isoOrNull(row.last_heartbeat_at),
    outbox: {
      pending_items: safeCount(row.pending_items),
      pending_bytes: safeCount(row.pending_bytes),
    },
  };
}

async function createBundle(input: Readonly<{
  nodeId: string;
  connectionIds: readonly string[];
  issued: IssuedChannelNodeCertificate;
  serverCertificateAuthority: string;
  serverUrl: string;
  token: string;
}>) {
  return encryptChannelNodeBundle(
    {
      version: 1,
      node: {
        id: input.nodeId,
        server_url: input.serverUrl,
        connection_ids: [...input.connectionIds],
      },
      files: {
        certificate_authority:
          input.serverCertificateAuthority,
        certificate: input.issued.certificate,
        private_key: input.issued.privateKey,
      },
    },
    input.token,
  );
}

async function insertEnrollment(
  client: PoolClient,
  input: Readonly<{
    id: string;
    userId: string;
    nodeId: string;
    token: string;
    createdAt: Date;
    expiresAt: Date;
  }>,
): Promise<void> {
  await client.query(
    `INSERT INTO channel_node_enrollments (
       id, user_id, node_id, token_digest,
       expires_at, created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.id,
      input.userId,
      input.nodeId,
      createHash("sha256").update(input.token).digest(),
      input.expiresAt,
      input.createdAt,
    ],
  );
}

async function bindConnections(
  client: PoolClient,
  scope: AgentScope,
  nodeId: string,
  connectionIds: readonly string[],
  supportedChannelTypes: readonly ChannelType[],
  updatedAt: Date,
): Promise<void> {
  const result = await client.query<{
    id: string;
    channel_type: ChannelType;
  }>(
    `SELECT id, channel_type
     FROM channel_connections
     WHERE id = ANY($1::uuid[])
       AND user_id = $2
       AND agent_id = $3
       AND deleted_at IS NULL
     ORDER BY id
     FOR UPDATE`,
    [[...connectionIds], scope.userId, scope.agentId],
  );
  if (result.rows.length !== connectionIds.length) {
    throw new AdminChannelNodeError(
      404,
      "channel_connection_not_found",
    );
  }
  const supported = new Set(supportedChannelTypes);
  if (
    result.rows.some(
      (connection) => !supported.has(connection.channel_type),
    )
  ) {
    throw new AdminChannelNodeError(
      409,
      "channel_node_type_mismatch",
    );
  }
  for (const connection of result.rows) {
    await client.query(
      `UPDATE channel_connections
       SET runtime_node_id = $1,
           updated_at = $5
       WHERE id = $2
         AND user_id = $3
         AND agent_id = $4`,
      [
        nodeId,
        connection.id,
        scope.userId,
        scope.agentId,
        updatedAt,
      ],
    );
    await client.query(
      `INSERT INTO channel_node_bindings (
         connection_id, user_id, agent_id, node_id,
         created_at
       )
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (connection_id) DO UPDATE
       SET node_id = EXCLUDED.node_id,
           user_id = EXCLUDED.user_id,
           agent_id = EXCLUDED.agent_id`,
      [
        connection.id,
        scope.userId,
        scope.agentId,
        nodeId,
        updatedAt,
      ],
    );
  }
}

async function resolveConnectionIds(
  pool: Pool,
  scope: AgentScope,
  supportedChannelTypes: readonly ChannelType[],
  signal?: AbortSignal,
): Promise<string[]> {
  signal?.throwIfAborted();
  const result = await pool.query<{
    id: string;
    channel_type: ChannelType;
  }>(
    `SELECT id, channel_type
     FROM channel_connections
     WHERE user_id = $1
       AND agent_id = $2
       AND channel_type = ANY($3::text[])
       AND deleted_at IS NULL
     ORDER BY channel_type ASC, updated_at DESC, id ASC`,
    [
      scope.userId,
      scope.agentId,
      [...supportedChannelTypes],
    ],
  );
  signal?.throwIfAborted();
  const selected = new Map<ChannelType, string>();
  for (const row of result.rows) {
    if (!selected.has(row.channel_type)) {
      selected.set(row.channel_type, row.id);
    }
  }
  if (
    supportedChannelTypes.some(
      (type) => !selected.has(type),
    )
  ) {
    throw new AdminChannelNodeError(
      409,
      "channel_node_connection_required",
    );
  }
  return supportedChannelTypes.map(
    (type) => selected.get(type)!,
  );
}

async function lockNode(
  client: PoolClient,
  scope: AgentScope,
  nodeId: string,
): Promise<Readonly<{
  supportedChannelTypes: ChannelType[];
}>> {
  const result = await client.query<{
    supported_channel_types: ChannelType[];
    status: "connected" | "disconnected" | "revoked";
  }>(
    `SELECT supported_channel_types, status
     FROM channel_runtime_nodes
     WHERE id = $1
       AND user_id = $2
       AND agent_id = $3
     FOR UPDATE`,
    [nodeId, scope.userId, scope.agentId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AdminChannelNodeError(
      404,
      "channel_node_not_found",
    );
  }
  if (row.status === "revoked") {
    throw new AdminChannelNodeError(
      409,
      "channel_node_revoked",
    );
  }
  return {
    supportedChannelTypes: row.supported_channel_types,
  };
}

async function readNodeForRotation(
  pool: Pool,
  scope: AgentScope,
  nodeId: string,
): Promise<Readonly<{
  fingerprint: Buffer;
  connectionIds: string[];
}>> {
  const result = await pool.query<{
    certificate_fingerprint: Buffer;
    status: "connected" | "disconnected" | "revoked";
    connection_ids: string[];
  }>(
    `SELECT
       node.certificate_fingerprint,
       node.status,
       COALESCE(
         array_agg(
           binding.connection_id::text
           ORDER BY binding.connection_id
         ) FILTER (WHERE binding.connection_id IS NOT NULL),
         '{}'::text[]
       ) AS connection_ids
     FROM channel_runtime_nodes AS node
     LEFT JOIN channel_node_bindings AS binding
       ON binding.node_id = node.id
      AND binding.user_id = node.user_id
      AND binding.agent_id = node.agent_id
     WHERE node.id = $1
       AND node.user_id = $2
       AND node.agent_id = $3
     GROUP BY node.id`,
    [nodeId, scope.userId, scope.agentId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AdminChannelNodeError(
      404,
      "channel_node_not_found",
    );
  }
  if (row.status === "revoked") {
    throw new AdminChannelNodeError(
      409,
      "channel_node_revoked",
    );
  }
  if (row.connection_ids.length === 0) {
    throw new AdminChannelNodeError(
      409,
      "channel_node_connection_required",
    );
  }
  return {
    fingerprint: row.certificate_fingerprint,
    connectionIds: row.connection_ids,
  };
}

async function transaction<T>(
  pool: Pool,
  signal: AbortSignal | undefined,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const client = await pool.connect();
  let destroy = false;
  try {
    await client.query("BEGIN");
    signal?.throwIfAborted();
    const result = await work(client);
    signal?.throwIfAborted();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      destroy = true;
    }
    throw error;
  } finally {
    client.release(destroy);
  }
}

function assertNodeChannelTypes(
  types: readonly ChannelType[],
): void {
  if (
    types.length === 0
    || new Set(types).size !== types.length
    || types.some((type) => !NODE_CHANNEL_TYPES.has(type))
  ) {
    throw new AdminChannelNodeError(
      400,
      "channel_node_type_invalid",
    );
  }
}

function assertToken(value: string): string {
  if (value.length < 32 || value.length > 256) {
    throw new Error("channel_node_enrollment_token_invalid");
  }
  return value;
}

function requireIssuer(
  issuer: ChannelNodeCertificateIssuer | null,
): ChannelNodeCertificateIssuer {
  if (!issuer) {
    throw new AdminChannelNodeError(
      409,
      "channel_node_enrollment_unavailable",
    );
  }
  return issuer;
}

function requireServerCertificateAuthority(
  certificateAuthority: string | null,
): string {
  if (!certificateAuthority?.trim()) {
    throw new AdminChannelNodeError(
      409,
      "channel_node_enrollment_unavailable",
    );
  }
  return certificateAuthority;
}

function validNow(value: Date): Date {
  if (!Number.isFinite(value.getTime())) {
    throw new Error("channel_node_time_invalid");
  }
  return value;
}

function isoOrNull(
  value: Date | string | null,
): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("channel_node_timestamp_invalid");
  }
  return date.toISOString();
}

function safeCount(value: number | string): number {
  const number = Number(value);
  if (
    !Number.isSafeInteger(number)
    || number < 0
  ) {
    throw new Error("channel_node_count_invalid");
  }
  return number;
}
