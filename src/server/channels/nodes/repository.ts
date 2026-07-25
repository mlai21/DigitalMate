import type { Pool, PoolClient } from "pg";

import type { AgentScope } from "@/server/agents/types";
import type { ChannelType } from "@/server/channels/manifests/catalog";

type Queryable = Pick<Pool | PoolClient, "query">;

export type RegisterChannelNodeInput = Readonly<{
  userId: string;
  displayName: string;
  certificateFingerprint: Buffer;
  supportedChannelTypes: readonly ChannelType[];
}>;

export function createChannelNodeRepository(pool: Pool) {
  return {
    async register(input: RegisterChannelNodeInput): Promise<{
      id: string;
      created: boolean;
    }> {
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO channel_runtime_nodes (
           user_id, display_name, certificate_fingerprint,
           supported_channel_types
         )
         VALUES ($1, $2, $3, $4::text[])
         ON CONFLICT (user_id, certificate_fingerprint) DO NOTHING
         RETURNING id`,
        [
          input.userId,
          input.displayName,
          input.certificateFingerprint,
          [...input.supportedChannelTypes],
        ],
      );
      if (inserted.rows[0]) {
        return { id: inserted.rows[0].id, created: true };
      }
      const existing = await pool.query<{ id: string }>(
        `SELECT id
         FROM channel_runtime_nodes
         WHERE user_id = $1
           AND certificate_fingerprint = $2`,
        [input.userId, input.certificateFingerprint],
      );
      const row = existing.rows[0];
      if (!row) {
        throw new Error("channel_node_conflict_not_visible");
      }
      return { id: row.id, created: false };
    },

    async bindConnection(
      scope: AgentScope,
      nodeId: string,
      connectionId: string,
    ): Promise<void> {
      const client = await pool.connect();
      let destroyClient = false;
      try {
        await client.query("BEGIN");
        await bindConnection(client, scope, nodeId, connectionId);
        await client.query("COMMIT");
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          destroyClient = true;
        }
        throw error;
      } finally {
        client.release(destroyClient);
      }
    },

    async isBound(
      userId: string,
      nodeId: string,
      connectionId: string,
    ): Promise<boolean> {
      const result = await pool.query(
        `SELECT 1
         FROM channel_node_bindings
         WHERE user_id = $1
           AND node_id = $2
           AND connection_id = $3`,
        [userId, nodeId, connectionId],
      );
      return result.rowCount === 1;
    },
  };
}

async function bindConnection(
  client: Queryable,
  scope: AgentScope,
  nodeId: string,
  connectionId: string,
): Promise<void> {
  const updated = await client.query(
    `UPDATE channel_connections
     SET runtime_node_id = $1,
         updated_at = now()
     WHERE id = $2
       AND user_id = $3
       AND agent_id = $4`,
    [nodeId, connectionId, scope.userId, scope.agentId],
  );
  if (updated.rowCount !== 1) {
    throw new Error("channel_connection_not_found");
  }
  await client.query(
    `INSERT INTO channel_node_bindings (
       connection_id, user_id, agent_id, node_id
     )
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (connection_id) DO UPDATE
     SET node_id = EXCLUDED.node_id`,
    [connectionId, scope.userId, scope.agentId, nodeId],
  );
}
