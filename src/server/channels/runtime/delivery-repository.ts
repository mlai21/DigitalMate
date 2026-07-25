import type { Pool, PoolClient } from "pg";

import type { AgentScope } from "@/server/agents/types";

import type {
  ChannelRecipient,
  SendResult,
} from "./types";

const DEFAULT_DELIVERY_LEASE_MS = 30_000;
const MAX_PLATFORM_RESULT_BYTES = 60 * 1024;
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
  attempt_cycle_baseline: number;
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
  attemptCycleBaseline: number;
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

export type DeliverySegmentStart =
  | Readonly<{
      action: "send";
      previousResult: null;
    }>
  | Readonly<{
      action: "already_sent";
      previousResult: SendResult;
    }>
  | Readonly<{
      action: "ambiguous";
      previousResult: null;
    }>;

type DeliveryAttemptRow = {
  attempt_no: number;
  segment_no: number;
  status: "started" | "sent" | "retryable" | "failed";
  platform_result: unknown | null;
};

export function createChannelDeliveryRepository(
  pool: Queryable,
  options: Readonly<{ leaseMs?: number }> = {},
) {
  const leaseMs = validateLease(
    options.leaseMs ?? DEFAULT_DELIVERY_LEASE_MS,
  );

  return {
    leaseDurationMs: leaseMs,

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
        || row.reply_handle_id !== (input.replyHandleId ?? null)
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

    async renew(
      claim: ClaimedChannelDelivery,
      now = new Date(),
    ): Promise<Date | null> {
      const result = await pool.query<{
        claim_expires_at: Date;
      }>(
        `UPDATE channel_deliveries
         SET claim_expires_at =
               $3 + ($4::integer * interval '1 millisecond'),
             updated_at = $3
         WHERE id = $1
           AND claim_owner = $2
           AND status = 'running'
           AND claim_expires_at > $3
         RETURNING claim_expires_at`,
        [
          claim.id,
          claim.claimOwner,
          now,
          leaseMs,
        ],
      );
      return result.rows[0]?.claim_expires_at ?? null;
    },

    async beginSegment(
      claim: ClaimedChannelDelivery,
      segmentNo: number,
      now = new Date(),
    ): Promise<DeliverySegmentStart> {
      assertSegmentNo(segmentNo);
      const previous = await pool.query<DeliveryAttemptRow>(
        `SELECT attempt_no, segment_no, status, platform_result
         FROM channel_delivery_attempts
         WHERE user_id = $1
           AND agent_id = $2
           AND delivery_id = $3
           AND segment_no = $4
         ORDER BY attempt_no DESC`,
        [
          claim.scope.userId,
          claim.scope.agentId,
          claim.id,
          segmentNo,
        ],
      );
      const sent = previous.rows.find(
        (attempt) => attempt.status === "sent",
      );
      if (sent) {
        const result = parseSendResult(sent.platform_result);
        if (!result) {
          throw new Error("channel_delivery_platform_result_invalid");
        }
        return {
          action: "already_sent",
          previousResult: result,
        };
      }
      if (
        previous.rows.some(
          (attempt) => attempt.status === "started",
        )
      ) {
        return {
          action: "ambiguous",
          previousResult: null,
        };
      }

      const inserted = await pool.query(
        `INSERT INTO channel_delivery_attempts (
           user_id, agent_id, delivery_id, attempt_no,
           segment_no, status, started_at
         )
         SELECT $2, $3, delivery.id, $4, $5, 'started', $6
         FROM channel_deliveries AS delivery
         WHERE delivery.id = $1
           AND delivery.user_id = $2
           AND delivery.agent_id = $3
           AND delivery.claim_owner = $7
           AND delivery.status = 'running'
           AND delivery.attempts = $4
           AND delivery.claim_expires_at > $6
         ON CONFLICT (
           delivery_id, attempt_no, segment_no
         ) DO NOTHING
         RETURNING id`,
        [
          claim.id,
          claim.scope.userId,
          claim.scope.agentId,
          claim.attempts,
          segmentNo,
          now,
          claim.claimOwner,
        ],
      );
      if (inserted.rowCount === 1) {
        return {
          action: "send",
          previousResult: null,
        };
      }

      const current = await pool.query<DeliveryAttemptRow>(
        `SELECT attempt_no, segment_no, status, platform_result
         FROM channel_delivery_attempts
         WHERE delivery_id = $1
           AND attempt_no = $2
           AND segment_no = $3`,
        [claim.id, claim.attempts, segmentNo],
      );
      if (current.rows[0]?.status === "sent") {
        const result = parseSendResult(
          current.rows[0].platform_result,
        );
        if (!result) {
          throw new Error("channel_delivery_platform_result_invalid");
        }
        return {
          action: "already_sent",
          previousResult: result,
        };
      }
      if (current.rows[0]?.status === "started") {
        return {
          action: "ambiguous",
          previousResult: null,
        };
      }
      throw new Error("channel_delivery_claim_lost");
    },

    async completeSegment(
      claim: ClaimedChannelDelivery,
      segmentNo: number,
      result: Readonly<{
        status: "sent" | "retryable" | "failed";
        platformResult?: SendResult;
        errorCode?: string;
      }>,
      now = new Date(),
    ): Promise<boolean> {
      assertSegmentNo(segmentNo);
      validateAttemptCompletion(result);
      const platformResult = result.platformResult
        ? serializeSendResult(result.platformResult)
        : null;
      const completed = await pool.query(
        `UPDATE channel_delivery_attempts AS attempt
         SET status = $6,
             platform_result = $7::jsonb,
             error_code = $8,
             completed_at = $9
         WHERE attempt.user_id = $1
           AND attempt.agent_id = $2
           AND attempt.delivery_id = $3
           AND attempt.attempt_no = $4
           AND attempt.segment_no = $5
           AND attempt.status = 'started'
           AND EXISTS (
             SELECT 1
             FROM channel_deliveries AS delivery
             WHERE delivery.id = attempt.delivery_id
               AND delivery.user_id = attempt.user_id
               AND delivery.agent_id = attempt.agent_id
               AND delivery.claim_owner = $10
               AND delivery.status = 'running'
               AND delivery.attempts = attempt.attempt_no
               AND delivery.claim_expires_at > $9
           )`,
        [
          claim.scope.userId,
          claim.scope.agentId,
          claim.id,
          claim.attempts,
          segmentNo,
          result.status,
          platformResult,
          result.errorCode ?? null,
          now,
          claim.claimOwner,
        ],
      );
      return completed.rowCount === 1;
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
      assertErrorCode(errorCode);
      assertDate(now, "channel_delivery_retry_now_invalid");
      assertDate(
        nextAttemptAt,
        "channel_delivery_retry_time_invalid",
      );
      if (nextAttemptAt < now) {
        throw new Error("channel_delivery_retry_time_invalid");
      }
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
      assertErrorCode(errorCode);
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
      assertDate(now, "channel_delivery_requeue_time_invalid");
      const result = await pool.query<{ requeued: boolean }>(
        `WITH requeued AS (
           UPDATE channel_deliveries
           SET status = 'queued',
               claim_owner = NULL,
               claim_expires_at = NULL,
               attempt_cycle_baseline = attempts,
               next_attempt_at = $4,
               last_error_code = NULL,
               updated_at = $4
           WHERE id = $1
             AND user_id = $2
             AND agent_id = $3
             AND status = 'dead_letter'
           RETURNING id, user_id, agent_id
         ),
         resolved_ambiguous AS (
           UPDATE channel_delivery_attempts AS attempt
           SET status = 'failed',
               error_code = 'manual_requeue_override',
               completed_at = $4
           FROM requeued
           WHERE attempt.delivery_id = requeued.id
             AND attempt.user_id = requeued.user_id
             AND attempt.agent_id = requeued.agent_id
             AND attempt.status = 'started'
           RETURNING attempt.id
         )
         SELECT EXISTS (
           SELECT 1 FROM requeued
         ) AS requeued`,
        [deliveryId, scope.userId, scope.agentId, now],
      );
      return result.rows[0]?.requeued === true;
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
    attemptCycleBaseline: row.attempt_cycle_baseline,
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

function assertSegmentNo(value: number): void {
  if (!Number.isInteger(value) || value <= 0 || value > 10_000) {
    throw new Error("channel_delivery_segment_invalid");
  }
}

function validateAttemptCompletion(result: Readonly<{
  status: "sent" | "retryable" | "failed";
  platformResult?: SendResult;
  errorCode?: string;
}>): void {
  if (result.status === "sent") {
    if (!result.platformResult || result.errorCode !== undefined) {
      throw new Error("channel_delivery_attempt_result_invalid");
    }
    return;
  }
  if (
    result.platformResult !== undefined
    || !result.errorCode
  ) {
    throw new Error("channel_delivery_attempt_result_invalid");
  }
  assertErrorCode(result.errorCode);
}

function serializeSendResult(result: SendResult): string {
  if (
    typeof result.externalMessageId !== "string"
    || result.externalMessageId.trim().length === 0
    || result.externalMessageId.length > 1_024
    || !(result.sentAt instanceof Date)
    || !Number.isFinite(result.sentAt.getTime())
    || typeof result.rawSummary !== "object"
    || result.rawSummary === null
    || Array.isArray(result.rawSummary)
  ) {
    throw new Error("channel_delivery_platform_result_invalid");
  }
  const serialized = JSON.stringify({
    externalMessageId: result.externalMessageId,
    sentAt: result.sentAt.toISOString(),
    rawSummary: safeRawSummary(result.rawSummary),
  });
  if (
    Buffer.byteLength(serialized, "utf8")
    > MAX_PLATFORM_RESULT_BYTES
  ) {
    throw new Error("channel_delivery_platform_result_too_large");
  }
  return serialized;
}

function safeRawSummary(
  value: SendResult["rawSummary"],
): SendResult["rawSummary"] {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, nested]) =>
        key.length <= 128
        && !/(?:authorization|cookie|password|secret|signature|token)/i
          .test(key)
        && (
          nested === null
          || typeof nested === "boolean"
          || (
            typeof nested === "number"
            && Number.isFinite(nested)
          )
          || (
            typeof nested === "string"
            && nested.length <= 4_096
          )
        )
      )
      .slice(0, 128),
  ) as SendResult["rawSummary"];
}

function parseSendResult(value: unknown): SendResult | null {
  if (
    typeof value !== "object"
    || value === null
    || !("externalMessageId" in value)
    || typeof value.externalMessageId !== "string"
    || !("sentAt" in value)
    || typeof value.sentAt !== "string"
    || !("rawSummary" in value)
    || typeof value.rawSummary !== "object"
    || value.rawSummary === null
    || Array.isArray(value.rawSummary)
  ) {
    return null;
  }
  const sentAt = new Date(value.sentAt);
  if (
    value.externalMessageId.trim().length === 0
    || value.externalMessageId.length > 1_024
    || !Number.isFinite(sentAt.getTime())
  ) return null;
  return {
    externalMessageId: value.externalMessageId,
    sentAt,
    rawSummary: value.rawSummary as SendResult["rawSummary"],
  };
}

function assertErrorCode(code: string): void {
  if (
    code.trim().length === 0
    || code.length > 128
    || !/^[a-z0-9_:-]+$/i.test(code)
  ) {
    throw new Error("channel_delivery_error_code_invalid");
  }
}

function assertDate(value: Date, code: string): void {
  if (!Number.isFinite(value.getTime())) {
    throw new Error(code);
  }
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
