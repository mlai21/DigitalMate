import type { AgentScope } from "@/server/agents/types";
import type { Pool } from "pg";
import { deleteAttachment } from "@/server/attachments/storage";

export type AdminSessionRow = Readonly<{
  id: string;
  agentId: string;
  channel: string;
  title: string;
  pinned: boolean;
  archivedAt: Date | null;
  messageCount: number;
  lastMessageAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type AdminSessionDetailInput = Readonly<{
  conversation: Omit<AdminSessionRow, "messageCount" | "lastMessageAt">;
  messages: readonly Readonly<{
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    visibleToUser: boolean;
    createdAt: Date;
  }>[];
  toolLogs: readonly Readonly<{
    id: string;
    toolName: string;
    status: string;
    durationMs: number;
    errorCode: string | null;
    createdAt: Date;
  }>[];
  executionSteps: readonly Readonly<{
    id: string;
    kind: string;
    status: string;
    errorCode: string | null;
    startedAt: Date;
    completedAt: Date | null;
  }>[];
}>;

export type AdminSessionsService = Readonly<{
  listSessions(
    scope: AgentScope,
    query: Readonly<{
      cursor: string | null;
      limit: number;
      channel?: string;
      archived?: boolean;
    }>,
    signal: AbortSignal,
  ): Promise<ReturnType<typeof projectAdminSessionPage>>;
  getSession(
    scope: AgentScope,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<ReturnType<typeof projectAdminSessionDetail> | null>;
  updateSession(
    scope: AgentScope,
    sessionId: string,
    input: Readonly<{ name?: string; pinned?: boolean }>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown> | null>;
  deleteSession(
    scope: AgentScope,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<boolean>;
  batchDeleteSessions(
    scope: AgentScope,
    sessionIds: readonly string[],
    signal: AbortSignal,
  ): Promise<number>;
  setArchived(
    scope: AgentScope,
    sessionId: string,
    archived: boolean,
    signal: AbortSignal,
  ): Promise<Record<string, unknown> | null>;
  batchSetArchived(
    scope: AgentScope,
    sessionIds: readonly string[],
    archived: boolean,
    signal: AbortSignal,
  ): Promise<Readonly<{
    succeeded: readonly string[];
    failed: readonly Readonly<{
      chat_id: string;
      reason: "not_found";
      message: string;
    }>[];
  }>>;
}>;

type SessionCursor = Readonly<{
  updatedAt: string;
  id: string;
}>;

export function projectAdminSessionPage(
  scope: AgentScope,
  rows: readonly AdminSessionRow[],
  query: Readonly<{
    cursor: string | null;
    limit: number;
    channel?: string;
  }>,
) {
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  const sorted = rows
    .filter((row) => row.agentId === scope.agentId)
    .filter((row) => !query.channel || row.channel === query.channel)
    .filter((row) => cursor === null || isAfterCursor(row, cursor))
    .sort(compareRows);
  const page = sorted.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => ({
      id: row.id,
      session_id: row.id,
      user_id: scope.userId,
      agent_id: scope.agentId,
      channel: row.channel,
      name: row.title,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
      status: "idle" as const,
      pinned: row.pinned,
      archived_at: row.archivedAt?.toISOString() ?? null,
      archived: row.archivedAt !== null,
      message_count: row.messageCount,
      last_message_at: row.lastMessageAt?.toISOString() ?? null,
    })),
    next_cursor:
      sorted.length > page.length && last
        ? encodeCursor({
            updatedAt: last.updatedAt.toISOString(),
            id: last.id,
          })
        : null,
  };
}

export function projectAdminSessionDetail(
  scope: AgentScope,
  input: AdminSessionDetailInput,
) {
  if (input.conversation.agentId !== scope.agentId) {
    throw new Error("session_scope_mismatch");
  }
  const messages = input.messages
    .filter(
      (message) =>
        message.visibleToUser &&
        (message.role === "user" || message.role === "assistant"),
    )
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      created_at: message.createdAt.toISOString(),
      visible_to_user: true,
    }));
  const toolSteps = input.toolLogs.map((log) => ({
    id: log.id,
    kind: "tool",
    label: log.toolName,
    status: log.status,
    duration_ms: log.durationMs,
    error_code: log.errorCode,
    created_at: log.createdAt.toISOString(),
    visible_to_user: false,
  }));
  const executionSteps = input.executionSteps.map((step) => ({
    id: step.id,
    kind: step.kind,
    status: step.status,
    error_code: step.errorCode,
    started_at: step.startedAt.toISOString(),
    completed_at: step.completedAt?.toISOString() ?? null,
    visible_to_user: false,
  }));
  return {
    id: input.conversation.id,
    session_id: input.conversation.id,
    agent_id: scope.agentId,
    channel: input.conversation.channel,
    name: input.conversation.title,
    pinned: input.conversation.pinned,
    archived: input.conversation.archivedAt !== null,
    archived_at:
      input.conversation.archivedAt?.toISOString() ?? null,
    status: "idle" as const,
    messages,
    internal_steps: [...toolSteps, ...executionSteps].sort((left, right) => {
      const leftAt =
        "created_at" in left ? left.created_at : left.started_at;
      const rightAt =
        "created_at" in right ? right.created_at : right.started_at;
      return leftAt.localeCompare(rightAt);
    }),
  };
}

export function createPostgresAdminSessionsService(
  pool: Pool,
  attachmentStorageDirectory: string,
  removeAttachment: typeof deleteAttachment = deleteAttachment,
): AdminSessionsService {
  const service: AdminSessionsService = {
    async listSessions(scope, query, signal) {
      signal.throwIfAborted();
      const cursor = query.cursor
        ? decodeCursor(query.cursor)
        : null;
      const result = await pool.query<SessionListRow>(
        `SELECT conversation.id, conversation.agent_id,
                conversation.channel, conversation.title,
                conversation.pinned, conversation.archived_at,
                conversation.created_at, conversation.updated_at,
                count(message.id)
                  FILTER (WHERE message.visible_to_user = true)::int
                  AS message_count,
                max(message.created_at)
                  FILTER (WHERE message.visible_to_user = true)
                  AS last_message_at
         FROM conversations AS conversation
         LEFT JOIN messages AS message
           ON message.conversation_id = conversation.id
          AND message.user_id = conversation.user_id
          AND message.agent_id = conversation.agent_id
         WHERE conversation.user_id = $1
           AND conversation.agent_id = $2
           AND ($3::text IS NULL OR conversation.channel = $3)
           AND (
             $4::boolean IS NULL
             OR (conversation.archived_at IS NOT NULL) = $4
           )
           AND (
             $5::timestamptz IS NULL
             OR (conversation.updated_at, conversation.id)
                < ($5::timestamptz, $6::uuid)
           )
         GROUP BY conversation.id
         ORDER BY conversation.updated_at DESC, conversation.id DESC
         LIMIT $7`,
        [
          scope.userId,
          scope.agentId,
          query.channel ?? null,
          query.archived ?? null,
          cursor?.updatedAt ?? null,
          cursor?.id ?? null,
          query.limit + 1,
        ],
      );
      signal.throwIfAborted();
      return projectAdminSessionPage(
        scope,
        result.rows.map(mapSessionRow),
        query,
      );
    },

    async getSession(scope, sessionId, signal) {
      signal.throwIfAborted();
      const conversation = await pool.query<SessionListRow>(
        `SELECT id, agent_id, channel, title, pinned,
                archived_at, created_at, updated_at,
                0::int AS message_count,
                NULL::timestamptz AS last_message_at
         FROM conversations
         WHERE user_id = $1 AND agent_id = $2 AND id = $3`,
        [scope.userId, scope.agentId, sessionId],
      );
      const row = conversation.rows[0];
      if (!row) return null;
      const [messages, toolLogs, executionSteps] = await Promise.all([
        pool.query<{
          id: string;
          role: "user" | "assistant" | "system";
          content: string;
          visible_to_user: boolean;
          created_at: Date;
        }>(
          `SELECT id, role, content, visible_to_user, created_at
           FROM messages
           WHERE user_id = $1 AND agent_id = $2
             AND conversation_id = $3
           ORDER BY created_at, id`,
          [scope.userId, scope.agentId, sessionId],
        ),
        pool.query<{
          id: string;
          tool_name: string;
          status: string;
          duration_ms: number;
          error: string | null;
          created_at: Date;
        }>(
          `SELECT id, tool_name, status, duration_ms, error,
                  created_at
           FROM tool_call_logs
           WHERE user_id = $1 AND agent_id = $2
             AND conversation_id = $3
           ORDER BY created_at, id
           LIMIT 500`,
          [scope.userId, scope.agentId, sessionId],
        ),
        pool.query<{
          id: string;
          kind: string;
          status: string;
          error_code: string | null;
          started_at: Date;
          completed_at: Date | null;
        }>(
          `SELECT step.id, step.kind, step.status,
                  step.error_code,
                  step.started_at, step.completed_at
           FROM channel_execution_steps AS step
           JOIN channel_inbound_events AS event
             ON event.id = step.event_id
            AND event.user_id = step.user_id
            AND event.agent_id = step.agent_id
           JOIN messages AS message
             ON message.id = event.assistant_message_id
            AND message.user_id = event.user_id
            AND message.agent_id = event.agent_id
           WHERE step.user_id = $1 AND step.agent_id = $2
             AND message.conversation_id = $3
           ORDER BY step.started_at, step.id
           LIMIT 500`,
          [scope.userId, scope.agentId, sessionId],
        ),
      ]);
      signal.throwIfAborted();
      const projected = mapSessionRow(row);
      return projectAdminSessionDetail(scope, {
        conversation: projected,
        messages: messages.rows.map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          visibleToUser: message.visible_to_user,
          createdAt: message.created_at,
        })),
        toolLogs: toolLogs.rows.map((log) => ({
          id: log.id,
          toolName: log.tool_name,
          status: log.status,
          durationMs: Number(log.duration_ms),
          errorCode: log.error ? "tool_failed" : null,
          createdAt: log.created_at,
        })),
        executionSteps: executionSteps.rows.map((step) => ({
          id: step.id,
          kind: step.kind,
          status: step.status,
          errorCode: step.error_code,
          startedAt: step.started_at,
          completedAt: step.completed_at,
        })),
      });
    },

    async updateSession(scope, sessionId, input, signal) {
      return updateSessionRow(
        pool,
        scope,
        sessionId,
        {
          ...(input.name !== undefined
            ? { name: input.name }
            : {}),
          ...(input.pinned !== undefined
            ? { pinned: input.pinned }
            : {}),
        },
        signal,
      );
    },

    async deleteSession(scope, sessionId, signal) {
      signal.throwIfAborted();
      const attachments = await pool.query<{ storage_key: string }>(
        `SELECT attachment.storage_key
         FROM message_attachments AS attachment
         JOIN messages AS message
           ON message.id = attachment.message_id
          AND message.user_id = attachment.user_id
          AND message.agent_id = attachment.agent_id
         WHERE attachment.user_id = $1
           AND attachment.agent_id = $2
           AND message.conversation_id = $3
         ORDER BY attachment.id`,
        [scope.userId, scope.agentId, sessionId],
      );
      const exists = await pool.query(
        `SELECT 1 FROM conversations
         WHERE user_id = $1 AND agent_id = $2 AND id = $3`,
        [scope.userId, scope.agentId, sessionId],
      );
      if (!exists.rows[0]) return false;
      for (const attachment of attachments.rows) {
        signal.throwIfAborted();
        await removeAttachment(
          attachmentStorageDirectory,
          attachment.storage_key,
        );
      }
      signal.throwIfAborted();
      const deleted = await pool.query(
        `DELETE FROM conversations
         WHERE user_id = $1 AND agent_id = $2 AND id = $3`,
        [scope.userId, scope.agentId, sessionId],
      );
      signal.throwIfAborted();
      return deleted.rowCount === 1;
    },

    async batchDeleteSessions(scope, sessionIds, signal) {
      let deleted = 0;
      for (const sessionId of uniqueIds(sessionIds)) {
        if (await service.deleteSession(scope, sessionId, signal)) {
          deleted += 1;
        }
      }
      return deleted;
    },

    async setArchived(scope, sessionId, archived, signal) {
      return updateSessionRow(
        pool,
        scope,
        sessionId,
        { archived },
        signal,
      );
    },

    async batchSetArchived(scope, sessionIds, archived, signal) {
      const succeeded: string[] = [];
      const failed: Array<{
        chat_id: string;
        reason: "not_found";
        message: string;
      }> = [];
      for (const sessionId of uniqueIds(sessionIds)) {
        const updated = await service.setArchived(
          scope,
          sessionId,
          archived,
          signal,
        );
        if (updated) {
          succeeded.push(sessionId);
        } else {
          failed.push({
            chat_id: sessionId,
            reason: "not_found",
            message: "session_not_found",
          });
        }
      }
      return { succeeded, failed };
    },
  };
  return service;
}

type SessionListRow = Readonly<{
  id: string;
  agent_id: string;
  channel: string;
  title: string;
  pinned: boolean;
  archived_at: Date | null;
  message_count: number;
  last_message_at: Date | null;
  created_at: Date;
  updated_at: Date;
}>;

function mapSessionRow(row: SessionListRow): AdminSessionRow {
  return {
    id: row.id,
    agentId: row.agent_id,
    channel: row.channel,
    title: row.title,
    pinned: row.pinned,
    archivedAt: row.archived_at,
    messageCount: Number(row.message_count),
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function updateSessionRow(
  pool: Pool,
  scope: AgentScope,
  sessionId: string,
  input: Readonly<{
    name?: string;
    pinned?: boolean;
    archived?: boolean;
  }>,
  signal: AbortSignal,
): Promise<Record<string, unknown> | null> {
  signal.throwIfAborted();
  const updateName = input.name !== undefined;
  const updatePinned = input.pinned !== undefined;
  const updateArchived = input.archived !== undefined;
  const result = await pool.query<SessionListRow>(
    `UPDATE conversations
     SET title = CASE WHEN $4 THEN $5 ELSE title END,
         pinned = CASE WHEN $6 THEN $7 ELSE pinned END,
         archived_at = CASE
           WHEN $8 THEN CASE
             WHEN $9 THEN COALESCE(archived_at, now())
             ELSE NULL
           END
           ELSE archived_at
         END,
         updated_at = now()
     WHERE user_id = $1 AND agent_id = $2 AND id = $3
     RETURNING id, agent_id, channel, title, pinned,
               archived_at, created_at, updated_at,
               0::int AS message_count,
               NULL::timestamptz AS last_message_at`,
    [
      scope.userId,
      scope.agentId,
      sessionId,
      updateName,
      input.name ?? null,
      updatePinned,
      input.pinned ?? false,
      updateArchived,
      input.archived ?? false,
    ],
  );
  signal.throwIfAborted();
  const row = result.rows[0];
  if (!row) return null;
  return projectAdminSessionPage(
    scope,
    [mapSessionRow(row)],
    { cursor: null, limit: 1 },
  ).items[0] ?? null;
}

function uniqueIds(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function compareRows(
  left: AdminSessionRow,
  right: AdminSessionRow,
): number {
  const byTime = right.updatedAt.getTime() - left.updatedAt.getTime();
  return byTime === 0 ? right.id.localeCompare(left.id) : byTime;
}

function isAfterCursor(
  row: AdminSessionRow,
  cursor: SessionCursor,
): boolean {
  const cursorTime = new Date(cursor.updatedAt).getTime();
  const rowTime = row.updatedAt.getTime();
  return (
    rowTime < cursorTime ||
    (rowTime === cursorTime && row.id.localeCompare(cursor.id) < 0)
  );
}

function encodeCursor(cursor: SessionCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): SessionCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      typeof parsed.updatedAt !== "string" ||
      !Number.isFinite(new Date(parsed.updatedAt).getTime()) ||
      typeof parsed.id !== "string" ||
      parsed.id.length === 0
    ) {
      throw new Error("invalid");
    }
    return {
      updatedAt: parsed.updatedAt,
      id: parsed.id,
    };
  } catch {
    throw new Error("invalid_session_cursor");
  }
}
