import type { AgentScope } from "@/server/agents/types";
import { routingTriggerFromSkillMd } from "@/server/skills/skill-md";
import type { Pool, PoolClient } from "pg";

export type AdminInboxKind =
  | "channel_access"
  | "skill_revision"
  | "tool_registration";
export type AdminInboxStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "dismissed";

export type AdminInboxRecord = Readonly<{
  id: string;
  kind: AdminInboxKind;
  agentId: string;
  title: string;
  summary: string;
  status: AdminInboxStatus;
  revision: number;
  createdAt: Date;
  source: Readonly<Record<string, unknown>>;
}>;

export type AdminInboxItem = Readonly<{
  id: string;
  kind: AdminInboxKind;
  title: string;
  summary: string;
  status: AdminInboxStatus;
  agent_id: string;
  revision: number;
  created_at: string;
  actions: readonly ("approve" | "deny" | "dismiss" | "remark")[];
}>;

export type AdminInboxPage = Readonly<{
  items: readonly AdminInboxItem[];
  next_cursor: string | null;
}>;

export type UpstreamPendingApproval = Readonly<{
  request_id: string;
  session_id: string;
  root_session_id: string;
  owner_agent_id: string;
  agent_id: string;
  tool_name: string;
  tool_display_name: string;
  tool_source: string;
  severity: "low" | "medium" | "high";
  findings_count: number;
  findings_summary: string;
  tool_params: Readonly<Record<string, never>>;
  created_at: number;
  timeout_seconds: number;
  is_generalized: false;
}>;

export type AdminAccessControlEntry = Readonly<{
  channel: string;
  user_id: string;
  remark?: string;
  username?: string;
  revision?: number;
}>;

export type AdminInboxService = Readonly<{
  listInbox(
    scope: AgentScope,
    query: Readonly<{
      status?: AdminInboxStatus;
      cursor: string | null;
      limit: number;
    }>,
    signal: AbortSignal,
  ): Promise<AdminInboxPage>;
  listPendingApprovals(
    scope: AgentScope,
    sessionId: string | null,
    signal: AbortSignal,
  ): Promise<readonly UpstreamPendingApproval[]>;
  resolveApproval(
    scope: AgentScope,
    input: Readonly<{
      id: string;
      action: "approve" | "deny";
      expectedRevision: number | null;
      approvalScope: "exact" | "similar" | null;
      reason: string | null;
      confirmationSourceId: string;
    }>,
    signal: AbortSignal,
  ): Promise<Readonly<{
    status: "approved" | "rejected";
    revision: number;
  }>>;
  listAccessControl(
    scope: AgentScope,
    channel: string | null,
    signal: AbortSignal,
  ): Promise<Record<string, {
    whitelist: Record<string, { remark: string; username: string }>;
    blacklist: Record<string, { remark: string; username: string }>;
    pending: readonly never[];
  }>>;
  listPendingAccess(
    scope: AgentScope,
    signal: AbortSignal,
  ): Promise<readonly Readonly<{
    user_id: string;
    channel: string;
    timestamp: number;
    first_message: string;
    remark: string;
    username: string;
    revision: number;
  }>[]>;
  addAccessRules(
    scope: AgentScope,
    effect: "allow" | "deny",
    entries: readonly AdminAccessControlEntry[],
    signal: AbortSignal,
  ): Promise<void>;
  removeAccessRules(
    scope: AgentScope,
    effect: "allow" | "deny",
    entries: readonly AdminAccessControlEntry[],
    signal: AbortSignal,
  ): Promise<void>;
  resolveAccessRequests(
    scope: AgentScope,
    action: "approve" | "deny" | "dismiss",
    entries: readonly AdminAccessControlEntry[],
    signal: AbortSignal,
  ): Promise<void>;
  updateAccessMetadata(
    scope: AgentScope,
    input: Readonly<{
      channel: string;
      userId: string;
      field: "remark" | "username";
      value: string;
      pendingOnly: boolean;
    }>,
    signal: AbortSignal,
  ): Promise<void>;
  listEvents(
    scope: AgentScope,
    query: Readonly<{
      status?: string;
      unreadOnly: boolean;
      limit: number;
      offset: number;
    }>,
    signal: AbortSignal,
  ): Promise<readonly Record<string, unknown>[]>;
  markEventsRead(
    scope: AgentScope,
    ids: readonly string[] | null,
    signal: AbortSignal,
  ): Promise<number>;
  dismissEvent(
    scope: AgentScope,
    id: string,
    signal: AbortSignal,
  ): Promise<boolean>;
  getEventTrace(
    scope: AgentScope,
    id: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown> | null>;
}>;

type InboxCursor = Readonly<{
  createdAt: string;
  id: string;
}>;

export function projectAdminInbox(
  scope: AgentScope,
  records: readonly AdminInboxRecord[],
  query: Readonly<{
    status?: AdminInboxStatus;
    cursor: string | null;
    limit: number;
  }>,
): AdminInboxPage {
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  const sorted = records
    .filter((record) => record.agentId === scope.agentId)
    .filter(
      (record) => query.status === undefined || record.status === query.status,
    )
    .filter((record) => cursor === null || isAfterCursor(record, cursor))
    .sort(compareRecords);
  const page = sorted.slice(0, query.limit);
  const hasMore = sorted.length > page.length;
  const last = page.at(-1);
  return {
    items: page.map(toPublicItem),
    next_cursor:
      hasMore && last
        ? encodeCursor({
            createdAt: last.createdAt.toISOString(),
            id: last.id,
          })
        : null,
  };
}

export function toPendingApproval(
  record: AdminInboxRecord,
): UpstreamPendingApproval {
  const toolName = readSafeName(record.source.tool_name) ?? record.kind;
  const sessionId =
    readCanonicalId(record.source.session_id) ?? record.agentId;
  return {
    request_id: record.id,
    session_id: sessionId,
    root_session_id: sessionId,
    owner_agent_id: record.agentId,
    agent_id: record.agentId,
    tool_name: toolName,
    tool_display_name: record.title,
    tool_source: record.kind,
    severity:
      record.kind === "skill_revision" ? "low" : "medium",
    findings_count: 1,
    findings_summary: record.summary,
    tool_params: {},
    created_at: Math.floor(record.createdAt.getTime() / 1_000),
    timeout_seconds: 0,
    is_generalized: false,
  };
}

export function createPostgresAdminInboxService(
  pool: Pool,
): AdminInboxService {
  const service: AdminInboxService = {
    async listInbox(scope, query, signal) {
      const records = await readInboxRecords(pool, scope, signal);
      return projectAdminInbox(scope, records, query);
    },

    async listPendingApprovals(scope, sessionId, signal) {
      const records = await readInboxRecords(pool, scope, signal);
      return records
        .filter(
          (record) =>
            record.status === "pending" &&
            (
              sessionId === null ||
              record.source.session_id === sessionId
            ),
        )
        .map(toPendingApproval);
    },

    async resolveApproval(scope, input, signal) {
      return withTransaction(pool, signal, async (client) => {
        const channel = await client.query<{
          id: string;
          connection_id: string;
          status: string;
          revision: number;
          external_sender_id: string;
          chat_type: "direct" | "group";
        }>(
          `SELECT id, connection_id, status, revision,
                  external_sender_id, chat_type
           FROM channel_access_requests
           WHERE user_id = $1 AND agent_id = $2 AND id = $3
           FOR UPDATE`,
          [scope.userId, scope.agentId, input.id],
        );
        if (channel.rows[0]) {
          const row = channel.rows[0];
          assertPendingRevision(row, input.expectedRevision);
          const status =
            input.action === "approve" ? "approved" : "rejected";
          await client.query(
            `UPDATE channel_access_requests
             SET status = $4, revision = revision + 1,
                 resolved_at = now(), updated_at = now()
             WHERE user_id = $1 AND agent_id = $2 AND id = $3`,
            [scope.userId, scope.agentId, input.id, status],
          );
          await upsertAccessRule(client, scope, {
            connectionId: row.connection_id,
            chatType: row.chat_type,
            userId: row.external_sender_id,
            effect: input.action === "approve" ? "allow" : "deny",
          });
          await insertInboxAudit(client, scope, {
            action: `channel_access.${input.action}`,
            resourceType: "channel_access_request",
            resourceId: input.id,
            beforeStatus: row.status,
            afterStatus: status,
            beforeRevision: row.revision,
            afterRevision: row.revision + 1,
            confirmationSourceId: input.confirmationSourceId,
          });
          await bumpConnections(
            client,
            scope,
            [row.connection_id],
          );
          return {
            status:
              input.action === "approve" ? "approved" : "rejected",
            revision: row.revision + 1,
          };
        }

        const skill = await client.query<{
          id: string;
          skill_id: string;
          proposed_content: string;
          status: string;
          revision: number;
        }>(
          `SELECT revision.id, revision.skill_id,
                  revision.proposed_content,
                  revision.status, revision.revision
           FROM skill_revisions AS revision
           JOIN skills AS skill
             ON skill.id = revision.skill_id
            AND skill.user_id = revision.user_id
           JOIN digital_agents AS agent
             ON agent.user_id = revision.user_id
            AND agent.id = $2
            AND agent.status = 'active'
           LEFT JOIN agent_resource_grants AS resource_grant
             ON resource_grant.user_id = skill.user_id
            AND resource_grant.agent_id = agent.id
            AND resource_grant.resource_type = 'skill'
            AND resource_grant.resource_id = skill.id::text
           WHERE revision.user_id = $1
             AND revision.id = $3
             AND COALESCE(
               resource_grant.enabled,
               agent.inherits_user_resources
             )
           FOR UPDATE OF revision`,
          [scope.userId, scope.agentId, input.id],
        );
        if (skill.rows[0]) {
          const row = skill.rows[0];
          assertPendingRevision(row, input.expectedRevision);
          const status =
            input.action === "approve" ? "applied" : "rejected";
          if (input.action === "approve") {
            await client.query(
              `UPDATE skills
               SET content = $3, trigger = COALESCE($4, trigger),
                   version = version + 1,
                   revision = revision + 1,
                   updated_at = now()
               WHERE user_id = $1 AND id = $2`,
              [
                scope.userId,
                row.skill_id,
                row.proposed_content,
                routingTriggerFromSkillMd(String(row.proposed_content)),
              ],
            );
          }
          await client.query(
            `UPDATE skill_revisions
             SET status = $3, revision = revision + 1,
                 updated_at = now()
             WHERE user_id = $1 AND id = $2`,
            [scope.userId, input.id, status],
          );
          await insertInboxAudit(client, scope, {
            action: `skill_revision.${input.action}`,
            resourceType: "skill_revision",
            resourceId: input.id,
            beforeStatus: row.status,
            afterStatus: status,
            beforeRevision: row.revision,
            afterRevision: row.revision + 1,
            confirmationSourceId: input.confirmationSourceId,
          });
          return {
            status:
              input.action === "approve" ? "approved" : "rejected",
            revision: row.revision + 1,
          };
        }

        const tool = await client.query<{
          id: string;
          status: string;
          revision: number;
        }>(
          `SELECT tool.id, tool.status, tool.revision
           FROM tool_registrations AS tool
           JOIN digital_agents AS agent
             ON agent.user_id = tool.user_id
            AND agent.id = $2
            AND agent.status = 'active'
           LEFT JOIN agent_resource_grants AS resource_grant
             ON resource_grant.user_id = tool.user_id
            AND resource_grant.agent_id = agent.id
            AND resource_grant.resource_type = 'tool'
            AND resource_grant.resource_id = tool.id::text
           WHERE tool.user_id = $1
             AND tool.id = $3
             AND COALESCE(
               resource_grant.enabled,
               agent.inherits_user_resources
             )
           FOR UPDATE OF tool`,
          [scope.userId, scope.agentId, input.id],
        );
        if (!tool.rows[0]) throw inboxNotFound();
        const row = tool.rows[0];
        assertPendingRevision(row, input.expectedRevision);
        const status =
          input.action === "approve" ? "enabled" : "rejected";
        await client.query(
          `UPDATE tool_registrations
           SET status = $3, revision = revision + 1,
               updated_at = now()
           WHERE user_id = $1 AND id = $2`,
          [scope.userId, input.id, status],
        );
        await insertInboxAudit(client, scope, {
          action: `tool_registration.${input.action}`,
          resourceType: "tool_registration",
          resourceId: input.id,
          beforeStatus: row.status,
          afterStatus: status,
          beforeRevision: row.revision,
          afterRevision: row.revision + 1,
          confirmationSourceId: input.confirmationSourceId,
        });
        return {
          status:
            input.action === "approve" ? "approved" : "rejected",
          revision: row.revision + 1,
        };
      });
    },

    async listAccessControl(scope, channel, signal) {
      signal.throwIfAborted();
      const result = await pool.query<{
        channel_type: string;
        target_id: string | null;
        effect: "allow" | "deny" | null;
        remark: string | null;
        username: string | null;
      }>(
        `SELECT connection.channel_type, rule.target_id,
                rule.effect, rule.remark, rule.username
         FROM channel_connections AS connection
         LEFT JOIN channel_access_rules AS rule
           ON rule.connection_id = connection.id
          AND rule.user_id = connection.user_id
          AND rule.agent_id = connection.agent_id
          AND rule.target_kind = 'sender'
         WHERE connection.user_id = $1
           AND connection.agent_id = $2
           AND connection.deleted_at IS NULL
           AND ($3::text IS NULL OR connection.channel_type = $3)
         ORDER BY connection.channel_type, rule.created_at, rule.id`,
        [scope.userId, scope.agentId, channel],
      );
      signal.throwIfAborted();
      const output: Record<string, {
        whitelist: Record<string, { remark: string; username: string }>;
        blacklist: Record<string, { remark: string; username: string }>;
        pending: readonly never[];
      }> = {};
      for (const row of result.rows) {
        output[row.channel_type] ??= {
          whitelist: {},
          blacklist: {},
          pending: [],
        };
        if (
          row.target_id === null ||
          row.effect === null
        ) {
          continue;
        }
        const target =
          row.effect === "allow"
            ? output[row.channel_type].whitelist
            : output[row.channel_type].blacklist;
        target[row.target_id] = {
          remark: row.remark ?? "",
          username: row.username ?? "",
        };
      }
      return output;
    },

    async listPendingAccess(scope, signal) {
      signal.throwIfAborted();
      const result = await pool.query<{
        external_sender_id: string;
        channel_type: string;
        created_at: Date;
        remark: string;
        username: string;
        revision: number;
      }>(
        `SELECT request.external_sender_id,
                connection.channel_type, request.created_at,
                request.remark, request.username, request.revision
         FROM channel_access_requests AS request
         JOIN channel_connections AS connection
           ON connection.id = request.connection_id
          AND connection.user_id = request.user_id
          AND connection.agent_id = request.agent_id
         WHERE request.user_id = $1 AND request.agent_id = $2
           AND request.status = 'pending'
           AND connection.deleted_at IS NULL
         ORDER BY request.created_at DESC, request.id DESC
         LIMIT 200`,
        [scope.userId, scope.agentId],
      );
      signal.throwIfAborted();
      return result.rows.map((row) => ({
        user_id: row.external_sender_id,
        channel: row.channel_type,
        timestamp: Math.floor(row.created_at.getTime() / 1_000),
        first_message: "",
        remark: row.remark,
        username: row.username,
        revision: Number(row.revision),
      }));
    },

    async addAccessRules(scope, effect, entries, signal) {
      await mutateAccessRules(
        pool,
        scope,
        "add",
        effect,
        entries,
        signal,
      );
    },

    async removeAccessRules(scope, effect, entries, signal) {
      await mutateAccessRules(
        pool,
        scope,
        "remove",
        effect,
        entries,
        signal,
      );
    },

    async resolveAccessRequests(scope, action, entries, signal) {
      await withTransaction(pool, signal, async (client) => {
        const changedConnections = new Set<string>();
        for (const entry of entries) {
          signal.throwIfAborted();
          const request = await client.query<{
            id: string;
            connection_id: string;
            chat_type: "direct" | "group";
            external_sender_id: string;
            status: string;
            revision: number;
          }>(
            `SELECT request.id, request.connection_id,
                    request.chat_type, request.external_sender_id,
                    request.status, request.revision
             FROM channel_access_requests AS request
             JOIN channel_connections AS connection
               ON connection.id = request.connection_id
              AND connection.user_id = request.user_id
              AND connection.agent_id = request.agent_id
             WHERE request.user_id = $1
               AND request.agent_id = $2
               AND connection.channel_type = $3
               AND request.external_sender_id = $4
               AND request.status = 'pending'
             ORDER BY request.created_at
             LIMIT 1
             FOR UPDATE OF request`,
            [
              scope.userId,
              scope.agentId,
              entry.channel,
              entry.user_id,
            ],
          );
          const row = request.rows[0];
          if (!row) throw inboxNotFound();
          if (
            entry.revision !== undefined &&
            entry.revision !== Number(row.revision)
          ) {
            throw revisionConflict(Number(row.revision));
          }
          const status =
            action === "approve"
              ? "approved"
              : action === "deny"
                ? "rejected"
                : "expired";
          await client.query(
            `UPDATE channel_access_requests
             SET status = $4, revision = revision + 1,
                 resolved_at = now(), updated_at = now()
             WHERE user_id = $1 AND agent_id = $2 AND id = $3`,
            [scope.userId, scope.agentId, row.id, status],
          );
          if (action !== "dismiss") {
            await upsertAccessRule(client, scope, {
              connectionId: row.connection_id,
              chatType: row.chat_type,
              userId: row.external_sender_id,
              effect: action === "approve" ? "allow" : "deny",
            });
          }
          await insertInboxAudit(client, scope, {
            action: `channel_access.${action}`,
            resourceType: "channel_access_request",
            resourceId: row.id,
            beforeStatus: row.status,
            afterStatus: status,
            beforeRevision: Number(row.revision),
            afterRevision: Number(row.revision) + 1,
            confirmationSourceId: row.id,
          });
          changedConnections.add(row.connection_id);
        }
        await bumpConnections(
          client,
          scope,
          [...changedConnections],
        );
      });
    },

    async updateAccessMetadata(scope, input, signal) {
      await withTransaction(pool, signal, async (client) => {
        const table = input.pendingOnly
          ? "channel_access_requests"
          : "channel_access_rules";
        const identityColumn = input.pendingOnly
          ? "external_sender_id"
          : "target_id";
        const result = await client.query<{ connection_id: string }>(
          `UPDATE ${table} AS target
           SET ${input.field} = $5,
               revision = revision + 1,
               updated_at = now()
           FROM channel_connections AS connection
           WHERE target.connection_id = connection.id
             AND target.user_id = $1
             AND target.agent_id = $2
             AND connection.channel_type = $3
             AND target.${identityColumn} = $4
             ${input.pendingOnly
               ? "AND target.status = 'pending'"
               : "AND target.target_kind = 'sender'"}
           RETURNING target.connection_id`,
          [
            scope.userId,
            scope.agentId,
            input.channel,
            input.userId,
            input.value,
          ],
        );
        if (result.rows.length === 0 && !input.pendingOnly) {
          const pending = await client.query<{ connection_id: string }>(
            `UPDATE channel_access_requests AS request
             SET ${input.field} = $5,
                 revision = revision + 1,
                 updated_at = now()
             FROM channel_connections AS connection
             WHERE request.connection_id = connection.id
               AND request.user_id = $1
               AND request.agent_id = $2
               AND connection.channel_type = $3
               AND request.external_sender_id = $4
               AND request.status = 'pending'
             RETURNING request.connection_id`,
            [
              scope.userId,
              scope.agentId,
              input.channel,
              input.userId,
              input.value,
            ],
          );
          if (pending.rows.length === 0) throw inboxNotFound();
          result.rows.push(...pending.rows);
        } else if (result.rows.length === 0) {
          throw inboxNotFound();
        }
        await insertInboxAudit(client, scope, {
          action: `channel_access.${input.field}`,
          resourceType: "channel_access",
          resourceId: `${input.channel}:${input.userId}`,
          beforeStatus: "existing",
          afterStatus: "updated",
          beforeRevision: 0,
          afterRevision: 0,
          confirmationSourceId: `${input.channel}:${input.userId}`,
        });
        await bumpConnections(
          client,
          scope,
          result.rows.map((row) => row.connection_id),
        );
      });
    },

    async listEvents(scope, query, signal) {
      const records = await readInboxRecords(pool, scope, signal);
      const states = await pool.query<{
        source_id: string;
        read_at: Date | null;
        dismissed_at: Date | null;
      }>(
        `SELECT source_id, read_at, dismissed_at
         FROM admin_inbox_states
         WHERE user_id = $1 AND agent_id = $2
           AND source_type = 'approval'`,
        [scope.userId, scope.agentId],
      );
      const byId = new Map(
        states.rows.map((row) => [row.source_id, row]),
      );
      return records
        .filter((record) => !byId.get(record.id)?.dismissed_at)
        .filter(
          (record) =>
            !query.status || record.status === query.status,
        )
        .filter(
          (record) =>
            !query.unreadOnly || !byId.get(record.id)?.read_at,
        )
        .sort(compareRecords)
        .slice(query.offset, query.offset + query.limit)
        .map((record) => ({
          id: record.id,
          agent_id: record.agentId,
          source_type: "approval",
          source_id: record.id,
          event_type: record.kind,
          status: record.status,
          severity:
            record.kind === "skill_revision" ? "info" : "warning",
          title: record.title,
          body: record.summary,
          payload: {
            kind: record.kind,
            revision: record.revision,
          },
          read: Boolean(byId.get(record.id)?.read_at),
          created_at: Math.floor(record.createdAt.getTime() / 1_000),
        }));
    },

    async markEventsRead(scope, ids, signal) {
      signal.throwIfAborted();
      const records = await readInboxRecords(pool, scope, signal);
      const selected = records
        .map((record) => record.id)
        .filter((id) => ids === null || ids.includes(id));
      for (const id of selected) {
        await pool.query(
          `INSERT INTO admin_inbox_states (
             user_id, agent_id, source_type, source_id, read_at
           )
           VALUES ($1, $2, 'approval', $3, now())
           ON CONFLICT (
             user_id, agent_id, source_type, source_id
           ) DO UPDATE
           SET read_at = now(), updated_at = now()`,
          [scope.userId, scope.agentId, id],
        );
      }
      signal.throwIfAborted();
      return selected.length;
    },

    async dismissEvent(scope, id, signal) {
      signal.throwIfAborted();
      const records = await readInboxRecords(pool, scope, signal);
      if (!records.some((record) => record.id === id)) return false;
      await pool.query(
        `INSERT INTO admin_inbox_states (
           user_id, agent_id, source_type, source_id,
           read_at, dismissed_at
         )
         VALUES ($1, $2, 'approval', $3, now(), now())
         ON CONFLICT (
           user_id, agent_id, source_type, source_id
         ) DO UPDATE
         SET read_at = now(), dismissed_at = now(), updated_at = now()`,
        [scope.userId, scope.agentId, id],
      );
      signal.throwIfAborted();
      return true;
    },

    async getEventTrace(scope, id, signal) {
      const records = await readInboxRecords(pool, scope, signal);
      const record = records.find((candidate) => candidate.id === id);
      if (!record) return null;
      return {
        run_id: record.id,
        created_at: Math.floor(record.createdAt.getTime() / 1_000),
        completed_at:
          record.status === "pending"
            ? null
            : Math.floor(record.createdAt.getTime() / 1_000),
        status: record.status,
        meta: {
          kind: record.kind,
          agent_id: record.agentId,
        },
        events: [
          {
            at: Math.floor(record.createdAt.getTime() / 1_000),
            event: {
              kind: record.kind,
              status: record.status,
              title: record.title,
            },
          },
        ],
      };
    },
  };
  return service;
}

function toPublicItem(record: AdminInboxRecord): AdminInboxItem {
  return {
    id: record.id,
    kind: record.kind,
    title: record.title,
    summary: record.summary,
    status: record.status,
    agent_id: record.agentId,
    revision: record.revision,
    created_at: record.createdAt.toISOString(),
    actions:
      record.status === "pending"
        ? ["approve", "deny", "dismiss", "remark"]
        : [],
  };
}

function compareRecords(
  left: AdminInboxRecord,
  right: AdminInboxRecord,
): number {
  const byTime = right.createdAt.getTime() - left.createdAt.getTime();
  return byTime === 0 ? right.id.localeCompare(left.id) : byTime;
}

function isAfterCursor(
  record: AdminInboxRecord,
  cursor: InboxCursor,
): boolean {
  const cursorTime = new Date(cursor.createdAt).getTime();
  const recordTime = record.createdAt.getTime();
  return (
    recordTime < cursorTime ||
    (recordTime === cursorTime && record.id.localeCompare(cursor.id) < 0)
  );
}

function encodeCursor(cursor: InboxCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): InboxCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      typeof parsed.createdAt !== "string" ||
      !Number.isFinite(new Date(parsed.createdAt).getTime()) ||
      typeof parsed.id !== "string" ||
      parsed.id.length === 0
    ) {
      throw new Error("invalid");
    }
    return {
      createdAt: parsed.createdAt,
      id: parsed.id,
    };
  } catch {
    throw new Error("invalid_inbox_cursor");
  }
}

function readSafeName(value: unknown): string | null {
  return typeof value === "string" &&
    /^[A-Za-z0-9_.:-]{1,100}$/.test(value)
    ? value
    : null;
}

function readCanonicalId(value: unknown): string | null {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
    ? value
    : null;
}

async function readInboxRecords(
  pool: Pool,
  scope: AgentScope,
  signal: AbortSignal,
): Promise<AdminInboxRecord[]> {
  signal.throwIfAborted();
  const [access, skills, tools] = await Promise.all([
    pool.query<{
      id: string;
      agent_id: string;
      channel_type: string;
      external_sender_id: string;
      status: "pending" | "approved" | "rejected" | "expired";
      revision: number;
      created_at: Date;
    }>(
      `SELECT request.id, request.agent_id,
              connection.channel_type,
              request.external_sender_id,
              request.status, request.revision,
              request.created_at
       FROM channel_access_requests AS request
       JOIN channel_connections AS connection
         ON connection.id = request.connection_id
        AND connection.user_id = request.user_id
        AND connection.agent_id = request.agent_id
       WHERE request.user_id = $1 AND request.agent_id = $2
         AND connection.deleted_at IS NULL
       ORDER BY request.created_at DESC
       LIMIT 200`,
      [scope.userId, scope.agentId],
    ),
    pool.query<{
      id: string;
      skill_name: string;
      reason: string;
      status: "pending" | "applied" | "rejected";
      revision: number;
      created_at: Date;
    }>(
      `SELECT revision.id, skill.name AS skill_name,
              revision.reason, revision.status,
              revision.revision, revision.created_at
       FROM skill_revisions AS revision
       JOIN skills AS skill
         ON skill.id = revision.skill_id
        AND skill.user_id = revision.user_id
       JOIN digital_agents AS agent
         ON agent.user_id = revision.user_id
        AND agent.id = $2
        AND agent.status = 'active'
       LEFT JOIN agent_resource_grants AS resource_grant
         ON resource_grant.user_id = skill.user_id
        AND resource_grant.agent_id = agent.id
        AND resource_grant.resource_type = 'skill'
        AND resource_grant.resource_id = skill.id::text
       WHERE revision.user_id = $1
         AND COALESCE(
           resource_grant.enabled,
           agent.inherits_user_resources
         )
       ORDER BY revision.created_at DESC
       LIMIT 200`,
      [scope.userId, scope.agentId],
    ),
    pool.query<{
      id: string;
      name: string;
      description: string;
      status: "pending" | "enabled" | "disabled" | "rejected";
      revision: number;
      created_at: Date;
    }>(
      `SELECT tool.id, tool.name, tool.description,
              tool.status, tool.revision, tool.created_at
       FROM tool_registrations AS tool
       JOIN digital_agents AS agent
         ON agent.user_id = tool.user_id
        AND agent.id = $2
        AND agent.status = 'active'
       LEFT JOIN agent_resource_grants AS resource_grant
         ON resource_grant.user_id = tool.user_id
        AND resource_grant.agent_id = agent.id
        AND resource_grant.resource_type = 'tool'
        AND resource_grant.resource_id = tool.id::text
       WHERE tool.user_id = $1
         AND COALESCE(
           resource_grant.enabled,
           agent.inherits_user_resources
         )
       ORDER BY tool.created_at DESC
       LIMIT 200`,
      [scope.userId, scope.agentId],
    ),
  ]);
  signal.throwIfAborted();
  return [
    ...access.rows.map(
      (row): AdminInboxRecord => ({
        id: row.id,
        kind: "channel_access",
        agentId: row.agent_id,
        title: `${row.channel_type} 渠道访问申请`,
        summary: `用户 ${row.external_sender_id} 请求访问`,
        status:
          row.status === "expired"
            ? "dismissed"
            : row.status,
        revision: Number(row.revision),
        createdAt: row.created_at,
        source: {
          tool_name: "channel_access",
        },
      }),
    ),
    ...skills.rows.map(
      (row): AdminInboxRecord => ({
        id: row.id,
        kind: "skill_revision",
        agentId: scope.agentId,
        title: `确认 Skill 更新：${row.skill_name}`,
        summary: safeSummary(row.reason, "Skill 更新等待确认"),
        status: row.status === "applied" ? "approved" : row.status,
        revision: Number(row.revision),
        createdAt: row.created_at,
        source: { tool_name: "skill_revision" },
      }),
    ),
    ...tools.rows.map(
      (row): AdminInboxRecord => ({
        id: row.id,
        kind: "tool_registration",
        agentId: scope.agentId,
        title: `确认工具启用：${row.name}`,
        summary: safeSummary(
          row.description,
          "工具注册等待确认",
        ),
        status:
          row.status === "enabled"
            ? "approved"
            : row.status === "disabled"
              ? "dismissed"
              : row.status,
        revision: Number(row.revision),
        createdAt: row.created_at,
        source: {
          tool_name: readSafeName(row.name) ?? "tool_registration",
        },
      }),
    ),
  ];
}

async function mutateAccessRules(
  pool: Pool,
  scope: AgentScope,
  operation: "add" | "remove",
  effect: "allow" | "deny",
  entries: readonly AdminAccessControlEntry[],
  signal: AbortSignal,
): Promise<void> {
  await withTransaction(pool, signal, async (client) => {
    const changedConnections = new Set<string>();
    for (const entry of entries) {
      signal.throwIfAborted();
      const connection = await resolveConnectionForUpdate(
        client,
        scope,
        entry.channel,
      );
      if (operation === "add") {
        await client.query(
          `INSERT INTO channel_access_rules (
             user_id, agent_id, connection_id, chat_type,
             target_kind, target_id, effect, remark, username
           )
           VALUES (
             $1, $2, $3, 'direct',
             'sender', $4, $5, $6, $7
           )
           ON CONFLICT (
             connection_id, chat_type, target_kind, target_id
           ) DO UPDATE
           SET effect = EXCLUDED.effect,
               remark = EXCLUDED.remark,
               username = EXCLUDED.username,
               revision = channel_access_rules.revision + 1,
               updated_at = now()`,
          [
            scope.userId,
            scope.agentId,
            connection.id,
            entry.user_id,
            effect,
            entry.remark?.trim() ?? "",
            entry.username?.trim() ?? "",
          ],
        );
      } else {
        const removed = await client.query(
          `DELETE FROM channel_access_rules
           WHERE user_id = $1 AND agent_id = $2
             AND connection_id = $3
             AND target_kind = 'sender'
             AND target_id = $4 AND effect = $5`,
          [
            scope.userId,
            scope.agentId,
            connection.id,
            entry.user_id,
            effect,
          ],
        );
        if (removed.rowCount === 0) throw inboxNotFound();
      }
      await insertInboxAudit(client, scope, {
        action: `channel_access.${operation}`,
        resourceType: "channel_access_rule",
        resourceId: `${entry.channel}:${entry.user_id}`,
        beforeStatus: operation === "add" ? "absent_or_existing" : effect,
        afterStatus: operation === "add" ? effect : "removed",
        beforeRevision: 0,
        afterRevision: 0,
        confirmationSourceId: `${entry.channel}:${entry.user_id}`,
      });
      changedConnections.add(connection.id);
    }
    await bumpConnections(
      client,
      scope,
      [...changedConnections],
    );
  });
}

async function resolveConnectionForUpdate(
  client: PoolClient,
  scope: AgentScope,
  channel: string,
): Promise<{ id: string; revision: number }> {
  const result = await client.query<{
    id: string;
    revision: number;
  }>(
    `SELECT id, revision
     FROM channel_connections
     WHERE user_id = $1 AND agent_id = $2
       AND channel_type = $3 AND deleted_at IS NULL
     ORDER BY created_at, id
     LIMIT 2
     FOR UPDATE`,
    [scope.userId, scope.agentId, channel],
  );
  if (result.rows.length === 0) {
    throw Object.assign(new Error("channel_not_found"), {
      code: "channel_not_found",
    });
  }
  if (result.rows.length > 1) {
    throw Object.assign(new Error("channel_connection_ambiguous"), {
      code: "channel_connection_ambiguous",
    });
  }
  return result.rows[0];
}

async function upsertAccessRule(
  client: PoolClient,
  scope: AgentScope,
  input: Readonly<{
    connectionId: string;
    chatType: "direct" | "group";
    userId: string;
    effect: "allow" | "deny";
  }>,
): Promise<void> {
  await client.query(
    `INSERT INTO channel_access_rules (
       user_id, agent_id, connection_id, chat_type,
       target_kind, target_id, effect
     )
     VALUES ($1, $2, $3, $4, 'sender', $5, $6)
     ON CONFLICT (
       connection_id, chat_type, target_kind, target_id
     ) DO UPDATE
     SET effect = EXCLUDED.effect,
         revision = channel_access_rules.revision + 1,
         updated_at = now()`,
    [
      scope.userId,
      scope.agentId,
      input.connectionId,
      input.chatType,
      input.userId,
      input.effect,
    ],
  );
}

async function bumpConnections(
  client: PoolClient,
  scope: AgentScope,
  connectionIds: readonly string[],
): Promise<void> {
  for (const connectionId of new Set(connectionIds)) {
    const updated = await client.query<{ revision: number }>(
      `UPDATE channel_connections
       SET revision = revision + 1, updated_at = now()
       WHERE user_id = $1 AND agent_id = $2 AND id = $3
       RETURNING revision`,
      [scope.userId, scope.agentId, connectionId],
    );
    const revision = updated.rows[0]?.revision;
    if (revision === undefined) throw inboxNotFound();
    await client.query(
      "SELECT pg_notify('channel_config_changed', $1)",
      [
        JSON.stringify({
          connection_id: connectionId,
          revision: Number(revision),
        }),
      ],
    );
  }
}

async function insertInboxAudit(
  client: PoolClient,
  scope: AgentScope,
  input: Readonly<{
    action: string;
    resourceType: string;
    resourceId: string;
    beforeStatus: string;
    afterStatus: string;
    beforeRevision: number;
    afterRevision: number;
    confirmationSourceId: string;
  }>,
): Promise<void> {
  await client.query(
    `INSERT INTO admin_audit_logs (
       user_id, agent_id, action, resource_type, resource_id,
       before_summary, after_summary, confirmation_source,
       status, error_code
     )
     VALUES (
       $1, $2, $3, $4, $5,
       $6::jsonb, $7::jsonb, $8::jsonb,
       'success', NULL
     )`,
    [
      scope.userId,
      scope.agentId,
      input.action,
      input.resourceType,
      input.resourceId,
      JSON.stringify({
        status: input.beforeStatus,
        revision: input.beforeRevision,
      }),
      JSON.stringify({
        status: input.afterStatus,
        revision: input.afterRevision,
      }),
      JSON.stringify({
        type: "console",
        source_id: input.confirmationSourceId,
      }),
    ],
  );
}

function assertPendingRevision(
  row: Readonly<{ status: string; revision: number }>,
  expectedRevision: number | null,
): void {
  const currentRevision = Number(row.revision);
  if (
    row.status !== "pending" ||
    (
      expectedRevision !== null &&
      expectedRevision !== currentRevision
    )
  ) {
    throw revisionConflict(currentRevision);
  }
}

function revisionConflict(currentRevision: number): Error {
  return Object.assign(new Error("revision_conflict"), {
    code: "revision_conflict",
    currentRevision,
  });
}

function inboxNotFound(): Error {
  return Object.assign(new Error("inbox_item_not_found"), {
    code: "inbox_item_not_found",
  });
}

async function withTransaction<T>(
  pool: Pool,
  signal: AbortSignal,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const client = await pool.connect();
  let active = false;
  try {
    await client.query("BEGIN");
    active = true;
    const result = await work(client);
    signal.throwIfAborted();
    await client.query("COMMIT");
    active = false;
    return result;
  } catch (error) {
    if (active) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function safeSummary(value: string, fallback: string): string {
  const normalized = value
    .replace(
      /(?:api[_-]?key|authorization|token|secret|password)\s*[:=]\s*\S+/giu,
      "[已隐藏敏感值]",
    )
    .trim();
  return (normalized || fallback).slice(0, 500);
}
