import type { Pool } from "pg";

import type { AgentScope } from "@/server/agents/types";
import {
  AdminCompatError,
  type AdminCompatHandler,
} from "@/server/admin/compat/types";
import {
  CHANNEL_TYPES,
  getChannelManifest,
} from "@/server/channels/manifests/catalog";
import { STABLE_CAPABILITY_CODES } from "@/server/capabilities";

export type AdminPluginInfo = Readonly<{
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  enabled: boolean;
  loaded: boolean;
  plugin_type:
    | "tool"
    | "provider"
    | "hook"
    | "command"
    | "frontend"
    | "channel"
    | "general";
  frontend_entry?: string;
}>;

export type AdminPluginStatus = Readonly<{
  id: string;
  loaded: boolean;
  enabled: boolean;
  version?: string;
}>;

export type AdminPluginsService = Readonly<{
  list(
    scope: AgentScope,
    signal?: AbortSignal,
  ): Promise<readonly AdminPluginInfo[]>;
  getStatus(
    scope: AgentScope,
    pluginId: string,
    signal?: AbortSignal,
  ): Promise<AdminPluginStatus | null>;
}>;

export function createListPluginsHandler(
  service: AdminPluginsService,
): AdminCompatHandler {
  return async (context) =>
    service.list(context.scope, context.signal);
}

export function createGetPluginStatusHandler(
  service: AdminPluginsService,
): AdminCompatHandler {
  return async (context) => {
    const pluginId = decodePluginId(
      context.params.pluginId,
    );
    const status = await service.getStatus(
      context.scope,
      pluginId,
      context.signal,
    );
    if (!status) {
      throw new AdminCompatError(
        404,
        "plugin_not_found",
        "plugin_not_found",
      );
    }
    return status;
  };
}

export function createPluginCatalogHandler():
  AdminCompatHandler {
  return async () => ({
    updated_at: null,
    plugins: [],
    error: "plugin_extensions_frozen",
  });
}

export function createPluginMutationBlockedHandler():
  AdminCompatHandler {
  return async () => {
    throw new AdminCompatError(
      501,
      STABLE_CAPABILITY_CODES.plugins,
      "插件扩展需单独确认且当前冻结",
    );
  };
}

export function createPostgresAdminPluginsService(
  pool: Pool,
): AdminPluginsService {
  return {
    async list(scope, signal) {
      signal?.throwIfAborted();
      const [connections, skills, tools] = await Promise.all([
        pool.query<{
          channel_type: string;
          enabled: boolean;
        }>(
          `SELECT channel_type, bool_or(enabled) AS enabled
           FROM channel_connections
           WHERE user_id = $1
             AND agent_id = $2
             AND deleted_at IS NULL
           GROUP BY channel_type`,
          [scope.userId, scope.agentId],
        ),
        pool.query<{
          id: string;
          name: string;
          trigger: string;
          version: number;
          status: string;
          granted: boolean;
        }>(
          `SELECT skill.id::text,
                  skill.name,
                  skill.trigger,
                  skill.version,
                  skill.status,
                  COALESCE(grant_row.enabled, false) AS granted
           FROM skills AS skill
           LEFT JOIN agent_resource_grants AS grant_row
             ON grant_row.user_id = skill.user_id
            AND grant_row.agent_id = $2
            AND grant_row.resource_type = 'skill'
            AND grant_row.resource_id = skill.id::text
           WHERE skill.user_id = $1
           ORDER BY skill.name ASC, skill.id ASC`,
          [scope.userId, scope.agentId],
        ),
        pool.query<{
          id: string;
          name: string;
          description: string;
          revision: number;
          status: string;
          granted: boolean;
        }>(
          `SELECT tool.id::text,
                  tool.name,
                  tool.description,
                  tool.revision,
                  tool.status,
                  COALESCE(grant_row.enabled, false) AS granted
           FROM tool_registrations AS tool
           LEFT JOIN agent_resource_grants AS grant_row
             ON grant_row.user_id = tool.user_id
            AND grant_row.agent_id = $2
            AND grant_row.resource_type = 'tool'
            AND grant_row.resource_id = tool.id::text
           WHERE tool.user_id = $1
           ORDER BY tool.name ASC, tool.id ASC`,
          [scope.userId, scope.agentId],
        ),
      ]);
      signal?.throwIfAborted();
      const enabledChannels = new Map(
        connections.rows.map((row) => [
          row.channel_type,
          row.enabled,
        ]),
      );
      return [
        ...CHANNEL_TYPES.map((type): AdminPluginInfo => {
          const manifest = getChannelManifest(type);
          return {
            id: `channel:${type}`,
            name: manifest.label,
            version: "builtin",
            description: `DigitalMate 内置 ${manifest.label} 渠道`,
            author: "DigitalMate",
            enabled: enabledChannels.get(type) ?? false,
            loaded: true,
            plugin_type: "channel",
          };
        }),
        ...skills.rows.map((row): AdminPluginInfo => ({
          id: `skill:${row.id}`,
          name: row.name,
          version: String(row.version),
          description: row.trigger,
          author: "DigitalMate",
          enabled:
            row.status === "enabled" && row.granted,
          loaded: true,
          plugin_type: "general",
        })),
        ...tools.rows.map((row): AdminPluginInfo => ({
          id: `tool:${row.id}`,
          name: row.name,
          version: String(row.revision),
          description: row.description,
          author: "DigitalMate",
          enabled:
            row.status === "enabled" && row.granted,
          loaded: true,
          plugin_type: "tool",
        })),
      ];
    },
    async getStatus(scope, pluginId, signal) {
      const plugins = await this.list(scope, signal);
      const plugin = plugins.find(
        (candidate) => candidate.id === pluginId,
      );
      return plugin
        ? {
            id: plugin.id,
            loaded: plugin.loaded,
            enabled: plugin.enabled,
            version: plugin.version,
          }
        : null;
    },
  };
}

function decodePluginId(value: string | undefined): string {
  if (!value) {
    throw new AdminCompatError(
      400,
      "plugin_id_invalid",
      "plugin_id_invalid",
    );
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new AdminCompatError(
      400,
      "plugin_id_invalid",
      "plugin_id_invalid",
    );
  }
  if (
    decoded.length < 3
    || decoded.length > 200
    || !/^(channel|skill|tool):[a-zA-Z0-9._:-]+$/u.test(
      decoded,
    )
  ) {
    throw new AdminCompatError(
      400,
      "plugin_id_invalid",
      "plugin_id_invalid",
    );
  }
  return decoded;
}
