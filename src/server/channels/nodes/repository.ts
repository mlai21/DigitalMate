import type { Pool, PoolClient } from "pg";

import type { AgentScope } from "@/server/agents/types";
import type { ChannelType } from "@/server/channels/manifests/catalog";

import {
  NODE_MAX_FRAME_BYTES,
  NODE_PROTOCOL_VERSION,
  parseNodeFrame,
  type NodeSendFrame,
  type NodeSendPayload,
} from "./protocol";

type Queryable = Pick<Pool | PoolClient, "query">;

const NODE_HEARTBEAT_TIMEOUT_MS = 45_000;
const NODE_MAX_OFFLINE_MS = 24 * 60 * 60 * 1_000;
export const NODE_OUTBOX_LIMITS = Object.freeze({
  maxItems: 1_000,
  maxBytes: 50 * 1024 * 1024,
  maxFrameBytes: NODE_MAX_FRAME_BYTES,
});

export type RegisterChannelNodeInput = Readonly<{
  userId: string;
  displayName: string;
  certificateFingerprint: Buffer;
  supportedChannelTypes: readonly ChannelType[];
}>;

export type EnqueueChannelNodeSendInput = Readonly<{
  scope: AgentScope;
  nodeId: string;
  connectionId: string;
  deliveryId: string;
  expiresAt: Date;
  payload: NodeSendPayload;
}>;

export type ChannelNodeOutboxRecord = Readonly<{
  id: string;
  nodeId: string;
  connectionId: string;
  deliveryId: string;
  sequence: number;
  frame: NodeSendFrame;
  sizeBytes: number;
  status: "pending" | "sent" | "failed" | "expired";
  expiresAt: Date;
}>;

type OutboxRow = {
  id: string;
  node_id: string;
  connection_id: string;
  delivery_id: string;
  sequence: number | string;
  frame: unknown;
  size_bytes: number;
  status: "pending" | "sent" | "failed" | "expired";
  expires_at: Date | string;
};

export function createChannelNodeRepository(pool: Pool) {
  return {
    async register(input: RegisterChannelNodeInput): Promise<{
      id: string;
      created: boolean;
    }> {
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO channel_runtime_nodes (
           user_id, display_name, certificate_fingerprint,
           supported_channel_types
         )
         VALUES ($1, $2, $3, $4::text[])
         ON CONFLICT (user_id, certificate_fingerprint) DO NOTHING
         RETURNING id`,
        [
          input.userId,
          input.displayName,
          input.certificateFingerprint,
          [...input.supportedChannelTypes],
        ],
      );
      if (inserted.rows[0]) {
        return { id: inserted.rows[0].id, created: true };
      }
      const existing = await pool.query<{ id: string }>(
        `SELECT id
         FROM channel_runtime_nodes
         WHERE user_id = $1
           AND certificate_fingerprint = $2`,
        [input.userId, input.certificateFingerprint],
      );
      const row = existing.rows[0];
      if (!row) {
        throw new Error("channel_node_conflict_not_visible");
      }
      return { id: row.id, created: false };
    },

    async bindConnection(
      scope: AgentScope,
      nodeId: string,
      connectionId: string,
    ): Promise<void> {
      const client = await pool.connect();
      let destroyClient = false;
      try {
        await client.query("BEGIN");
        await bindConnection(client, scope, nodeId, connectionId);
        await client.query("COMMIT");
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          destroyClient = true;
        }
        throw error;
      } finally {
        client.release(destroyClient);
      }
    },

    async isBound(
      userId: string,
      nodeId: string,
      connectionId: string,
    ): Promise<boolean> {
      const result = await pool.query(
        `SELECT 1
         FROM channel_node_bindings
         WHERE user_id = $1
           AND node_id = $2
           AND connection_id = $3`,
        [userId, nodeId, connectionId],
      );
      return result.rowCount === 1;
    },

    async acceptSequence(
      userId: string,
      nodeId: string,
      sequence: number,
    ): Promise<void> {
      assertNodeSequence(sequence);
      const updated = await pool.query(
        `UPDATE channel_runtime_nodes
         SET last_sequence = $3,
             updated_at = now()
         WHERE id = $1
           AND user_id = $2
           AND status <> 'revoked'
           AND last_sequence < $3`,
        [nodeId, userId, sequence],
      );
      if (updated.rowCount === 1) return;
      await throwNodeSequenceFailure(
        pool,
        userId,
        nodeId,
        sequence,
      );
    },

    async recordHeartbeat(
      userId: string,
      nodeId: string,
      sequence: number,
      receivedAt = new Date(),
    ): Promise<void> {
      assertNodeSequence(sequence);
      assertDate(receivedAt, "node_heartbeat_time_invalid");
      const updated = await pool.query(
        `UPDATE channel_runtime_nodes
         SET last_sequence = $3,
             last_heartbeat_at = $4,
             status = 'connected',
             updated_at = $4
         WHERE id = $1
           AND user_id = $2
           AND status <> 'revoked'
           AND last_sequence < $3`,
        [nodeId, userId, sequence, receivedAt],
      );
      if (updated.rowCount === 1) return;
      await throwNodeSequenceFailure(
        pool,
        userId,
        nodeId,
        sequence,
      );
    },

    async markStaleNodesDisconnected(
      now = new Date(),
    ): Promise<number> {
      assertDate(now, "node_heartbeat_time_invalid");
      const result = await pool.query(
        `UPDATE channel_runtime_nodes
         SET status = 'disconnected',
             updated_at = $1
         WHERE status = 'connected'
           AND (
             last_heartbeat_at IS NULL
             OR last_heartbeat_at
               < $1 - ($2::integer * interval '1 millisecond')
           )`,
        [now, NODE_HEARTBEAT_TIMEOUT_MS],
      );
      return result.rowCount ?? 0;
    },

    async enqueueSend(
      input: EnqueueChannelNodeSendInput,
      now = new Date(),
    ): Promise<
      | Readonly<{
          action: "enqueued";
          created: boolean;
          outbox: ChannelNodeOutboxRecord;
        }>
      | Readonly<{
          action: "waiting";
          reason:
            | "node_offline_too_long"
            | "node_outbox_item_limit"
            | "node_outbox_byte_limit";
        }>
    > {
      assertDate(now, "node_outbox_time_invalid");
      assertDate(input.expiresAt, "node_outbox_expiry_invalid");
      if (
        input.expiresAt <= now
        || input.expiresAt.getTime() - now.getTime()
          > NODE_MAX_OFFLINE_MS
      ) {
        throw new Error("node_outbox_expiry_invalid");
      }
      const client = await pool.connect();
      let destroyClient = false;
      try {
        await client.query("BEGIN");
        const node = await client.query<{
          status: "connected" | "disconnected" | "revoked";
          last_heartbeat_at: Date | string | null;
        }>(
          `SELECT status, last_heartbeat_at
           FROM channel_runtime_nodes
           WHERE id = $1
             AND user_id = $2
           FOR UPDATE`,
          [input.nodeId, input.scope.userId],
        );
        const nodeRow = node.rows[0];
        if (!nodeRow) throw new Error("channel_node_not_found");
        if (nodeRow.status === "revoked") {
          throw new Error("channel_node_revoked");
        }
        await assertConnectionBound(
          client,
          input.scope,
          input.nodeId,
          input.connectionId,
        );
        const existing = await readExistingOutbox(
          client,
          input,
        );
        if (existing) {
          await client.query("COMMIT");
          return {
            action: "enqueued",
            created: false,
            outbox: existing,
          };
        }
        await expireOutbox(client, input.nodeId, now);
        const usage = await readOutboxUsage(
          client,
          input.nodeId,
        );
        const nextSequence = await readNextOutboxSequence(
          client,
          input.nodeId,
        );
        const frame = parseNodeFrame({
          type: "send",
          protocolVersion: NODE_PROTOCOL_VERSION,
          nodeId: input.nodeId,
          sequence: nextSequence,
          sentAt: now.toISOString(),
          connectionId: input.connectionId,
          deliveryId: input.deliveryId,
          expiresAt: input.expiresAt.toISOString(),
          payload: input.payload,
        });
        if (frame.type !== "send") {
          throw new Error("node_send_frame_invalid");
        }
        const sizeBytes = Buffer.byteLength(
          JSON.stringify(frame),
          "utf8",
        );
        const admission = evaluateNodeOutboxAdmission({
          lastHeartbeatAt:
            nodeRow.last_heartbeat_at === null
              ? null
              : new Date(nodeRow.last_heartbeat_at),
          now,
          frameBytes: sizeBytes,
          pendingCount: usage.pendingCount,
          pendingBytes: usage.pendingBytes,
        });
        if (admission.action === "wait") {
          await markDeliveryWaiting(client, input, now);
          await client.query("COMMIT");
          return {
            action: "waiting",
            reason: admission.reason,
          };
        }

        const inserted = await client.query<OutboxRow>(
          `INSERT INTO channel_node_outbox (
             user_id, agent_id, node_id, connection_id,
             delivery_id, sequence, frame, size_bytes,
             expires_at
           )
           VALUES (
             $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9
           )
           RETURNING id, node_id, connection_id, delivery_id,
                     sequence, frame, size_bytes, status, expires_at`,
          [
            input.scope.userId,
            input.scope.agentId,
            input.nodeId,
            input.connectionId,
            input.deliveryId,
            nextSequence,
            JSON.stringify(frame),
            sizeBytes,
            input.expiresAt,
          ],
        );
        await markDeliveryWaiting(client, input, now);
        const insertedRow = inserted.rows[0];
        if (!insertedRow) {
          throw new Error("channel_node_outbox_insert_failed");
        }
        await client.query("COMMIT");
        return {
          action: "enqueued",
          created: true,
          outbox: mapOutboxRow(insertedRow),
        };
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          destroyClient = true;
        }
        throw error;
      } finally {
        client.release(destroyClient);
      }
    },
  };
}

async function bindConnection(
  client: Queryable,
  scope: AgentScope,
  nodeId: string,
  connectionId: string,
): Promise<void> {
  const updated = await client.query(
    `UPDATE channel_connections
     SET runtime_node_id = $1,
         updated_at = now()
     WHERE id = $2
       AND user_id = $3
       AND agent_id = $4`,
    [nodeId, connectionId, scope.userId, scope.agentId],
  );
  if (updated.rowCount !== 1) {
    throw new Error("channel_connection_not_found");
  }
  await client.query(
    `INSERT INTO channel_node_bindings (
       connection_id, user_id, agent_id, node_id
     )
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (connection_id) DO UPDATE
     SET node_id = EXCLUDED.node_id`,
    [connectionId, scope.userId, scope.agentId, nodeId],
  );
}

export type NodeHeartbeatState =
  | "connected"
  | "disconnected"
  | "offline_too_long";

export function classifyNodeHeartbeat(
  lastHeartbeatAt: Date | null,
  now = new Date(),
): NodeHeartbeatState {
  assertDate(now, "node_heartbeat_time_invalid");
  if (lastHeartbeatAt === null) return "offline_too_long";
  assertDate(lastHeartbeatAt, "node_heartbeat_time_invalid");
  const age = Math.max(
    0,
    now.getTime() - lastHeartbeatAt.getTime(),
  );
  if (age <= NODE_HEARTBEAT_TIMEOUT_MS) return "connected";
  if (age > NODE_MAX_OFFLINE_MS) return "offline_too_long";
  return "disconnected";
}

export function evaluateNodeOutboxAdmission(input: Readonly<{
  lastHeartbeatAt: Date | null;
  now: Date;
  frameBytes: number;
  pendingCount: number;
  pendingBytes: number;
}>):
  | Readonly<{ action: "enqueue" }>
  | Readonly<{
      action: "wait";
      reason:
        | "node_offline_too_long"
        | "node_outbox_item_limit"
        | "node_outbox_byte_limit";
    }> {
  assertDate(input.now, "node_outbox_time_invalid");
  assertBoundedInteger(
    input.frameBytes,
    1,
    NODE_OUTBOX_LIMITS.maxFrameBytes,
    "node_frame_size_invalid",
  );
  assertBoundedInteger(
    input.pendingCount,
    0,
    NODE_OUTBOX_LIMITS.maxItems,
    "node_outbox_usage_invalid",
  );
  assertBoundedInteger(
    input.pendingBytes,
    0,
    NODE_OUTBOX_LIMITS.maxBytes,
    "node_outbox_usage_invalid",
  );
  if (
    classifyNodeHeartbeat(
      input.lastHeartbeatAt,
      input.now,
    ) === "offline_too_long"
  ) {
    return {
      action: "wait",
      reason: "node_offline_too_long",
    };
  }
  if (input.pendingCount >= NODE_OUTBOX_LIMITS.maxItems) {
    return {
      action: "wait",
      reason: "node_outbox_item_limit",
    };
  }
  if (
    input.pendingBytes + input.frameBytes
    > NODE_OUTBOX_LIMITS.maxBytes
  ) {
    return {
      action: "wait",
      reason: "node_outbox_byte_limit",
    };
  }
  return { action: "enqueue" };
}

async function throwNodeSequenceFailure(
  pool: Queryable,
  userId: string,
  nodeId: string,
  attemptedSequence: number,
): Promise<never> {
  const result = await pool.query<{
    status: "connected" | "disconnected" | "revoked";
    last_sequence: number | string;
  }>(
    `SELECT status, last_sequence
     FROM channel_runtime_nodes
     WHERE id = $1
       AND user_id = $2`,
    [nodeId, userId],
  );
  const node = result.rows[0];
  if (!node) throw new Error("channel_node_not_found");
  if (node.status === "revoked") {
    throw new Error("channel_node_revoked");
  }
  if (Number(node.last_sequence) >= attemptedSequence) {
    throw new Error("node_sequence_replayed");
  }
  throw new Error("node_sequence_not_accepted");
}

async function readExistingOutbox(
  client: Queryable,
  input: EnqueueChannelNodeSendInput,
): Promise<ChannelNodeOutboxRecord | null> {
  const result = await client.query<OutboxRow>(
    `SELECT id, node_id, connection_id, delivery_id,
            sequence, frame, size_bytes, status, expires_at
     FROM channel_node_outbox
     WHERE delivery_id = $1
       AND user_id = $2
       AND agent_id = $3`,
    [
      input.deliveryId,
      input.scope.userId,
      input.scope.agentId,
    ],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (
    row.node_id !== input.nodeId
    || row.connection_id !== input.connectionId
  ) {
    throw new Error("channel_node_outbox_scope_mismatch");
  }
  return mapOutboxRow(row);
}

async function assertConnectionBound(
  client: Queryable,
  scope: AgentScope,
  nodeId: string,
  connectionId: string,
): Promise<void> {
  const result = await client.query(
    `SELECT 1
     FROM channel_node_bindings
     WHERE user_id = $1
       AND agent_id = $2
       AND node_id = $3
       AND connection_id = $4`,
    [
      scope.userId,
      scope.agentId,
      nodeId,
      connectionId,
    ],
  );
  if (result.rowCount !== 1) {
    throw new Error("node_connection_not_bound");
  }
}

async function expireOutbox(
  client: Queryable,
  nodeId: string,
  now: Date,
): Promise<void> {
  await client.query(
    `UPDATE channel_node_outbox
     SET status = 'expired',
         completed_at = $2
     WHERE node_id = $1
       AND status = 'pending'
       AND expires_at <= $2`,
    [nodeId, now],
  );
}

async function readOutboxUsage(
  client: Queryable,
  nodeId: string,
): Promise<{
  pendingCount: number;
  pendingBytes: number;
}> {
  const result = await client.query<{
    pending_count: number | string;
    pending_bytes: number | string;
  }>(
    `SELECT COUNT(*) AS pending_count,
            COALESCE(SUM(size_bytes), 0) AS pending_bytes
     FROM channel_node_outbox
     WHERE node_id = $1
       AND status = 'pending'`,
    [nodeId],
  );
  const pendingCount = Number(
    result.rows[0]?.pending_count ?? 0,
  );
  const pendingBytes = Number(
    result.rows[0]?.pending_bytes ?? 0,
  );
  assertBoundedInteger(
    pendingCount,
    0,
    NODE_OUTBOX_LIMITS.maxItems,
    "node_outbox_usage_invalid",
  );
  assertBoundedInteger(
    pendingBytes,
    0,
    NODE_OUTBOX_LIMITS.maxBytes,
    "node_outbox_usage_invalid",
  );
  return { pendingCount, pendingBytes };
}

async function readNextOutboxSequence(
  client: Queryable,
  nodeId: string,
): Promise<number> {
  const result = await client.query<{
    last_sequence: number | string;
  }>(
    `SELECT COALESCE(MAX(sequence), 0) AS last_sequence
     FROM channel_node_outbox
     WHERE node_id = $1`,
    [nodeId],
  );
  const next = Number(result.rows[0]?.last_sequence ?? 0) + 1;
  assertNodeSequence(next);
  return next;
}

async function markDeliveryWaiting(
  client: Queryable,
  input: EnqueueChannelNodeSendInput,
  now: Date,
): Promise<void> {
  const result = await client.query(
    `UPDATE channel_deliveries
     SET status = 'waiting_node',
         claim_owner = NULL,
         claim_expires_at = NULL,
         updated_at = $5
     WHERE id = $1
       AND user_id = $2
       AND agent_id = $3
       AND connection_id = $4
       AND status IN (
         'queued', 'running', 'retry', 'waiting_node'
       )`,
    [
      input.deliveryId,
      input.scope.userId,
      input.scope.agentId,
      input.connectionId,
      now,
    ],
  );
  if (result.rowCount !== 1) {
    throw new Error("channel_delivery_not_waitable");
  }
}

function mapOutboxRow(
  row: OutboxRow,
): ChannelNodeOutboxRecord {
  const frame = parseNodeFrame(row.frame);
  if (frame.type !== "send") {
    throw new Error("channel_node_outbox_frame_invalid");
  }
  const sequence = Number(row.sequence);
  assertNodeSequence(sequence);
  assertBoundedInteger(
    row.size_bytes,
    1,
    NODE_OUTBOX_LIMITS.maxFrameBytes,
    "node_frame_size_invalid",
  );
  return {
    id: row.id,
    nodeId: row.node_id,
    connectionId: row.connection_id,
    deliveryId: row.delivery_id,
    sequence,
    frame,
    sizeBytes: row.size_bytes,
    status: row.status,
    expiresAt: new Date(row.expires_at),
  };
}

function assertNodeSequence(value: number): void {
  assertBoundedInteger(
    value,
    1,
    Number.MAX_SAFE_INTEGER,
    "node_sequence_invalid",
  );
}

function assertDate(value: Date, code: string): void {
  if (
    !(value instanceof Date)
    || !Number.isFinite(value.getTime())
  ) {
    throw new Error(code);
  }
}

function assertBoundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  code: string,
): void {
  if (
    !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw new Error(code);
  }
}
