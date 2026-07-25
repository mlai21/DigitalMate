import type { Pool, PoolClient } from "pg";

import type { AgentScope } from "@/server/agents/types";

import type { ChannelRecipient } from "./types";

const DEFAULT_DELIVERY_LEASE_MS = 30_000;
type Queryable = Pick<Pool | PoolClient, "query">;

type DeliveryStatus =
  | "queued"
  | "running"
  | "retry"
  | "waiting_node"
  | "sent"
  | "dead_letter"
  | "cancelled";

type DeliveryRow = {
  id: string;
  user_id: string;
  agent_id: string;
  event_id: string;
  connection_id: string;
  assistant_message_id: string;
  reply_handle_id: string | null;
  body: string;
  recipient: ChannelRecipient;
  status: DeliveryStatus;
  claim_owner: string | null;
  claim_expires_at: Date | null;
  attempts: number;
  next_attempt_at: Date;
  last_error_code: string | null;
  sent_at: Date | null;
};

export type ChannelDeliveryRecord = Readonly<{
  id: string;
  scope: AgentScope;
  eventId: string;
  connectionId: string;
  assistantMessageId: string;
  replyHandleId: string | null;
  body: string;
  recipient: ChannelRecipient;
  status: DeliveryStatus;
  claimOwner: string | null;
  claimExpiresAt: Date | null;
  attempts: number;
  nextAttemptAt: Date;
  lastErrorCode: string | null;
  sentAt: Date | null;
}>;

export type ClaimedChannelDelivery = ChannelDeliveryRecord & Readonly<{
  status: "running";
  claimOwner: string;
  claimExpiresAt: Date;
}>;

export type EnqueueChannelDeliveryInput = Readonly<{
  scope: AgentScope;
  eventId: string;
  connectionId: string;
  assistantMessageId: string;
  replyHandleId?: string;
  body: string;
  recipient: ChannelRecipient;
}>;

export function createChannelDeliveryRepository(
  pool: Queryable,
  options: Readonly<{ leaseMs?: number }> = {},
) {
  const leaseMs = validateLease(
    options.leaseMs ?? DEFAULT_DELIVERY_LEASE_MS,
  );

  return {
    async enqueue(
      input: EnqueueChannelDeliveryInput,
    ): Promise<{
      created: boolean;
      delivery: ChannelDeliveryRecord;
    }> {
      const inserted = await pool.query<DeliveryRow>(
        `INSERT INTO channel_deliveries (
           user_id, agent_id, event_id, connection_id,
           assistant_message_id, reply_handle_id, body, recipient
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          input.scope.userId,
          input.scope.agentId,
          input.eventId,
          input.connectionId,
          input.assistantMessageId,
          input.replyHandleId ?? null,
          input.body,
          JSON.stringify(input.recipient),
        ],
      );
      if (inserted.rows[0]) {
        return {
          created: true,
          delivery: mapDeliveryRow(inserted.rows[0]),
        };
      }

      const existing = await pool.query<DeliveryRow>(
        `SELECT *
         FROM channel_deliveries
         WHERE connection_id = $1
           AND assistant_message_id = $2`,
        [input.connectionId, input.assistantMessageId],
      );
      const row = existing.rows[0];
      if (!row) {
        throw new Error("channel_delivery_conflict_not_visible");
      }
      if (
        row.user_id !== input.scope.userId
        || row.agent_id !== input.scope.agentId
      ) {
        throw new Error("channel_delivery_scope_mismatch");
      }
      if (
        row.event_id !== input.eventId
        || row.body !== input.body
        || !sameRecipient(row.recipient, input.recipient)
      ) {
        throw new Error("channel_delivery_payload_conflict");
      }
      return {
        created: false,
        delivery: mapDeliveryRow(row),
      };
    },

    async claimNext(
      owner: string,
      now = new Date(),
    ): Promise<ClaimedChannelDelivery | null> {
      assertOwner(owner);
      const result = await pool.query<DeliveryRow>(
        `WITH candidate AS (
           SELECT id
           FROM channel_deliveries
           WHERE (
             status IN ('queued', 'retry')
             AND next_attempt_at <= $1
           )
           OR (
             status = 'running'
             AND claim_expires_at <= $1
           )
           ORDER BY next_attempt_at, created_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE channel_deliveries AS delivery
         SET status = 'running',
             claim_owner = $2,
             claim_expires_at =
               $1 + ($3::integer * interval '1 millisecond'),
             attempts = delivery.attempts + 1,
             updated_at = $1
         FROM candidate
         WHERE delivery.id = candidate.id
         RETURNING delivery.*`,
        [now, owner, leaseMs],
      );
      const row = result.rows[0];
      return row ? asClaim(mapDeliveryRow(row)) : null;
    },

    async markSent(
      claim: ClaimedChannelDelivery,
      now = new Date(),
    ): Promise<boolean> {
      return finishClaim(
        pool,
        claim,
        "sent",
        null,
        now,
      );
    },

    async scheduleRetry(
      claim: ClaimedChannelDelivery,
      nextAttemptAt: Date,
      errorCode: string,
      now = new Date(),
    ): Promise<boolean> {
      const result = await pool.query(
        `UPDATE channel_deliveries
         SET status = 'retry',
             claim_owner = NULL,
             claim_expires_at = NULL,
             next_attempt_at = $3,
             last_error_code = $4,
             updated_at = $5
         WHERE id = $1
           AND claim_owner = $2
           AND status = 'running'
           AND claim_expires_at > $5`,
        [
          claim.id,
          claim.claimOwner,
          nextAttemptAt,
          errorCode,
          now,
        ],
      );
      return result.rowCount === 1;
    },

    async deadLetter(
      claim: ClaimedChannelDelivery,
      errorCode: string,
      now = new Date(),
    ): Promise<boolean> {
      return finishClaim(
        pool,
        claim,
        "dead_letter",
        errorCode,
        now,
      );
    },

    async requeue(
      scope: AgentScope,
      deliveryId: string,
      now = new Date(),
    ): Promise<boolean> {
      const result = await pool.query(
        `UPDATE channel_deliveries
         SET status = 'queued',
             claim_owner = NULL,
             claim_expires_at = NULL,
             next_attempt_at = $4,
             last_error_code = NULL,
             updated_at = $4
         WHERE id = $1
           AND user_id = $2
           AND agent_id = $3
           AND status = 'dead_letter'`,
        [deliveryId, scope.userId, scope.agentId, now],
      );
      return result.rowCount === 1;
    },
  };
}

async function finishClaim(
  pool: Queryable,
  claim: ClaimedChannelDelivery,
  status: "sent" | "dead_letter",
  errorCode: string | null,
  now: Date,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE channel_deliveries
     SET status = $3,
         claim_owner = NULL,
         claim_expires_at = NULL,
         last_error_code = $4,
         sent_at = CASE WHEN $3 = 'sent' THEN $5 ELSE sent_at END,
         updated_at = $5
     WHERE id = $1
       AND claim_owner = $2
       AND status = 'running'
       AND claim_expires_at > $5`,
    [claim.id, claim.claimOwner, status, errorCode, now],
  );
  return result.rowCount === 1;
}

function mapDeliveryRow(row: DeliveryRow): ChannelDeliveryRecord {
  return {
    id: row.id,
    scope: {
      userId: row.user_id,
      agentId: row.agent_id,
    },
    eventId: row.event_id,
    connectionId: row.connection_id,
    assistantMessageId: row.assistant_message_id,
    replyHandleId: row.reply_handle_id,
    body: row.body,
    recipient: row.recipient,
    status: row.status,
    claimOwner: row.claim_owner,
    claimExpiresAt: nullableDate(row.claim_expires_at),
    attempts: row.attempts,
    nextAttemptAt: new Date(row.next_attempt_at),
    lastErrorCode: row.last_error_code,
    sentAt: nullableDate(row.sent_at),
  };
}

function asClaim(
  delivery: ChannelDeliveryRecord,
): ClaimedChannelDelivery {
  if (
    delivery.status !== "running"
    || !delivery.claimOwner
    || !delivery.claimExpiresAt
  ) {
    throw new Error("channel_delivery_claim_invalid");
  }
  return {
    ...delivery,
    status: "running",
    claimOwner: delivery.claimOwner,
    claimExpiresAt: delivery.claimExpiresAt,
  };
}

function nullableDate(value: Date | string | null): Date | null {
  return value === null ? null : new Date(value);
}

function validateLease(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > 86_400_000) {
    throw new Error("channel_delivery_lease_invalid");
  }
  return value;
}

function assertOwner(owner: string): void {
  if (owner.trim().length === 0 || owner.length > 256) {
    throw new Error("channel_delivery_claim_owner_invalid");
  }
}

function sameRecipient(
  left: ChannelRecipient,
  right: ChannelRecipient,
): boolean {
  return (
    left.externalConversationId === right.externalConversationId
    && left.externalThreadId === right.externalThreadId
    && left.externalUserId === right.externalUserId
  );
}
