import type { Pool } from "pg";
import type { AgentScope } from "@/server/agents/types";
import { getPool } from "@/server/db/client";
import {
  defaultSettings,
  type CadenceSettings,
  type ModelRoutingSettings,
  type PersonaSettings,
  type ProactivitySettings,
  type SearchSettings,
} from "@/server/settings/defaults";

export type AgentSettingsUpdate = {
  persona: PersonaSettings;
  proactivity: ProactivitySettings;
  cadence: CadenceSettings;
  search: SearchSettings;
  modelRoutingOverride: Partial<ModelRoutingSettings>;
  expectedRevision: number;
};

export type EffectiveAgentSettings = {
  persona: PersonaSettings;
  proactivity: ProactivitySettings;
  cadence: CadenceSettings;
  search: SearchSettings;
  modelRouting: ModelRoutingSettings;
  modelRoutingOverride: Partial<ModelRoutingSettings>;
  revision: number;
};

export function createAgentSettingsRepository(providedPool?: Pool) {
  const pool = providedPool ?? getPool();

  async function ensure(scope: AgentScope): Promise<void> {
    await pool.query(
      `INSERT INTO agent_settings (
         user_id, agent_id, persona, proactivity, cadence, search
       )
       SELECT $1, $2, $3, $4, $5, $6
       FROM digital_agents
       WHERE digital_agents.user_id = $1
         AND digital_agents.id = $2
       ON CONFLICT (user_id, agent_id) DO NOTHING`,
      [
        scope.userId,
        scope.agentId,
        defaultSettings.persona,
        defaultSettings.proactivity,
        defaultSettings.cadence,
        defaultSettings.search,
      ],
    );
  }

  return {
    ensure,
    async get(scope: AgentScope): Promise<EffectiveAgentSettings> {
      await ensure(scope);
      const result = await pool.query(
        `SELECT agent_settings.persona,
                agent_settings.proactivity,
                agent_settings.cadence,
                agent_settings.search,
                agent_settings.model_routing_override,
                agent_settings.revision,
                settings.model_routing
         FROM agent_settings
         JOIN settings ON settings.user_id = agent_settings.user_id
         WHERE agent_settings.user_id = $1
           AND agent_settings.agent_id = $2`,
        [scope.userId, scope.agentId],
      );
      const row = result.rows[0];
      if (!row) throw new Error("agent_settings_not_found");
      const modelRoutingOverride = asModelRoutingOverride(row.model_routing_override);
      const userModelRouting = asModelRouting(row.model_routing);
      return {
        persona: mergeSettings(defaultSettings.persona, row.persona),
        proactivity: mergeSettings(defaultSettings.proactivity, row.proactivity),
        cadence: mergeSettings(defaultSettings.cadence, row.cadence),
        search: mergeSettings(defaultSettings.search, row.search),
        modelRouting: {
          ...userModelRouting,
          ...modelRoutingOverride,
        },
        modelRoutingOverride,
        revision: Number(row.revision),
      };
    },

    async update(scope: AgentScope, update: AgentSettingsUpdate): Promise<number> {
      const result = await pool.query<{ revision: number }>(
        `UPDATE agent_settings
         SET persona = $3,
             proactivity = $4,
             cadence = $5,
             search = $6,
             model_routing_override = $7,
             revision = revision + 1,
             updated_at = now()
         WHERE user_id = $1
           AND agent_id = $2
           AND revision = $8
         RETURNING revision`,
        [
          scope.userId,
          scope.agentId,
          update.persona,
          update.proactivity,
          update.cadence,
          update.search,
          update.modelRoutingOverride,
          update.expectedRevision,
        ],
      );
      if (!result.rows[0]) {
        throw Object.assign(new Error("revision_conflict"), {
          status: 409,
          code: "revision_conflict",
        });
      }
      return Number(result.rows[0].revision);
    },
  };
}

function asModelRoutingOverride(
  value: unknown,
): Partial<ModelRoutingSettings> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const row = value as Record<string, unknown>;
  const override: Partial<ModelRoutingSettings> = {};
  if (typeof row.main === "string" && row.main) override.main = row.main;
  if (typeof row.light === "string" && row.light) override.light = row.light;
  return override;
}

function asModelRouting(value: unknown): ModelRoutingSettings {
  const partial = asModelRoutingOverride(value);
  return {
    main: partial.main ?? defaultSettings.modelRouting.main,
    light: partial.light ?? defaultSettings.modelRouting.light,
  };
}

function mergeSettings<T extends Record<string, unknown>>(defaults: T, value: unknown): T {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return defaults;
  return { ...defaults, ...(value as Partial<T>) };
}
