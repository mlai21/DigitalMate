import type { Pool } from "pg";

import type { AgentScope } from "@/server/agents/types";
import {
  encryptedSecretFromStorage,
  type ChannelSecretsKey,
} from "@/server/security/encrypted-secret";

import type { UnsealedReplyHandle } from "./types";

const MAX_HANDLE_BYTES = 64 * 1024;
const MAX_HANDLE_LEASE_MS = 24 * 60 * 60 * 1_000;
const SECRET_FIELD_NAME = "reply_handle";

type ReplyHandleRow = {
  id: string;
  connection_id: string;
  public_fields: Record<string, string>;
  secret_ciphertext: Buffer;
  secret_nonce: Buffer;
  secret_auth_tag: Buffer;
  key_version: number;
  expires_at: Date | string | null;
};

export function createChannelReplyHandleRepository(
  pool: Pool,
  key: ChannelSecretsKey,
) {
  return {
    async persist(
      scope: AgentScope,
      eventId: string,
      connectionId: string,
      handle: UnsealedReplyHandle,
      now = new Date(),
    ): Promise<string> {
      const publicFields = normalizeFields(
        handle.publicFields,
        false,
      );
      const secretFields = normalizeFields(
        handle.secretFields,
        true,
      );
      validateExpiry(handle.expiresAt, now);
      const secretPlaintext = JSON.stringify(secretFields);
      const encrypted = key.encrypt(secretPlaintext, {
        userId: scope.userId,
        agentId: scope.agentId,
        connectionId,
        fieldName: SECRET_FIELD_NAME,
      }).toStorageRecord();
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO channel_reply_handles (
           user_id, agent_id, event_id, public_fields,
           secret_ciphertext, secret_nonce, secret_auth_tag,
           key_version, expires_at
         )
         SELECT $1, $2, event.id, $5::jsonb,
                $6, $7, $8, $9, $10
         FROM channel_inbound_events AS event
         WHERE event.id = $3
           AND event.connection_id = $4
           AND event.user_id = $1
           AND event.agent_id = $2
         ON CONFLICT (event_id) DO NOTHING
         RETURNING id`,
        [
          scope.userId,
          scope.agentId,
          eventId,
          connectionId,
          JSON.stringify(publicFields),
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.authTag,
          encrypted.keyVersion,
          handle.expiresAt,
        ],
      );
      if (inserted.rows[0]) return inserted.rows[0].id;

      const existing = await readByEvent(
        pool,
        scope,
        eventId,
      );
      if (!existing) {
        throw new Error("channel_reply_handle_event_missing");
      }
      const stored = unseal(scope, existing, key);
      if (
        existing.connection_id !== connectionId
        || !sameFields(stored.publicFields, publicFields)
        || !sameFields(stored.secretFields, secretFields)
        || !sameDate(stored.expiresAt, handle.expiresAt)
      ) {
        throw new Error("channel_reply_handle_payload_conflict");
      }
      return existing.id;
    },

    async findIdForEvent(
      scope: AgentScope,
      eventId: string,
    ): Promise<string | null> {
      const result = await pool.query<{ id: string }>(
        `SELECT id
         FROM channel_reply_handles
         WHERE user_id = $1
           AND agent_id = $2
           AND event_id = $3`,
        [scope.userId, scope.agentId, eventId],
      );
      return result.rows[0]?.id ?? null;
    },

    async load(
      scope: AgentScope,
      handleId: string,
      now = new Date(),
    ): Promise<UnsealedReplyHandle | null> {
      const result = await pool.query<ReplyHandleRow>(
        `SELECT handle.id, event.connection_id,
                handle.public_fields,
                handle.secret_ciphertext,
                handle.secret_nonce,
                handle.secret_auth_tag,
                handle.key_version,
                handle.expires_at
         FROM channel_reply_handles AS handle
         JOIN channel_inbound_events AS event
           ON event.id = handle.event_id
          AND event.user_id = handle.user_id
          AND event.agent_id = handle.agent_id
         WHERE handle.id = $1
           AND handle.user_id = $2
           AND handle.agent_id = $3
           AND (
             handle.expires_at IS NULL
             OR handle.expires_at > $4
           )`,
        [handleId, scope.userId, scope.agentId, now],
      );
      const row = result.rows[0];
      return row ? unseal(scope, row, key) : null;
    },
  };
}

async function readByEvent(
  pool: Pool,
  scope: AgentScope,
  eventId: string,
): Promise<ReplyHandleRow | null> {
  const result = await pool.query<ReplyHandleRow>(
    `SELECT handle.id, event.connection_id,
            handle.public_fields,
            handle.secret_ciphertext,
            handle.secret_nonce,
            handle.secret_auth_tag,
            handle.key_version,
            handle.expires_at
     FROM channel_reply_handles AS handle
     JOIN channel_inbound_events AS event
       ON event.id = handle.event_id
      AND event.user_id = handle.user_id
      AND event.agent_id = handle.agent_id
     WHERE handle.user_id = $1
       AND handle.agent_id = $2
       AND handle.event_id = $3`,
    [scope.userId, scope.agentId, eventId],
  );
  return result.rows[0] ?? null;
}

function unseal(
  scope: AgentScope,
  row: ReplyHandleRow,
  key: ChannelSecretsKey,
): UnsealedReplyHandle {
  const plaintext = key.decrypt(
    encryptedSecretFromStorage({
      ciphertext: row.secret_ciphertext,
      nonce: row.secret_nonce,
      authTag: row.secret_auth_tag,
      keyVersion: row.key_version,
    }),
    {
      userId: scope.userId,
      agentId: scope.agentId,
      connectionId: row.connection_id,
      fieldName: SECRET_FIELD_NAME,
    },
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new Error("channel_reply_handle_invalid");
  }
  return {
    publicFields: normalizeFields(row.public_fields, false),
    secretFields: normalizeFields(parsed, true),
    expiresAt:
      row.expires_at === null
        ? null
        : new Date(row.expires_at),
  };
}

function normalizeFields(
  value: unknown,
  secret: boolean,
): Record<string, string> {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
  ) {
    throw new Error("channel_reply_handle_invalid");
  }
  const entries = Object.entries(value);
  if (
    entries.length > 32
    || entries.some(([name, nested]) =>
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(name)
      || (!secret
        && /(?:authorization|cookie|password|secret|signature|token|webhook)/i
          .test(name))
      || typeof nested !== "string"
      || Buffer.byteLength(nested, "utf8") > 16_384
    )
  ) {
    throw new Error("channel_reply_handle_invalid");
  }
  const normalized = Object.fromEntries(entries) as Record<
    string,
    string
  >;
  if (
    Buffer.byteLength(JSON.stringify(normalized), "utf8")
    > MAX_HANDLE_BYTES
  ) {
    throw new Error("channel_reply_handle_invalid");
  }
  return normalized;
}

function validateExpiry(
  expiresAt: Date | null,
  now: Date,
): void {
  if (expiresAt === null) return;
  const lease = expiresAt.getTime() - now.getTime();
  if (
    !Number.isFinite(lease)
    || lease <= 0
    || lease > MAX_HANDLE_LEASE_MS
  ) {
    throw new Error("channel_reply_handle_expiry_invalid");
  }
}

function sameFields(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftEntries = Object.entries(left).sort();
  const rightEntries = Object.entries(right).sort();
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function sameDate(left: Date | null, right: Date | null): boolean {
  return left?.getTime() === right?.getTime();
}
