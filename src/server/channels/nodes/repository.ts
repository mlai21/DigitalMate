import { timingSafeEqual } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type { AgentScope } from "@/server/agents/types";
import type { ChannelType } from "@/server/channels/manifests/catalog";

import {
  NODE_MAX_FRAME_BYTES,
  NODE_PROTOCOL_VERSION,
  parseNodeFrame,
  type NodeInboundAckFrame,
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

export type RecordChannelNodeInboundAckInput = Readonly<{
  userId: string;
  nodeId: string;
  connectionId: string;
  clientSequence: number;
  externalEventId: string;
  disposition: NodeInboundAckFrame["disposition"];
  eventId?: string;
  frameDigest: Buffer;
  sentAt: Date;
}>;

export type ReplayChannelNodeInboundAckInput = Readonly<{
  userId: string;
  nodeId: string;
  clientSequence: number;
  frameDigest: Buffer;
  sentAt: Date;
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
    async findByCertificateFingerprint(
      fingerprint: Buffer,
    ): Promise<{
      id: string;
      userId: string;
      status: "connected" | "disconnected" | "revoked";
      certificateFingerprint: Buffer;
    } | null> {
      if (fingerprint.length !== 32) {
        throw new Error("node_certificate_fingerprint_invalid");
      }
      const result = await pool.query<{
        id: string;
        user_id: string;
        status: "connected" | "disconnected" | "revoked";
        certificate_fingerprint: Buffer;
      }>(
        `SELECT id, user_id, status, certificate_fingerprint
         FROM channel_runtime_nodes
         WHERE certificate_fingerprint = $1`,
        [fingerprint],
      );
      const row = result.rows[0];
      return result.rows.length === 1 && row
        ? {
            id: row.id,
            userId: row.user_id,
            status: row.status,
            certificateFingerprint: row.certificate_fingerprint,
          }
        : null;
    },

    async listBoundConnectionIds(
      userId: string,
      nodeId: string,
    ): Promise<string[]> {
      const result = await pool.query<{ connection_id: string }>(
        `SELECT connection_id
         FROM channel_node_bindings
         WHERE user_id = $1
           AND node_id = $2
         ORDER BY connection_id ASC`,
        [userId, nodeId],
      );
      return result.rows.map((row) => row.connection_id);
    },

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

    async allocateServerSequence(
      userId: string,
      nodeId: string,
    ): Promise<number> {
      const result = await pool.query<{
        last_server_sequence: number | string;
      }>(
        `UPDATE channel_runtime_nodes
         SET last_server_sequence = last_server_sequence + 1,
             updated_at = now()
         WHERE id = $1
           AND user_id = $2
           AND status <> 'revoked'
           AND last_server_sequence
             < ${Number.MAX_SAFE_INTEGER}
         RETURNING last_server_sequence`,
        [nodeId, userId],
      );
      const row = result.rows[0];
      if (!row) {
        await throwNodeServerSequenceFailure(
          pool,
          userId,
          nodeId,
        );
      }
      const sequence = Number(row.last_server_sequence);
      assertNodeSequence(sequence);
      return sequence;
    },

    async assertSequenceAvailable(
      userId: string,
      nodeId: string,
      sequence: number,
    ): Promise<void> {
      assertNodeSequence(sequence);
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
      if (Number(node.last_sequence) >= sequence) {
        throw new Error("node_sequence_replayed");
      }
    },

    async replayInboundAck(
      input: ReplayChannelNodeInboundAckInput,
    ): Promise<NodeInboundAckFrame | null> {
      assertNodeSequence(input.clientSequence);
      assertFrameDigest(input.frameDigest);
      assertDate(input.sentAt, "node_ack_time_invalid");
      const client = await pool.connect();
      let destroyClient = false;
      try {
        await client.query("BEGIN");
        const node = await lockActiveNode(client, input);
        const receipt = await readInboundReceipt(
          client,
          input.userId,
          input.nodeId,
          input.clientSequence,
        );
        if (!receipt) {
          await client.query("COMMIT");
          return null;
        }
        assertInboundFrameDigest(
          receipt.frameDigest,
          input.frameDigest,
        );
        const replayed = await persistReplayedAck(
          client,
          input,
          node.lastServerSequence,
          receipt.ack,
        );
        await client.query("COMMIT");
        return replayed;
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

    async recordInboundAck(
      input: RecordChannelNodeInboundAckInput,
    ): Promise<NodeInboundAckFrame> {
      assertNodeSequence(input.clientSequence);
      assertFrameDigest(input.frameDigest);
      assertDate(input.sentAt, "node_ack_time_invalid");
      const client = await pool.connect();
      let destroyClient = false;
      try {
        await client.query("BEGIN");
        const nodeResult = await client.query<{
          status: "connected" | "disconnected" | "revoked";
          last_sequence: number | string;
          last_server_sequence: number | string;
        }>(
          `SELECT status, last_sequence, last_server_sequence
           FROM channel_runtime_nodes
           WHERE id = $1
             AND user_id = $2
           FOR UPDATE`,
          [input.nodeId, input.userId],
        );
        const node = nodeResult.rows[0];
        if (!node) throw new Error("channel_node_not_found");
        if (node.status === "revoked") {
          throw new Error("channel_node_revoked");
        }
        const existing = await readInboundReceipt(
          client,
          input.userId,
          input.nodeId,
          input.clientSequence,
        );
        if (existing) {
          assertInboundAckInputMatches(existing.ack, input);
          assertInboundFrameDigest(
            existing.frameDigest,
            input.frameDigest,
          );
          const replayed = await persistReplayedAck(
            client,
            input,
            Number(node.last_server_sequence),
            existing.ack,
          );
          await client.query("COMMIT");
          return replayed;
        }
        if (Number(node.last_sequence) >= input.clientSequence) {
          throw new Error("node_sequence_replayed");
        }
        const serverSequence =
          Number(node.last_server_sequence) + 1;
        assertNodeSequence(serverSequence);
        const frame = parseNodeFrame({
          type: "inbound_ack",
          protocolVersion: NODE_PROTOCOL_VERSION,
          nodeId: input.nodeId,
          sequence: serverSequence,
          sentAt: input.sentAt.toISOString(),
          connectionId: input.connectionId,
          externalEventId: input.externalEventId,
          disposition: input.disposition,
          ...(input.eventId ? { eventId: input.eventId } : {}),
        });
        if (frame.type !== "inbound_ack") {
          throw new Error("node_inbound_ack_invalid");
        }
        const updated = await client.query(
          `UPDATE channel_runtime_nodes
           SET last_sequence = $3,
               last_server_sequence = $4,
               updated_at = $5
           WHERE id = $1
             AND user_id = $2
             AND status <> 'revoked'`,
          [
            input.nodeId,
            input.userId,
            input.clientSequence,
            serverSequence,
            input.sentAt,
          ],
        );
        if (updated.rowCount !== 1) {
          throw new Error("channel_node_revoked");
        }
        await client.query(
          `INSERT INTO channel_node_inbound_receipts (
             user_id, node_id, connection_id,
             client_sequence, external_event_id,
             frame_digest, ack, created_at
           )
           VALUES (
             $1, $2, $3, $4, $5, $6, $7::jsonb, $8
           )`,
          [
            input.userId,
            input.nodeId,
            input.connectionId,
            input.clientSequence,
            input.externalEventId,
            input.frameDigest,
            JSON.stringify(frame),
            input.sentAt,
          ],
        );
        await client.query("COMMIT");
        return frame;
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

    async subscribeToRevocations(
      listener: (nodeId: string) => void,
    ): Promise<() => Promise<void>> {
      const reconnectDelaysMs = [100, 500, 1_000, 5_000, 10_000];
      let stopped = false;
      let reconnectAttempt = 0;
      let reconnectTimer:
        | ReturnType<typeof setTimeout>
        | undefined;
      let reconnecting: Promise<void> | undefined;
      let current:
        | Readonly<{
            client: PoolClient;
            dispose(destroy: boolean): void;
          }>
        | undefined;

      const scheduleReconnect = () => {
        if (stopped || reconnectTimer || reconnecting) return;
        const delay = reconnectDelaysMs[
          Math.min(
            reconnectAttempt,
            reconnectDelaysMs.length - 1,
          )
        ];
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = undefined;
          reconnecting = establish()
            .catch(() => {
              scheduleReconnect();
            })
            .finally(() => {
              reconnecting = undefined;
              if (!current) scheduleReconnect();
            });
        }, delay);
        reconnectTimer.unref();
      };

      const onConnectionLost = (
        connection: NonNullable<typeof current>,
      ) => {
        if (current !== connection) return;
        current = undefined;
        connection.dispose(true);
        scheduleReconnect();
      };

      async function establish(): Promise<void> {
        if (stopped) return;
        const client = await pool.connect();
        let disposed = false;
        let connection:
          | NonNullable<typeof current>
          | undefined;
        const onNotification = (
          notification: Readonly<{
            channel: string;
            payload?: string;
          }>,
        ) => {
          if (
            notification.channel
              !== "channel_runtime_node_revoked"
            || !notification.payload
            || !isUuid(notification.payload)
          ) {
            return;
          }
          listener(notification.payload);
        };
        const dispose = (destroy: boolean) => {
          if (disposed) return;
          disposed = true;
          client.removeListener(
            "notification",
            onNotification,
          );
          client.removeListener("error", onError);
          client.removeListener("end", onEnd);
          try {
            client.release(destroy);
          } catch {
            // The broken client may already have left the pool.
          }
        };
        const onError = () => {
          if (connection) onConnectionLost(connection);
        };
        const onEnd = () => {
          if (connection) onConnectionLost(connection);
        };
        client.on("notification", onNotification);
        client.on("error", onError);
        client.on("end", onEnd);
        try {
          await client.query(
            "LISTEN channel_runtime_node_revoked",
          );
          const revoked = await client.query<{ id: string }>(
            `SELECT id
             FROM channel_runtime_nodes
             WHERE status = 'revoked'
             ORDER BY id ASC`,
          );
          for (const row of revoked.rows) {
            if (isUuid(row.id)) listener(row.id);
          }
          if (stopped) {
            dispose(true);
            return;
          }
          connection = { client, dispose };
          current = connection;
          reconnectAttempt = 0;
        } catch (error) {
          dispose(true);
          throw error;
        }
      }

      await establish();
      return async () => {
        if (stopped) return;
        stopped = true;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = undefined;
        }
        await reconnecting?.catch(() => undefined);
        const connection = current;
        current = undefined;
        if (!connection) return;
        let destroy = false;
        try {
          await connection.client.query(
            "UNLISTEN channel_runtime_node_revoked",
          );
        } catch {
          destroy = true;
        }
        connection.dispose(destroy);
      };
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
          last_server_sequence: number | string;
        }>(
          `SELECT status, last_heartbeat_at,
                  last_server_sequence
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
        const nextSequence =
          Number(nodeRow.last_server_sequence) + 1;
        assertNodeSequence(nextSequence);
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

        const sequenceUpdated = await client.query(
          `UPDATE channel_runtime_nodes
           SET last_server_sequence = $3,
               updated_at = $4
           WHERE id = $1
             AND user_id = $2
             AND status <> 'revoked'`,
          [
            input.nodeId,
            input.scope.userId,
            nextSequence,
            now,
          ],
        );
        if (sequenceUpdated.rowCount !== 1) {
          throw new Error("channel_node_revoked");
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

async function throwNodeServerSequenceFailure(
  pool: Queryable,
  userId: string,
  nodeId: string,
): Promise<never> {
  const result = await pool.query<{
    status: "connected" | "disconnected" | "revoked";
    last_server_sequence: number | string;
  }>(
    `SELECT status, last_server_sequence
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
  if (
    Number(node.last_server_sequence)
      >= Number.MAX_SAFE_INTEGER
  ) {
    throw new Error("node_sequence_exhausted");
  }
  throw new Error("node_sequence_not_allocated");
}

type InboundReceipt = Readonly<{
  ack: NodeInboundAckFrame;
  frameDigest: Buffer;
}>;

async function readInboundReceipt(
  client: Queryable,
  userId: string,
  nodeId: string,
  clientSequence: number,
): Promise<InboundReceipt | null> {
  const result = await client.query<{
    ack: unknown;
    frame_digest: Buffer;
  }>(
    `SELECT receipt.ack, receipt.frame_digest
     FROM channel_node_inbound_receipts AS receipt
     JOIN channel_node_bindings AS binding
       ON binding.connection_id = receipt.connection_id
      AND binding.user_id = receipt.user_id
      AND binding.node_id = receipt.node_id
     WHERE receipt.user_id = $1
       AND receipt.node_id = $2
       AND receipt.client_sequence = $3`,
    [userId, nodeId, clientSequence],
  );
  const row = result.rows[0];
  if (!row) return null;
  const frame = parseNodeFrame(row.ack);
  if (
    frame.type !== "inbound_ack"
    || frame.nodeId !== nodeId
  ) {
    throw new Error("node_inbound_ack_invalid");
  }
  assertFrameDigest(row.frame_digest);
  return {
    ack: frame,
    frameDigest: row.frame_digest,
  };
}

function assertInboundAckInputMatches(
  frame: NodeInboundAckFrame,
  input: RecordChannelNodeInboundAckInput,
): void {
  if (
    frame.connectionId !== input.connectionId
    || frame.externalEventId !== input.externalEventId
  ) {
    throw new Error("node_inbound_replay_mismatch");
  }
}

async function lockActiveNode(
  client: Queryable,
  input: Readonly<{ userId: string; nodeId: string }>,
): Promise<Readonly<{ lastServerSequence: number }>> {
  const result = await client.query<{
    status: "connected" | "disconnected" | "revoked";
    last_server_sequence: number | string;
  }>(
    `SELECT status, last_server_sequence
     FROM channel_runtime_nodes
     WHERE id = $1
       AND user_id = $2
     FOR UPDATE`,
    [input.nodeId, input.userId],
  );
  const node = result.rows[0];
  if (!node) throw new Error("channel_node_not_found");
  if (node.status === "revoked") {
    throw new Error("channel_node_revoked");
  }
  const lastServerSequence = Number(
    node.last_server_sequence,
  );
  assertBoundedInteger(
    lastServerSequence,
    0,
    Number.MAX_SAFE_INTEGER,
    "node_sequence_invalid",
  );
  return { lastServerSequence };
}

async function persistReplayedAck(
  client: Queryable,
  input: Readonly<{
    userId: string;
    nodeId: string;
    clientSequence: number;
    sentAt: Date;
  }>,
  lastServerSequence: number,
  priorAck: NodeInboundAckFrame,
): Promise<NodeInboundAckFrame> {
  const serverSequence = lastServerSequence + 1;
  assertNodeSequence(serverSequence);
  const replayed = parseNodeFrame({
    ...priorAck,
    sequence: serverSequence,
    sentAt: input.sentAt.toISOString(),
  });
  if (replayed.type !== "inbound_ack") {
    throw new Error("node_inbound_ack_invalid");
  }
  const updatedNode = await client.query(
    `UPDATE channel_runtime_nodes
     SET last_server_sequence = $3,
         updated_at = $4
     WHERE id = $1
       AND user_id = $2
       AND status <> 'revoked'`,
    [
      input.nodeId,
      input.userId,
      serverSequence,
      input.sentAt,
    ],
  );
  if (updatedNode.rowCount !== 1) {
    throw new Error("channel_node_revoked");
  }
  const updatedReceipt = await client.query(
    `UPDATE channel_node_inbound_receipts
     SET ack = $4::jsonb
     WHERE user_id = $1
       AND node_id = $2
       AND client_sequence = $3`,
    [
      input.userId,
      input.nodeId,
      input.clientSequence,
      JSON.stringify(replayed),
    ],
  );
  if (updatedReceipt.rowCount !== 1) {
    throw new Error("node_inbound_ack_not_found");
  }
  return replayed;
}

function assertFrameDigest(digest: Buffer): void {
  if (!Buffer.isBuffer(digest) || digest.length !== 32) {
    throw new Error("node_frame_digest_invalid");
  }
}

function assertInboundFrameDigest(
  expected: Buffer,
  actual: Buffer,
): void {
  assertFrameDigest(expected);
  assertFrameDigest(actual);
  if (!timingSafeEqual(expected, actual)) {
    throw new Error("node_inbound_replay_mismatch");
  }
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

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
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
