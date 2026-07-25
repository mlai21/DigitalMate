import { createHash } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type { AgentScope } from "@/server/agents/types";

import type {
  InboundAttachmentDescriptor,
  NormalizedChannelEvent,
  PermissionEnvelope,
} from "./types";

const DEFAULT_EVENT_LEASE_MS = 60_000;
type Queryable = Pick<Pool | PoolClient, "query">;

type ChannelEventStatus =
  | "pending_attachments"
  | "accepted"
  | "running"
  | "completed"
  | "failed";

type ChannelEventRow = {
  id: string;
  user_id: string;
  agent_id: string;
  connection_id: string;
  normalized_payload: StoredNormalizedEvent;
  permission_envelope: PermissionEnvelope;
  reply_handle_required: boolean;
  client_turn_id: string;
  payload_hash: string;
  status: ChannelEventStatus;
  claim_owner: string | null;
  claim_expires_at: Date | null;
  attempts: number;
  failure_code: string | null;
  assistant_message_id: string | null;
  occurred_at: Date;
  received_at: Date;
  completed_at: Date | null;
};

type StoredNormalizedEvent = Omit<
  NormalizedChannelEvent,
  "attachments" | "occurredAt" | "permission" | "receivedAt" | "replyHandle"
> & {
  attachments: readonly Omit<InboundAttachmentDescriptor, "source">[];
  occurredAt: string;
  receivedAt: string;
};

export type ChannelEventRecord = Readonly<{
  id: string;
  scope: AgentScope;
  connectionId: string;
  normalizedEvent: NormalizedChannelEvent;
  clientTurnId: string;
  payloadHash: string;
  status: ChannelEventStatus;
  claimOwner: string | null;
  claimExpiresAt: Date | null;
  attempts: number;
  failureCode: string | null;
  assistantMessageId: string | null;
  completedAt: Date | null;
}>;

export type ClaimedChannelEvent = ChannelEventRecord & Readonly<{
  status: "running";
  claimOwner: string;
  claimExpiresAt: Date;
}>;

export type ChannelEventRepositoryOptions = Readonly<{
  leaseMs?: number;
}>;

export type AcceptChannelEventOptions = Readonly<{
  initialStatus:
    | "pending_attachments"
    | "accepted"
    | "failed";
  failureCode: string | null;
}>;

export function channelClientTurnId(
  connectionId: string,
  externalEventId: string,
): string {
  const bytes = createHash("sha256")
    .update(`${connectionId}\0${externalEventId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export function createChannelEventRepository(
  pool: Queryable,
  options: ChannelEventRepositoryOptions = {},
) {
  const leaseMs = positiveLease(options.leaseMs ?? DEFAULT_EVENT_LEASE_MS);

  return {
    leaseDurationMs: leaseMs,

    async accept(
      scope: AgentScope,
      event: NormalizedChannelEvent,
      acceptOptions: AcceptChannelEventOptions = {
        initialStatus: "accepted",
        failureCode: null,
      },
    ): Promise<{
      created: boolean;
      event: ChannelEventRecord;
    }> {
      if (event.agentId !== scope.agentId) {
        throw new Error("channel_event_agent_scope_mismatch");
      }
      assertAcceptOptions(acceptOptions);

      const clientTurnId = channelClientTurnId(
        event.connectionId,
        event.externalEventId,
      );
      const stored = toStoredNormalizedEvent(event);
      const replyHandleRequired = event.replyHandle !== undefined;
      const payloadHash = eventPayloadHash(
        stored,
        event.permission,
        replyHandleRequired,
      );
      const inserted = await pool.query<ChannelEventRow>(
        `INSERT INTO channel_inbound_events (
           user_id, agent_id, connection_id, channel_type,
           external_event_id, external_conversation_id,
           external_sender_id, chat_type, normalized_payload,
           permission_envelope, reply_handle_required,
           client_turn_id, payload_hash,
           status, failure_code, occurred_at, received_at,
           completed_at
         )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8,
           $9::jsonb, $10::jsonb, $11, $12, $13, $14,
           $15, $16, $17, $18
         )
         ON CONFLICT (connection_id, external_event_id) DO NOTHING
         RETURNING *`,
        [
          scope.userId,
          scope.agentId,
          event.connectionId,
          event.channelType,
          event.externalEventId,
          event.externalConversationId,
          event.externalSenderId,
          event.chatType,
          JSON.stringify(stored),
          JSON.stringify(event.permission),
          replyHandleRequired,
          clientTurnId,
          payloadHash,
          acceptOptions.initialStatus,
          acceptOptions.failureCode,
          event.occurredAt,
          event.receivedAt,
          acceptOptions.initialStatus === "failed"
            ? event.receivedAt
            : null,
        ],
      );

      if (inserted.rows[0]) {
        return {
          created: true,
          event: mapEventRow(inserted.rows[0]),
        };
      }

      const existing = await pool.query<ChannelEventRow>(
        `SELECT *
         FROM channel_inbound_events
         WHERE connection_id = $1
           AND external_event_id = $2`,
        [event.connectionId, event.externalEventId],
      );
      const row = existing.rows[0];
      if (!row) {
        throw new Error("channel_event_conflict_not_visible");
      }
      if (
        row.user_id !== scope.userId
        || row.agent_id !== scope.agentId
      ) {
        throw new Error("channel_event_scope_mismatch");
      }
      if (
        (
          row.payload_hash !== payloadHash
          && eventPayloadHash(
            row.normalized_payload,
            row.permission_envelope,
            row.reply_handle_required,
          ) !== payloadHash
        )
        || row.client_turn_id !== clientTurnId
        || row.reply_handle_required !== replyHandleRequired
      ) {
        throw new Error("channel_event_payload_conflict");
      }

      return {
        created: false,
        event: mapEventRow(row),
      };
    },

    async claimNext(
      owner: string,
      now = new Date(),
    ): Promise<ClaimedChannelEvent | null> {
      assertOwner(owner);
      const result = await pool.query<ChannelEventRow>(
        `WITH candidate AS (
           SELECT id
           FROM channel_inbound_events
           WHERE (
             status = 'accepted'
             OR (
                status = 'running'
                AND claim_expires_at <= $1
              )
           )
             AND (
               reply_handle_required = false
               OR EXISTS (
                 SELECT 1
                 FROM channel_reply_handles AS handle
                 WHERE handle.event_id =
                   channel_inbound_events.id
               )
             )
           ORDER BY received_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE channel_inbound_events AS event
         SET status = 'running',
             claim_owner = $2,
             claim_expires_at =
               $1 + ($3::integer * interval '1 millisecond'),
             attempts = event.attempts + 1,
             updated_at = $1
         FROM candidate
         WHERE event.id = candidate.id
         RETURNING event.*`,
        [now, owner, leaseMs],
      );
      const row = result.rows[0];
      return row ? asClaim(mapEventRow(row)) : null;
    },

    async markAttachmentsReady(
      scope: AgentScope,
      eventId: string,
      now = new Date(),
    ): Promise<boolean> {
      const result = await pool.query(
        `UPDATE channel_inbound_events AS event
         SET status = 'accepted',
             updated_at = $3
         WHERE event.id = $1
           AND event.user_id = $2
           AND event.agent_id = $4
           AND event.status = 'pending_attachments'
           AND jsonb_array_length(
             event.normalized_payload->'attachments'
           ) > 0
           AND (
             SELECT count(*)
             FROM channel_event_attachments AS attachment
             WHERE attachment.event_id = event.id
               AND attachment.user_id = event.user_id
               AND attachment.agent_id = event.agent_id
           ) = jsonb_array_length(
             event.normalized_payload->'attachments'
           )
           AND NOT EXISTS (
             SELECT 1
             FROM channel_event_attachments AS attachment
             WHERE attachment.event_id = event.id
               AND attachment.user_id = event.user_id
               AND attachment.agent_id = event.agent_id
               AND attachment.private_attachment_id IS NULL
           )`,
        [eventId, scope.userId, now, scope.agentId],
      );
      return result.rowCount === 1;
    },

    async complete(
      claim: ClaimedChannelEvent,
      assistantMessageId: string | null,
      now = new Date(),
    ): Promise<boolean> {
      const result = await pool.query(
        `UPDATE channel_inbound_events
         SET status = 'completed',
             assistant_message_id = $3,
             claim_owner = NULL,
             claim_expires_at = NULL,
             completed_at = $4,
             updated_at = $4
         WHERE id = $1
           AND claim_owner = $2
           AND status = 'running'
           AND claim_expires_at > $4`,
        [claim.id, claim.claimOwner, assistantMessageId, now],
      );
      return result.rowCount === 1;
    },

    async fail(
      claim: ClaimedChannelEvent,
      failureCode: string,
      now = new Date(),
    ): Promise<boolean> {
      const result = await pool.query(
        `UPDATE channel_inbound_events
         SET status = 'failed',
             failure_code = $3,
             claim_owner = NULL,
             claim_expires_at = NULL,
             completed_at = $4,
             updated_at = $4
         WHERE id = $1
           AND claim_owner = $2
           AND status = 'running'
           AND claim_expires_at > $4`,
        [claim.id, claim.claimOwner, failureCode, now],
      );
      return result.rowCount === 1;
    },

    async renew(
      claim: ClaimedChannelEvent,
      now = new Date(),
    ): Promise<Date | null> {
      const result = await pool.query<{ claim_expires_at: Date }>(
        `UPDATE channel_inbound_events
         SET claim_expires_at =
               $3 + ($4::integer * interval '1 millisecond'),
             updated_at = $3
         WHERE id = $1
           AND claim_owner = $2
           AND status = 'running'
           AND claim_expires_at > $3
         RETURNING claim_expires_at`,
        [claim.id, claim.claimOwner, now, leaseMs],
      );
      return result.rows[0]?.claim_expires_at ?? null;
    },
  };
}

function toStoredNormalizedEvent(
  event: NormalizedChannelEvent,
): StoredNormalizedEvent {
  return {
    connectionId: event.connectionId,
    agentId: event.agentId,
    channelType: event.channelType,
    externalEventId: event.externalEventId,
    externalConversationId: event.externalConversationId,
    externalSenderId: event.externalSenderId,
    chatType: event.chatType,
    mentioned: event.mentioned,
    text: event.text,
    thread: event.thread,
    attachments: event.attachments.map((attachment) => ({
      externalAttachmentId: attachment.externalAttachmentId,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    })),
    occurredAt: event.occurredAt.toISOString(),
    receivedAt: event.receivedAt.toISOString(),
    rawSummary: event.rawSummary,
  };
}

function mapEventRow(row: ChannelEventRow): ChannelEventRecord {
  return {
    id: row.id,
    scope: {
      userId: row.user_id,
      agentId: row.agent_id,
    },
    connectionId: row.connection_id,
    normalizedEvent: {
      ...row.normalized_payload,
      attachments: row.normalized_payload.attachments.map(
        (attachment) => ({ ...attachment, source: {} }),
      ),
      occurredAt: new Date(row.occurred_at),
      receivedAt: new Date(row.received_at),
      permission: row.permission_envelope,
    },
    clientTurnId: row.client_turn_id,
    payloadHash: row.payload_hash,
    status: row.status,
    claimOwner: row.claim_owner,
    claimExpiresAt: nullableDate(row.claim_expires_at),
    attempts: row.attempts,
    failureCode: row.failure_code,
    assistantMessageId: row.assistant_message_id,
    completedAt: nullableDate(row.completed_at),
  };
}

function asClaim(event: ChannelEventRecord): ClaimedChannelEvent {
  if (
    event.status !== "running"
    || !event.claimOwner
    || !event.claimExpiresAt
  ) {
    throw new Error("channel_event_claim_invalid");
  }
  return {
    ...event,
    status: "running",
    claimOwner: event.claimOwner,
    claimExpiresAt: event.claimExpiresAt,
  };
}

function hashCanonical(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function eventPayloadHash(
  stored: StoredNormalizedEvent,
  permission: PermissionEnvelope,
  replyHandleRequired: boolean,
): string {
  const {
    receivedAt: _localReceiptTime,
    ...stableEvent
  } = stored;
  void _localReceiptTime;
  if (stored.channelType === "xiaoyi") {
    const {
      occurredAt: _localOccurrenceTime,
      rawSummary,
      ...stableXiaoYiEvent
    } = stableEvent;
    const {
      serverName: _deliveryRoute,
      ...stableRawSummary
    } = rawSummary;
    void _localOccurrenceTime;
    void _deliveryRoute;
    return hashCanonical({
      normalizedEvent: {
        ...stableXiaoYiEvent,
        rawSummary: stableRawSummary,
      },
      permission,
      replyHandleRequired,
    });
  }
  return hashCanonical({
    normalizedEvent: stableEvent,
    permission,
    replyHandleRequired,
  });
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

function nullableDate(value: Date | string | null): Date | null {
  return value === null ? null : new Date(value);
}

function positiveLease(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > 86_400_000) {
    throw new Error("channel_event_lease_invalid");
  }
  return value;
}

function assertOwner(owner: string): void {
  if (owner.trim().length === 0 || owner.length > 256) {
    throw new Error("channel_event_claim_owner_invalid");
  }
}

function assertAcceptOptions(options: AcceptChannelEventOptions): void {
  if (
    options.initialStatus === "accepted"
    && options.failureCode !== null
  ) {
    throw new Error("channel_event_failure_code_unexpected");
  }
  if (
    options.initialStatus === "failed"
    && (
      options.failureCode === null
      || options.failureCode.trim().length === 0
      || options.failureCode.length > 256
    )
  ) {
    throw new Error("channel_event_failure_code_invalid");
  }
}
