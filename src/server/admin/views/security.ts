import type { Pool } from "pg";

import type { AgentScope } from "@/server/agents/types";
import type { AdminCompatHandler } from "@/server/admin/compat/types";

export type AdminSecurityService = Readonly<{
  getOverview(
    scope: AgentScope,
    signal?: AbortSignal,
  ): Promise<unknown>;
  getToolGuard(
    scope: AgentScope,
    signal?: AbortSignal,
  ): Promise<unknown>;
  getBuiltinRules(
    scope: AgentScope,
    signal?: AbortSignal,
  ): Promise<unknown[]>;
  getSandbox(
    scope: AgentScope,
    signal?: AbortSignal,
  ): Promise<unknown>;
  getFileGuard(
    scope: AgentScope,
    signal?: AbortSignal,
  ): Promise<unknown>;
  getSkillScanner(
    scope: AgentScope,
    signal?: AbortSignal,
  ): Promise<unknown>;
  getBlockedHistory(
    scope: AgentScope,
    signal?: AbortSignal,
  ): Promise<unknown[]>;
  getAllowNoAuthHosts(
    scope: AgentScope,
    signal?: AbortSignal,
  ): Promise<unknown>;
}>;

export function createPostgresAdminSecurityService(
  pool: Pool,
): AdminSecurityService {
  async function readSecurityState(
    scope: AgentScope,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const [
      channels,
      access,
      grants,
      tools,
      audits,
      nodes,
      skills,
    ] = await Promise.all([
      pool.query<{
        id: string;
        channel_type: string;
        display_name: string;
        enabled: boolean;
        health_status: string;
        revision: number;
        configured_secret_count: string;
      }>(
        `SELECT connection.id, connection.channel_type,
                connection.display_name, connection.enabled,
                connection.health_status, connection.revision,
                count(secret.field_name)::text
                  AS configured_secret_count
         FROM channel_connections AS connection
         LEFT JOIN channel_secrets AS secret
           ON secret.connection_id = connection.id
         WHERE connection.user_id = $1
           AND connection.agent_id = $2
           AND connection.deleted_at IS NULL
         GROUP BY connection.id
         ORDER BY connection.channel_type, connection.id`,
        [scope.userId, scope.agentId],
      ),
      pool.query<{
        connection_id: string;
        effect: "allow" | "deny";
        count: string;
      }>(
        `SELECT connection_id, effect, count(*)::text AS count
         FROM channel_access_rules
         WHERE user_id = $1 AND agent_id = $2
         GROUP BY connection_id, effect
         ORDER BY connection_id, effect`,
        [scope.userId, scope.agentId],
      ),
      pool.query<{
        resource_type: string;
        resource_id: string;
        enabled: boolean;
        created_at: Date | string;
      }>(
        `SELECT resource_type, resource_id, enabled,
                created_at
         FROM agent_resource_grants
         WHERE user_id = $1 AND agent_id = $2
         ORDER BY resource_type, resource_id`,
        [scope.userId, scope.agentId],
      ),
      pool.query<{
        id: string;
        name: string;
        kind: string;
        status: string;
        requires_confirmation: boolean;
        granted: boolean;
      }>(
        `SELECT tool.id, tool.name, tool.kind, tool.status,
                tool.requires_confirmation,
                COALESCE(
                  resource_grant.enabled,
                  agent.inherits_user_resources
                ) AS granted
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
         ORDER BY tool.updated_at DESC, tool.id DESC
         LIMIT 500`,
        [scope.userId, scope.agentId],
      ),
      pool.query<{
        id: string;
        action: string;
        resource_type: string;
        resource_id: string;
        status: string;
        error_code: string | null;
        created_at: Date | string;
      }>(
        `SELECT id, action, resource_type, resource_id,
                status, error_code, created_at
         FROM admin_audit_logs
         WHERE user_id = $1 AND agent_id = $2
         ORDER BY created_at DESC, id DESC
         LIMIT 200`,
        [scope.userId, scope.agentId],
      ),
      pool.query<{
        id: string;
        display_name: string;
        status: string;
        supported_channel_types: string[];
        client_version: string | null;
        certificate_expires_at: Date | string;
        last_heartbeat_at: Date | string | null;
      }>(
        `SELECT id, display_name, status,
                supported_channel_types, client_version,
                certificate_expires_at, last_heartbeat_at
         FROM channel_runtime_nodes
         WHERE user_id = $1 AND agent_id = $2
         ORDER BY display_name, id`,
        [scope.userId, scope.agentId],
      ),
      pool.query<{
        id: string;
        name: string;
        status: string;
        verdict: string | null;
        scanned_at: string | null;
        updated_at: Date | string;
      }>(
        `SELECT id, name, status,
                scan_report->>'verdict' AS verdict,
                scan_report->>'scanned_at' AS scanned_at,
                updated_at
         FROM skills
         WHERE user_id = $1
           AND scan_report IS NOT NULL
         ORDER BY updated_at DESC, id DESC
         LIMIT 200`,
        [scope.userId],
      ),
    ]);
    signal?.throwIfAborted();

    const accessByConnection = new Map<
      string,
      { allow: number; deny: number }
    >();
    for (const row of access.rows) {
      const current =
        accessByConnection.get(row.connection_id) ?? {
          allow: 0,
          deny: 0,
        };
      current[row.effect] = safeInteger(row.count);
      accessByConnection.set(row.connection_id, current);
    }

    return {
      channels: channels.rows.map((row) => ({
        id: row.id,
        type: row.channel_type,
        name: row.display_name,
        enabled: row.enabled,
        health: row.health_status,
        revision: Number(row.revision),
        credentials: {
          configured:
            safeInteger(row.configured_secret_count) > 0,
          field_count: safeInteger(
            row.configured_secret_count,
          ),
        },
        access_rules:
          accessByConnection.get(row.id) ?? {
            allow: 0,
            deny: 0,
          },
      })),
      grants: grants.rows.map((row) => ({
        resource_type: row.resource_type,
        resource_id: row.resource_id,
        enabled: row.enabled,
        created_at: isoDate(row.created_at),
      })),
      tools: tools.rows.map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        status: row.status,
        granted: row.granted,
        requires_confirmation:
          row.requires_confirmation,
      })),
      audits: audits.rows.map((row) => ({
        id: row.id,
        action: row.action,
        resource_type: row.resource_type,
        resource_id: row.resource_id,
        status: row.status,
        error_code: row.error_code
          ? safeSecurityCode(row.error_code)
          : null,
        created_at: isoDate(row.created_at),
      })),
      runtime_nodes: nodes.rows.map((row) => ({
        id: row.id,
        name: row.display_name,
        status: row.status,
        supported_channel_types:
          row.supported_channel_types,
        client_version: row.client_version,
        certificate: {
          configured: true,
          expires_at: isoDate(
            row.certificate_expires_at,
          ),
        },
        last_heartbeat_at: row.last_heartbeat_at
          ? isoDate(row.last_heartbeat_at)
          : null,
      })),
      skills: skills.rows.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        verdict: row.verdict,
        scanned_at:
          row.scanned_at ?? isoDate(row.updated_at),
      })),
    };
  }

  return {
    getOverview: readSecurityState,

    async getToolGuard(scope, signal) {
      const state = await readSecurityState(scope, signal);
      const tools = state.tools;
      return {
        enabled: true,
        guarded_tools: tools
          .filter((tool) => tool.requires_confirmation)
          .map((tool) => tool.name),
        denied_tools: tools
          .filter(
            (tool) =>
              tool.status === "rejected" ||
              tool.granted === false,
          )
          .map((tool) => tool.name),
        custom_rules: [],
        disabled_rules: [],
        auto_denied_rules: [],
        shell_evasion_checks: {},
        digitalmate: {
          tools,
          default_action: "require_confirmation",
        },
        mutation_supported: false,
      };
    },

    async getBuiltinRules(scope, signal) {
      await requireActiveAgent(pool, scope, signal);
      return [];
    },

    async getSandbox(scope, signal) {
      await requireActiveAgent(pool, scope, signal);
      return {
        enabled: false,
        effective: false,
        reason: "p2_sandbox_frozen",
        mutation_supported: false,
      };
    },

    async getFileGuard(scope, signal) {
      await requireActiveAgent(pool, scope, signal);
      return {
        enabled: true,
        paths: [],
        allow_preview_outside_workspace: false,
        attachment_types: [
          "image/jpeg",
          "image/png",
          "image/webp",
          "application/pdf",
          "text/plain",
          "text/markdown",
          "application/json",
          "text/csv",
        ],
        mutation_supported: false,
      };
    },

    async getSkillScanner(scope, signal) {
      const state = await readSecurityState(scope, signal);
      return {
        mode: "block",
        timeout: 30,
        whitelist: [],
        digitalmate: {
          approval_required: true,
          scanned_skills: state.skills,
        },
        mutation_supported: false,
      };
    },

    async getBlockedHistory(scope, signal) {
      const state = await readSecurityState(scope, signal);
      return state.skills
        .filter(
          (skill) =>
            skill.verdict === "blocked" ||
            skill.verdict === "rejected",
        )
        .map((skill) => ({
          skill_name: skill.name,
          blocked_at: skill.scanned_at,
          max_severity: "high",
          findings: [],
          content_hash: "",
          action: "blocked",
          digitalmate: {
            id: skill.id,
            status: skill.status,
            verdict: skill.verdict,
          },
        }));
    },

    async getAllowNoAuthHosts(scope, signal) {
      await requireActiveAgent(pool, scope, signal);
      return {
        hosts: [],
        mutation_supported: false,
      };
    },
  };
}

export function createGetSecurityOverviewHandler(
  service: AdminSecurityService,
): AdminCompatHandler {
  return async (context) =>
    service.getOverview(context.scope, context.signal);
}

export function createGetToolGuardHandler(
  service: AdminSecurityService,
): AdminCompatHandler {
  return async (context) =>
    service.getToolGuard(context.scope, context.signal);
}

export function createGetBuiltinSecurityRulesHandler(
  service: AdminSecurityService,
): AdminCompatHandler {
  return async (context) =>
    service.getBuiltinRules(context.scope, context.signal);
}

export function createGetSandboxHandler(
  service: AdminSecurityService,
): AdminCompatHandler {
  return async (context) =>
    service.getSandbox(context.scope, context.signal);
}

export function createGetFileGuardHandler(
  service: AdminSecurityService,
): AdminCompatHandler {
  return async (context) =>
    service.getFileGuard(context.scope, context.signal);
}

export function createGetSkillScannerHandler(
  service: AdminSecurityService,
): AdminCompatHandler {
  return async (context) =>
    service.getSkillScanner(context.scope, context.signal);
}

export function createGetBlockedSkillsHandler(
  service: AdminSecurityService,
): AdminCompatHandler {
  return async (context) =>
    service.getBlockedHistory(context.scope, context.signal);
}

export function createGetAllowNoAuthHostsHandler(
  service: AdminSecurityService,
): AdminCompatHandler {
  return async (context) =>
    service.getAllowNoAuthHosts(context.scope, context.signal);
}

async function requireActiveAgent(
  pool: Pool,
  scope: AgentScope,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const result = await pool.query(
    `SELECT 1
     FROM digital_agents
     WHERE user_id = $1 AND id = $2
       AND status = 'active'`,
    [scope.userId, scope.agentId],
  );
  signal?.throwIfAborted();
  if (!result.rows[0]) {
    throw new Error("agent_not_found");
  }
}

function isoDate(value: Date | string): string {
  return new Date(value).toISOString();
}

function safeInteger(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : 0;
}

function safeSecurityCode(value: string): string {
  return /^[a-z0-9._:-]{1,160}$/u.test(value)
    ? value
    : "redacted_error";
}
