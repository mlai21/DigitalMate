import type { Pool } from "pg";
import { getPool } from "@/server/db/client";
import type {
  AgentResourceGrant,
  AgentResourceType,
  DigitalAgent,
} from "@/server/agents/types";

export function createAgentRepository(providedPool?: Pool) {
  const pool = providedPool ?? getPool();

  async function getDefault(userId: string): Promise<DigitalAgent | null> {
    const result = await pool.query(
      `SELECT *
       FROM digital_agents
       WHERE user_id = $1
         AND is_default = true
       LIMIT 1`,
      [userId],
    );
    return result.rows[0] ? mapAgent(result.rows[0]) : null;
  }

  return {
    getDefault,
    async ensureDefault(userId: string): Promise<DigitalAgent> {
      const existing = await getDefault(userId);
      if (existing) return existing;

      const result = await pool.query(
        `INSERT INTO digital_agents (
           user_id, slug, display_name, persona, is_default
         )
         SELECT $1, 'digitalmate', 'DigitalMate',
                COALESCE((SELECT persona FROM settings WHERE user_id = $1), '{}'::jsonb),
                true
         WHERE NOT EXISTS (
           SELECT 1 FROM digital_agents
           WHERE user_id = $1 AND is_default = true
         )
         ON CONFLICT (user_id, slug) DO UPDATE
         SET is_default = true,
             updated_at = now()
         RETURNING *`,
        [userId],
      );
      const agent = result.rows[0] ? mapAgent(result.rows[0]) : await getDefault(userId);
      if (!agent) throw new Error("default_agent_not_created");
      return agent;
    },

    async listActive(userId?: string): Promise<DigitalAgent[]> {
      const result = userId
        ? await pool.query(
            `SELECT *
             FROM digital_agents
             WHERE user_id = $1
               AND status = 'active'
             ORDER BY is_default DESC, created_at ASC, id ASC`,
            [userId],
          )
        : await pool.query(
            `SELECT *
             FROM digital_agents
             WHERE status = 'active'
             ORDER BY user_id ASC, is_default DESC, created_at ASC, id ASC`,
          );
      return result.rows.map(mapAgent);
    },

    async listResourceGrants(
      userId: string,
      agentId: string,
      resourceType?: AgentResourceType,
    ): Promise<AgentResourceGrant[]> {
      const result = resourceType
        ? await pool.query(
            `SELECT *
             FROM agent_resource_grants
             WHERE user_id = $1
               AND agent_id = $2
               AND resource_type = $3
             ORDER BY resource_id ASC`,
            [userId, agentId, resourceType],
          )
        : await pool.query(
            `SELECT *
             FROM agent_resource_grants
             WHERE user_id = $1
               AND agent_id = $2
             ORDER BY resource_type ASC, resource_id ASC`,
            [userId, agentId],
          );
      return result.rows.map(mapResourceGrant);
    },
  };
}

export type AgentRepository = ReturnType<typeof createAgentRepository>;

function mapAgent(row: Record<string, unknown>): DigitalAgent {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    slug: String(row.slug),
    displayName: String(row.display_name),
    persona:
      typeof row.persona === "object" && row.persona !== null
        ? (row.persona as Record<string, unknown>)
        : {},
    status: row.status as DigitalAgent["status"],
    isDefault: Boolean(row.is_default),
    inheritsUserResources: Boolean(row.inherits_user_resources),
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

function mapResourceGrant(row: Record<string, unknown>): AgentResourceGrant {
  return {
    userId: String(row.user_id),
    agentId: String(row.agent_id),
    resourceType: row.resource_type as AgentResourceType,
    resourceId: String(row.resource_id),
    enabled: Boolean(row.enabled),
  };
}
