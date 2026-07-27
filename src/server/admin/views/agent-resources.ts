import type { Pool } from "pg";

import type { AgentScope } from "@/server/agents/types";
import { parseSkillMd } from "@/server/skills/skill-md";

export type AdminSkillRecord = Readonly<{
  id: string;
  name: string;
  trigger: string;
  content: string;
  status: "pending" | "enabled" | "disabled" | "rejected";
  source: "manual" | "agent" | "task" | "imported";
  sourceUrl: string | null;
  version: number;
  revision: number;
  usageCount: number;
  lastUsedAt: Date | null;
  updatedAt: Date;
  granted: boolean;
  scanVerdict: string | null;
}>;

export type AdminToolRecord = Readonly<{
  id: string;
  name: string;
  description: string;
  kind: "script" | "mcp";
  mcpToolName: string | null;
  status: "pending" | "enabled" | "disabled" | "rejected";
  requiresConfirmation: boolean;
  revision: number;
  granted: boolean;
  commandConfigured: boolean;
}>;

export type AdminResourceMutation = Readonly<{
  expectedRevision: number;
  operationId: string;
  confirmed: boolean;
}>;

export type AdminAgentResourcesService = Readonly<{
  createSkill(
    scope: AgentScope,
    input: Readonly<{
      name: string;
      content: string;
      enabled: boolean;
    }>,
    mutation: Readonly<{
      operationId: string;
      confirmed: boolean;
    }>,
    signal?: AbortSignal,
  ): Promise<unknown>;
  proposeSkillRevision(
    scope: AgentScope,
    skillName: string,
    input: Readonly<{
      content: string;
      expectedRevision: number;
      operationId: string;
      confirmed: boolean;
    }>,
    signal?: AbortSignal,
  ): Promise<unknown>;
  listSkills(
    scope: AgentScope,
    signal?: AbortSignal,
  ): Promise<unknown[]>;
  listSkillWorkspaces(
    scope: AgentScope,
    signal?: AbortSignal,
  ): Promise<unknown[]>;
  listSkillPool(
    scope: AgentScope,
    signal?: AbortSignal,
  ): Promise<unknown[]>;
  setSkillEnabled(
    scope: AgentScope,
    skillName: string,
    enabled: boolean,
    mutation: AdminResourceMutation,
    signal?: AbortSignal,
  ): Promise<unknown>;
  listTools(
    scope: AgentScope,
    signal?: AbortSignal,
  ): Promise<unknown[]>;
  getToolConfig(
    scope: AgentScope,
    toolName: string,
    signal?: AbortSignal,
  ): Promise<unknown | null>;
  listMcpClients(
    scope: AgentScope,
    signal?: AbortSignal,
  ): Promise<unknown[]>;
  getMcpClient(
    scope: AgentScope,
    clientKey: string,
    signal?: AbortSignal,
  ): Promise<unknown | null>;
  listMcpTools(
    scope: AgentScope,
    clientKey: string,
    signal?: AbortSignal,
  ): Promise<unknown[] | null>;
  listMcpAccessPrincipals(
    scope: AgentScope,
    signal?: AbortSignal,
  ): Promise<unknown[]>;
  getMcpPolicy(
    scope: AgentScope,
    clientKey: string,
    signal?: AbortSignal,
  ): Promise<unknown | null>;
}>;

export class AdminAgentResourcesError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "AdminAgentResourcesError";
    this.status = status;
    this.code = code;
  }
}

export function projectSkill(record: AdminSkillRecord) {
  return {
    id: record.id,
    name: record.name,
    description: record.trigger,
    version_text: String(record.version),
    revision: record.revision,
    content: record.content,
    source: record.source,
    enabled:
      record.status === "enabled" && record.granted,
    approval_status: record.status,
    granted: record.granted,
    channels: [],
    tags: [],
    config: {},
    usage_count: record.usageCount,
    last_used_at: record.lastUsedAt?.toISOString() ?? null,
    last_updated: record.updatedAt.toISOString(),
    installed_from: record.sourceUrl,
    scan_verdict: normalizeVerdict(record.scanVerdict),
  };
}

export function projectSkillPool(record: AdminSkillRecord) {
  return {
    ...projectSkill(record),
    protected: false,
    external: record.source === "imported",
    sync_status: "-",
    auto_update: false,
    auto_update_targets: null,
  };
}

export function projectTool(record: AdminToolRecord) {
  return {
    id: record.id,
    name: record.name,
    enabled:
      record.status === "enabled" && record.granted,
    description: record.description,
    async_execution: false,
    icon: record.kind === "mcp" ? "plug" : "wrench",
    requires_config: false,
    config_fields: [],
    config_values: {},
    requires_confirmation: record.requiresConfirmation,
    approval_status: record.status,
    granted: record.granted,
    kind: record.kind,
    revision: record.revision,
    command_configured: record.commandConfigured,
  };
}

export function projectMcpClient(record: AdminToolRecord) {
  return {
    key: record.id,
    name: record.name,
    description: record.description,
    enabled:
      record.status === "enabled" && record.granted,
    transport: "stdio",
    url: "",
    headers: {},
    args: [],
    tools: record.mcpToolName
      ? [record.mcpToolName]
      : [],
    oauth_status: null,
    access_summary: {
      default_effect: record.requiresConfirmation
        ? "ask"
        : "allow",
      overrides_count: 0,
    },
    revision: record.revision,
    approval_status: record.status,
    granted: record.granted,
    command_configured: record.commandConfigured,
  };
}

export function createPostgresAdminAgentResourcesService(
  pool: Pool,
): AdminAgentResourcesService {
  async function readSkills(
    scope: AgentScope,
    signal?: AbortSignal,
  ): Promise<AdminSkillRecord[]> {
    signal?.throwIfAborted();
    const result = await pool.query(
      `SELECT skill.id, skill.name, skill.trigger,
              skill.content, skill.status, skill.source,
              skill.source_url, skill.version,
              skill.revision, skill.usage_count,
              skill.last_used_at, skill.updated_at,
              COALESCE(
                resource_grant.enabled,
                agent.inherits_user_resources
              ) AS granted,
              skill.scan_report->>'verdict' AS scan_verdict
       FROM skills AS skill
       JOIN digital_agents AS agent
         ON agent.user_id = skill.user_id
        AND agent.id = $2
        AND agent.status = 'active'
       LEFT JOIN agent_resource_grants AS resource_grant
         ON resource_grant.user_id = skill.user_id
        AND resource_grant.agent_id = agent.id
        AND resource_grant.resource_type = 'skill'
        AND resource_grant.resource_id = skill.id::text
       WHERE skill.user_id = $1
         AND (
           skill.origin_agent_id = agent.id
           OR (
             skill.origin_agent_id IS NULL
             AND agent.is_default
           )
         )
       ORDER BY skill.updated_at DESC, skill.id DESC
       LIMIT 500`,
      [scope.userId, scope.agentId],
    );
    signal?.throwIfAborted();
    return result.rows.map(mapSkillRecord);
  }

  async function readTools(
    scope: AgentScope,
    signal?: AbortSignal,
    kind?: "script" | "mcp",
  ): Promise<AdminToolRecord[]> {
    signal?.throwIfAborted();
    const result = await pool.query(
      `SELECT tool.id, tool.name, tool.description,
              tool.kind, tool.mcp_tool_name, tool.status,
              tool.requires_confirmation, tool.revision,
              COALESCE(
                resource_grant.enabled,
                agent.inherits_user_resources
              ) AS granted,
              btrim(tool.command) <> '' AS command_configured
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
         AND ($3::text IS NULL OR tool.kind = $3)
       ORDER BY tool.updated_at DESC, tool.id DESC
       LIMIT 500`,
      [scope.userId, scope.agentId, kind ?? null],
    );
    signal?.throwIfAborted();
    return result.rows.map(mapToolRecord);
  }

  async function readMcpRecord(
    scope: AgentScope,
    clientKey: string,
    signal?: AbortSignal,
  ): Promise<AdminToolRecord | null> {
    const records = await readTools(scope, signal, "mcp");
    return records.find((record) => record.id === clientKey) ?? null;
  }

  return {
    async createSkill(scope, input, mutation, signal) {
      if (input.enabled && !mutation.confirmed) {
        throw new AdminAgentResourcesError(
          409,
          "confirmation_required",
        );
      }
      const document = parseSkillMd(input.content);
      if (!document) {
        throw new AdminAgentResourcesError(
          400,
          "invalid_skill_content",
        );
      }
      signal?.throwIfAborted();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const agent = await client.query(
          `SELECT 1
           FROM digital_agents
           WHERE user_id = $1 AND id = $2
             AND status = 'active'
           FOR UPDATE`,
          [scope.userId, scope.agentId],
        );
        if (!agent.rows[0]) {
          throw new AdminAgentResourcesError(
            404,
            "agent_not_found",
          );
        }
        const replay = await client.query<{
          resource_id: string;
        }>(
          `SELECT resource_id
           FROM admin_audit_logs
           WHERE user_id = $1
             AND agent_id = $2
             AND action = 'skill.create'
             AND resource_type = 'skill'
             AND confirmation_source->>'requestId' = $3
             AND status = 'success'
           ORDER BY created_at DESC
           LIMIT 1`,
          [
            scope.userId,
            scope.agentId,
            mutation.operationId,
          ],
        );
        if (replay.rows[0]) {
          const existing = await client.query(
            `SELECT id, name, status, revision
             FROM skills
             WHERE user_id = $1
               AND id = $2::uuid
               AND origin_agent_id = $3`,
            [
              scope.userId,
              replay.rows[0].resource_id,
              scope.agentId,
            ],
          );
          if (existing.rows[0]) {
            await client.query("COMMIT");
            return {
              created: true,
              id: String(existing.rows[0].id),
              name: String(existing.rows[0].name),
              enabled:
                existing.rows[0].status === "enabled",
              approval_status: existing.rows[0].status,
              revision: Number(existing.rows[0].revision),
            };
          }
          throw new AdminAgentResourcesError(
            409,
            "skill_operation_replay_invalid",
          );
        }
        const duplicate = await client.query(
          `SELECT 1
           FROM skills
           WHERE user_id = $1
             AND origin_agent_id = $3
             AND lower(name) = lower($2)
           LIMIT 1`,
          [scope.userId, input.name, scope.agentId],
        );
        if (duplicate.rows[0]) {
          throw new AdminAgentResourcesError(
            409,
            "skill_name_conflict",
          );
        }
        const status = input.enabled
          ? "enabled"
          : "pending";
        const inserted = await client.query(
           `INSERT INTO skills (
             user_id, name, trigger, content,
             status, source, origin_agent_id
           )
           VALUES ($1, $2, $3, $4, $5, 'manual', $6)
           RETURNING id, name, status, revision`,
          [
            scope.userId,
            input.name,
            document.description,
            input.content,
            status,
            scope.agentId,
          ],
        );
        const row = inserted.rows[0];
        if (input.enabled) {
          await client.query(
            `INSERT INTO agent_resource_grants (
               user_id, agent_id, resource_type,
               resource_id, enabled
             )
             VALUES ($1, $2, 'skill', $3, true)
             ON CONFLICT (
               agent_id, resource_type, resource_id
             )
             DO UPDATE SET enabled = true`,
            [
              scope.userId,
              scope.agentId,
              String(row.id),
            ],
          );
        }
        await client.query(
          `INSERT INTO admin_audit_logs (
             user_id, agent_id, action, resource_type,
             resource_id, before_summary, after_summary,
             confirmation_source, status, error_code
           )
           VALUES (
             $1, $2, 'skill.create', 'skill', $3,
             '{}'::jsonb, $4::jsonb, $5::jsonb,
             'success', NULL
           )`,
          [
            scope.userId,
            scope.agentId,
            String(row.id),
            JSON.stringify({
              status,
              revision: Number(row.revision),
              source: "manual",
            }),
            JSON.stringify({
              type: "console",
              requestId: mutation.operationId,
              confirmed: mutation.confirmed,
            }),
          ],
        );
        signal?.throwIfAborted();
        await client.query("COMMIT");
        return {
          created: true,
          id: String(row.id),
          name: String(row.name),
          enabled: status === "enabled",
          approval_status: status,
          revision: Number(row.revision),
        };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async proposeSkillRevision(
      scope,
      skillName,
      input,
      signal,
    ) {
      const document = parseSkillMd(input.content);
      if (!document) {
        throw new AdminAgentResourcesError(
          400,
          "invalid_skill_content",
        );
      }
      signal?.throwIfAborted();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const selected = await client.query(
          `SELECT skill.id, skill.name, skill.revision
           FROM skills AS skill
           JOIN digital_agents AS agent
             ON agent.user_id = skill.user_id
            AND agent.id = $2
            AND agent.status = 'active'
           WHERE skill.user_id = $1
             AND (
               skill.origin_agent_id = agent.id
               OR (
                 skill.origin_agent_id IS NULL
                 AND agent.is_default
               )
             )
             AND lower(skill.name) = lower($3)
           LIMIT 1
           FOR UPDATE OF skill`,
          [scope.userId, scope.agentId, skillName],
        );
        const row = selected.rows[0];
        if (!row) {
          throw new AdminAgentResourcesError(
            404,
            "skill_not_found",
          );
        }
        const replay = await client.query<{
          resource_id: string;
        }>(
          `SELECT resource_id
           FROM admin_audit_logs
           WHERE user_id = $1
             AND agent_id = $2
             AND action = 'skill_revision.propose'
             AND resource_type = 'skill_revision'
             AND confirmation_source->>'requestId' = $3
             AND status = 'success'
           ORDER BY created_at DESC
           LIMIT 1`,
          [
            scope.userId,
            scope.agentId,
            input.operationId,
          ],
        );
        if (replay.rows[0]) {
          await client.query("COMMIT");
          return {
            success: true,
            mode: "edit",
            name: String(row.name),
            approval_status: "pending",
            revision_id: replay.rows[0].resource_id,
          };
        }
        if (Number(row.revision) !== input.expectedRevision) {
          throw new AdminAgentResourcesError(
            409,
            "revision_conflict",
          );
        }
        const pending = await client.query(
          `SELECT 1
           FROM skill_revisions
           WHERE user_id = $1
             AND skill_id = $2
             AND status = 'pending'
           LIMIT 1`,
          [scope.userId, row.id],
        );
        if (pending.rows[0]) {
          throw new AdminAgentResourcesError(
            409,
            "skill_revision_pending",
          );
        }
        const inserted = await client.query(
          `INSERT INTO skill_revisions (
             user_id, skill_id, proposed_content, reason
           )
           VALUES ($1, $2, $3, 'console_edit')
           RETURNING id, revision`,
          [scope.userId, row.id, input.content],
        );
        const revisionId = String(inserted.rows[0].id);
        await client.query(
          `INSERT INTO admin_audit_logs (
             user_id, agent_id, action, resource_type,
             resource_id, before_summary, after_summary,
             confirmation_source, status, error_code
           )
           VALUES (
             $1, $2, 'skill_revision.propose',
             'skill_revision', $3, $4::jsonb, $5::jsonb,
             $6::jsonb, 'success', NULL
           )`,
          [
            scope.userId,
            scope.agentId,
            revisionId,
            JSON.stringify({
              skill_id: String(row.id),
              skill_revision: Number(row.revision),
            }),
            JSON.stringify({
              skill_id: String(row.id),
              proposal_revision: Number(
                inserted.rows[0].revision,
              ),
              status: "pending",
            }),
            JSON.stringify({
              type: "console",
              requestId: input.operationId,
              confirmed: input.confirmed,
            }),
          ],
        );
        signal?.throwIfAborted();
        await client.query("COMMIT");
        return {
          success: true,
          mode: "edit",
          name: String(row.name),
          approval_status: "pending",
          revision_id: revisionId,
        };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async listSkills(scope, signal) {
      return (await readSkills(scope, signal)).map(projectSkill);
    },

    async listSkillWorkspaces(scope, signal) {
      const [skills, agent] = await Promise.all([
        readSkills(scope, signal),
        pool.query<{ display_name: string }>(
          `SELECT display_name
           FROM digital_agents
           WHERE user_id = $1 AND id = $2
             AND status = 'active'`,
          [scope.userId, scope.agentId],
        ),
      ]);
      signal?.throwIfAborted();
      return [{
        agent_id: scope.agentId,
        agent_name:
          agent.rows[0]?.display_name ?? "DigitalMate",
        workspace_dir: "",
        skills: skills.map(projectSkill),
      }];
    },

    async listSkillPool(scope, signal) {
      return (await readSkills(scope, signal)).map(
        projectSkillPool,
      );
    },

    async setSkillEnabled(
      scope,
      skillName,
      enabled,
      mutation,
      signal,
    ) {
      if (enabled && !mutation.confirmed) {
        throw new AdminAgentResourcesError(
          409,
          "confirmation_required",
        );
      }
      signal?.throwIfAborted();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const selected = await client.query(
          `SELECT skill.id, skill.name, skill.trigger,
                  skill.content, skill.status, skill.source,
                  skill.source_url, skill.version,
                  skill.revision, skill.usage_count,
                  skill.last_used_at, skill.updated_at,
                  skill.scan_report->>'verdict'
                    AS scan_verdict,
                  COALESCE(
                    resource_grant.enabled,
                    agent.inherits_user_resources
                  ) AS granted
           FROM skills AS skill
           JOIN digital_agents AS agent
             ON agent.user_id = skill.user_id
            AND agent.id = $2
            AND agent.status = 'active'
           LEFT JOIN agent_resource_grants AS resource_grant
             ON resource_grant.user_id = skill.user_id
            AND resource_grant.agent_id = agent.id
            AND resource_grant.resource_type = 'skill'
            AND resource_grant.resource_id = skill.id::text
           WHERE skill.user_id = $1
             AND (
               skill.origin_agent_id = agent.id
               OR (
                 skill.origin_agent_id IS NULL
                 AND agent.is_default
               )
             )
             AND lower(skill.name) = lower($3)
           LIMIT 1
           FOR UPDATE OF skill`,
          [scope.userId, scope.agentId, skillName],
        );
        const row = selected.rows[0];
        if (!row) {
          throw new AdminAgentResourcesError(
            404,
            "skill_not_found",
          );
        }
        const replay = await client.query(
          `SELECT 1
           FROM admin_audit_logs
           WHERE user_id = $1
             AND agent_id = $2
             AND resource_type = 'skill'
             AND resource_id = $3
             AND confirmation_source->>'requestId' = $4
             AND status = 'success'
           LIMIT 1`,
          [
            scope.userId,
            scope.agentId,
            String(row.id),
            mutation.operationId,
          ],
        );
        if (replay.rows[0]) {
          await client.query("COMMIT");
          return projectSkill(mapSkillRecord(row));
        }
        if (Number(row.revision) !== mutation.expectedRevision) {
          throw new AdminAgentResourcesError(
            409,
            "revision_conflict",
          );
        }
        const status = enabled ? "enabled" : "disabled";
        const updated = await client.query(
          `UPDATE skills
           SET status = $3,
               revision = revision + 1,
               updated_at = now()
           WHERE user_id = $1
             AND id = $2
             AND revision = $4
           RETURNING id, name, trigger, content, status,
                     source, source_url, version, revision,
                     usage_count, last_used_at, updated_at,
                     scan_report->>'verdict' AS scan_verdict`,
          [
            scope.userId,
            row.id,
            status,
            mutation.expectedRevision,
          ],
        );
        if (!updated.rows[0]) {
          throw new AdminAgentResourcesError(
            409,
            "revision_conflict",
          );
        }
        await client.query(
          `INSERT INTO agent_resource_grants (
             user_id, agent_id, resource_type,
             resource_id, enabled
           )
           VALUES ($1, $2, 'skill', $3, $4)
           ON CONFLICT (
             agent_id, resource_type, resource_id
           )
           DO UPDATE SET enabled = EXCLUDED.enabled`,
          [
            scope.userId,
            scope.agentId,
            String(row.id),
            enabled,
          ],
        );
        await client.query(
          `INSERT INTO admin_audit_logs (
             user_id, agent_id, action, resource_type,
             resource_id, before_summary, after_summary,
             confirmation_source, status, error_code
           )
           VALUES (
             $1, $2, $3, 'skill', $4,
             $5::jsonb, $6::jsonb, $7::jsonb,
             'success', NULL
           )`,
          [
            scope.userId,
            scope.agentId,
            enabled ? "skill.enable" : "skill.disable",
            String(row.id),
            JSON.stringify({
              status: row.status,
              granted: Boolean(row.granted),
              revision: Number(row.revision),
            }),
            JSON.stringify({
              status,
              granted: enabled,
              revision: Number(updated.rows[0].revision),
            }),
            JSON.stringify({
              type: "console",
              requestId: mutation.operationId,
              confirmed: mutation.confirmed,
            }),
          ],
        );
        signal?.throwIfAborted();
        await client.query("COMMIT");
        return projectSkill(
          mapSkillRecord({
            ...updated.rows[0],
            granted: enabled,
          }),
        );
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async listTools(scope, signal) {
      return (await readTools(scope, signal)).map(projectTool);
    },

    async getToolConfig(scope, toolName, signal) {
      const tool = (await readTools(scope, signal)).find(
        (candidate) =>
          candidate.name.toLocaleLowerCase() ===
          toolName.toLocaleLowerCase(),
      );
      if (!tool) return null;
      return {
        name: tool.name,
        kind: tool.kind,
        mcp_tool_name: tool.mcpToolName,
        requires_confirmation: tool.requiresConfirmation,
        revision: tool.revision,
        command_configured: tool.commandConfigured,
        writable: false,
      };
    },

    async listMcpClients(scope, signal) {
      return (await readTools(scope, signal, "mcp")).map(
        projectMcpClient,
      );
    },

    async getMcpClient(scope, clientKey, signal) {
      const record = await readMcpRecord(
        scope,
        clientKey,
        signal,
      );
      return record ? projectMcpClient(record) : null;
    },

    async listMcpTools(scope, clientKey, signal) {
      const record = await readMcpRecord(
        scope,
        clientKey,
        signal,
      );
      if (!record) return null;
      return record.mcpToolName
        ? [{
            name: record.mcpToolName,
            description: record.description,
            enabled:
              record.status === "enabled" && record.granted,
            input_schema: {},
          }]
        : [];
    },

    async listMcpAccessPrincipals(scope, signal) {
      signal?.throwIfAborted();
      const result = await pool.query(
        `SELECT channel, external_user_id, display_name,
                updated_at
         FROM channel_identities
         WHERE user_id = $1 AND agent_id = $2
         ORDER BY updated_at DESC, id DESC
         LIMIT 200`,
        [scope.userId, scope.agentId],
      );
      signal?.throwIfAborted();
      return result.rows.map((row) => ({
        source_type: "channel",
        source_value: String(row.channel),
        subject_type: "user",
        subject_value: String(row.external_user_id),
        label:
          typeof row.display_name === "string" &&
          row.display_name.trim()
            ? row.display_name
            : String(row.external_user_id),
        chat_id: "",
        chat_name: "",
        session_id: "",
        updated_at: new Date(
          row.updated_at as Date | string,
        ).toISOString(),
      }));
    },

    async getMcpPolicy(scope, clientKey, signal) {
      const record = await readMcpRecord(
        scope,
        clientKey,
        signal,
      );
      if (!record) return null;
      return {
        default_effect: record.requiresConfirmation
          ? "ask"
          : "allow",
        client_overrides: [],
        tool_defaults: record.mcpToolName
          ? [{
              tool_name: record.mcpToolName,
              effect: record.requiresConfirmation
                ? "ask"
                : "allow",
            }]
          : [],
        tool_overrides: [],
        unmanaged_rules_count: 0,
        writable: false,
      };
    },
  };
}

function mapSkillRecord(
  row: Record<string, unknown>,
): AdminSkillRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    trigger: String(row.trigger),
    content: String(row.content),
    status: row.status as AdminSkillRecord["status"],
    source: row.source as AdminSkillRecord["source"],
    sourceUrl:
      typeof row.source_url === "string"
        ? row.source_url
        : null,
    version: Number(row.version ?? 1),
    revision: Number(row.revision ?? 1),
    usageCount: Number(row.usage_count ?? 0),
    lastUsedAt: dateOrNull(row.last_used_at),
    updatedAt: new Date(row.updated_at as Date | string),
    granted: Boolean(row.granted),
    scanVerdict:
      typeof row.scan_verdict === "string"
        ? row.scan_verdict
        : null,
  };
}

function mapToolRecord(
  row: Record<string, unknown>,
): AdminToolRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description),
    kind: row.kind as AdminToolRecord["kind"],
    mcpToolName:
      typeof row.mcp_tool_name === "string"
        ? row.mcp_tool_name
        : null,
    status: row.status as AdminToolRecord["status"],
    requiresConfirmation: Boolean(
      row.requires_confirmation,
    ),
    revision: Number(row.revision ?? 1),
    granted: Boolean(row.granted),
    commandConfigured: Boolean(row.command_configured),
  };
}

function normalizeVerdict(
  value: string | null,
): "safe" | "warning" | "danger" | null {
  return value === "safe" ||
    value === "warning" ||
    value === "danger"
    ? value
    : null;
}

function dateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const result = new Date(value as Date | string);
  return Number.isFinite(result.getTime()) ? result : null;
}
