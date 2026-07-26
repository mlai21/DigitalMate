import type { Pool } from "pg";

import type {
  AdminChannelConfigSnapshot,
  AdminChannelHealth,
  AdminChannelHealthResolver,
} from "@/server/admin/compat/handlers/channels";
import type {
  ChannelType,
} from "@/server/channels/manifests/catalog";

const NODE_HEARTBEAT_TIMEOUT_MS = 45_000;

type ConnectionPrerequisiteRow = Readonly<{
  id: string;
  node_id: string | null;
  node_status: "connected" | "disconnected" | "revoked" | null;
  last_heartbeat_at: Date | string | null;
  supported_channel_types: ChannelType[] | null;
}>;

export function createAdminChannelHealthResolver(
  pool: Pool,
  options: Readonly<{
    publicBaseUrl: string | null;
    isOneBotConnected?: (connectionId: string) => boolean;
    now?: () => Date;
  }>,
): AdminChannelHealthResolver {
  const now = options.now ?? (() => new Date());
  return async (scope, type, snapshot, signal) => {
    signal?.throwIfAborted();
    if (!snapshot.enabled) {
      return {
        status: "disabled",
        detail: {},
      };
    }
    if (type === "voice") {
      if (!isHttpsRoot(options.publicBaseUrl)) {
        return blocked("public_https_required");
      }
      if (!hasTwilioConfiguration(snapshot)) {
        return blocked("twilio_configuration_required");
      }
      return prerequisiteSatisfied(snapshot);
    }

    const connection = await readConnectionPrerequisite(
      pool,
      scope,
      type,
    );
    signal?.throwIfAborted();
    if (type === "onebot") {
      if (
        !connection
        || (
          options.isOneBotConnected
            ? !options.isOneBotConnected(connection.id)
            : (
              snapshot.health.status !== "connected"
              && snapshot.health.status !== "degraded"
            )
        )
      ) {
        return blocked("companion_service_required");
      }
      return prerequisiteSatisfied(snapshot);
    }
    if (type === "imessage") {
      return isOnlineNode(connection, type, now())
        ? prerequisiteSatisfied(snapshot)
        : blocked("macos_node_required");
    }
    if (type === "sip") {
      return isOnlineNode(connection, type, now())
        ? prerequisiteSatisfied(snapshot)
        : blocked("media_node_required");
    }
    return snapshot.health;
  };
}

async function readConnectionPrerequisite(
  pool: Pool,
  scope: Readonly<{ userId: string; agentId: string }>,
  type: ChannelType,
): Promise<ConnectionPrerequisiteRow | null> {
  const result = await pool.query<ConnectionPrerequisiteRow>(
    `SELECT
       connection.id,
       node.id AS node_id,
       node.status AS node_status,
       node.last_heartbeat_at,
       node.supported_channel_types
     FROM channel_connections AS connection
     LEFT JOIN channel_node_bindings AS binding
       ON binding.connection_id = connection.id
      AND binding.user_id = connection.user_id
      AND binding.agent_id = connection.agent_id
     LEFT JOIN channel_runtime_nodes AS node
       ON node.id = COALESCE(
         binding.node_id,
         connection.runtime_node_id
      )
      AND node.user_id = connection.user_id
      AND node.agent_id = connection.agent_id
     WHERE connection.user_id = $1
       AND connection.agent_id = $2
       AND connection.channel_type = $3
       AND connection.deleted_at IS NULL
     ORDER BY connection.updated_at DESC, connection.id ASC
     LIMIT 1`,
    [scope.userId, scope.agentId, type],
  );
  return result.rows[0] ?? null;
}

function isOnlineNode(
  connection: ConnectionPrerequisiteRow | null,
  type: "imessage" | "sip",
  now: Date,
): boolean {
  if (
    !Number.isFinite(now.getTime())
    || !connection?.node_id
    || connection.node_status !== "connected"
    || !connection.supported_channel_types?.includes(type)
    || !connection.last_heartbeat_at
  ) {
    return false;
  }
  const heartbeat = new Date(connection.last_heartbeat_at);
  if (!Number.isFinite(heartbeat.getTime())) return false;
  const age = now.getTime() - heartbeat.getTime();
  return age >= 0 && age <= NODE_HEARTBEAT_TIMEOUT_MS;
}

function isHttpsRoot(value: string | null): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:"
      && url.pathname === "/"
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
    );
  } catch {
    return false;
  }
}

function hasTwilioConfiguration(
  snapshot: AdminChannelConfigSnapshot,
): boolean {
  const requiredConfig = [
    snapshot.config.twilio_account_sid,
    snapshot.config.phone_number,
    snapshot.config.phone_number_sid,
  ];
  return (
    requiredConfig.every(
      (value) =>
        typeof value === "string"
        && value.trim().length > 0,
    )
    && snapshot.secrets.twilio_auth_token?.configured === true
  );
}

function blocked(reason: string): AdminChannelHealth {
  return {
    status: "blocked",
    reason,
    detail: { code: reason },
  };
}

function prerequisiteSatisfied(
  snapshot: AdminChannelConfigSnapshot,
): AdminChannelHealth {
  if (snapshot.health.status !== "blocked") {
    return snapshot.health;
  }
  return {
    status: "starting",
    detail: {},
  };
}
