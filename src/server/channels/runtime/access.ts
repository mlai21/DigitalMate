import type { Pool } from "pg";

import type { AgentScope } from "@/server/agents/types";

import type { ChannelEventRecord } from "./event-repository";
import type { NormalizedChannelEvent } from "./types";

export type ChannelAccessRule = Readonly<{
  targetKind: "sender" | "conversation";
  targetId: string;
  effect: "allow" | "deny";
}>;

export type ChannelAccessSnapshot = Readonly<{
  exists: boolean;
  enabled: boolean;
  deleted: boolean;
  directDisabled: boolean;
  groupDisabled: boolean;
  directPolicy: "open" | "allowlist";
  groupPolicy: "open" | "allowlist";
  allowFrom: readonly string[];
  requireMention: boolean;
  directApprovalRequired: boolean;
  groupApprovalRequired: boolean;
  rules: readonly ChannelAccessRule[];
}>;

export type ChannelAccessDecision =
  | Readonly<{ kind: "allowed"; allowed: true }>
  | Readonly<{
      kind: "rejected" | "pending";
      allowed: false;
      reason: string;
    }>;

type ChannelConnectionAccessRow = {
  enabled: boolean;
  deleted_at: Date | null;
  config: Record<string, unknown>;
};

type ChannelAccessRuleRow = {
  target_kind: "sender" | "conversation";
  target_id: string;
  effect: "allow" | "deny";
};

export function evaluateChannelAccess(
  event: NormalizedChannelEvent,
  snapshot: ChannelAccessSnapshot,
): ChannelAccessDecision {
  if (!snapshot.exists || snapshot.deleted) {
    return rejected("connection_unavailable");
  }
  if (!snapshot.enabled) {
    return rejected("connection_disabled");
  }
  if (event.chatType === "direct" && snapshot.directDisabled) {
    return rejected("direct_disabled");
  }
  if (event.chatType === "group" && snapshot.groupDisabled) {
    return rejected("group_disabled");
  }
  if (
    event.rawSummary.isBotEvent === true
    || event.rawSummary.isSelfEvent === true
  ) {
    return rejected("bot_or_self_event");
  }

  const matchingRules = snapshot.rules.filter((rule) =>
    ruleMatches(rule, event)
  );
  if (matchingRules.some((rule) => rule.effect === "deny")) {
    return rejected("access_denied");
  }
  const explicitlyAllowed =
    snapshot.allowFrom.includes(event.externalSenderId)
    || matchingRules.some((rule) => rule.effect === "allow");
  const policy = event.chatType === "direct"
    ? snapshot.directPolicy
    : snapshot.groupPolicy;
  const approvalRequired = event.chatType === "direct"
    ? snapshot.directApprovalRequired
    : snapshot.groupApprovalRequired;

  if (
    event.chatType === "group"
    && snapshot.requireMention
    && !event.mentioned
  ) {
    return rejected("mention_required");
  }
  if (!explicitlyAllowed && approvalRequired) {
    return {
      kind: "pending",
      allowed: false,
      reason: "approval_required",
    };
  }
  if (policy === "allowlist" && !explicitlyAllowed) {
    return rejected("allowlist_required");
  }
  return { kind: "allowed", allowed: true };
}

export function createChannelAccessControl(pool: Pool) {
  return {
    async evaluate(
      scope: AgentScope,
      event: NormalizedChannelEvent,
    ): Promise<ChannelAccessDecision> {
      const snapshot = await readAccessSnapshot(pool, scope, event);
      return evaluateChannelAccess(event, snapshot);
    },

    async recordPendingRequest(
      scope: AgentScope,
      event: ChannelEventRecord,
    ): Promise<void> {
      if (
        event.scope.userId !== scope.userId
        || event.scope.agentId !== scope.agentId
      ) {
        throw new Error("channel_access_request_scope_mismatch");
      }
      const normalized = event.normalizedEvent;
      await pool.query(
        `INSERT INTO channel_access_requests (
           user_id, agent_id, connection_id, event_id,
           chat_type, external_sender_id,
           external_conversation_id
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT DO NOTHING`,
        [
          scope.userId,
          scope.agentId,
          event.connectionId,
          event.id,
          normalized.chatType,
          normalized.externalSenderId,
          normalized.externalConversationId,
        ],
      );
    },
  };
}

async function readAccessSnapshot(
  pool: Pool,
  scope: AgentScope,
  event: NormalizedChannelEvent,
): Promise<ChannelAccessSnapshot> {
  const connection = await pool.query<ChannelConnectionAccessRow>(
    `SELECT enabled, deleted_at, config
     FROM channel_connections
     WHERE id = $1
       AND user_id = $2
       AND agent_id = $3`,
    [event.connectionId, scope.userId, scope.agentId],
  );
  const row = connection.rows[0];
  if (!row) {
    return missingSnapshot();
  }
  const rules = await pool.query<ChannelAccessRuleRow>(
    `SELECT target_kind, target_id, effect
     FROM channel_access_rules
     WHERE connection_id = $1
       AND user_id = $2
       AND agent_id = $3
     ORDER BY created_at, id`,
    [event.connectionId, scope.userId, scope.agentId],
  );
  return snapshotFromConfig(row, rules.rows);
}

function snapshotFromConfig(
  row: ChannelConnectionAccessRow,
  rules: readonly ChannelAccessRuleRow[],
): ChannelAccessSnapshot {
  return {
    exists: true,
    enabled: row.enabled,
    deleted: row.deleted_at !== null,
    directDisabled: readBoolean(row.config, "dm_disabled"),
    groupDisabled: readBoolean(row.config, "group_disabled"),
    directPolicy: readPolicy(row.config, "dm_policy"),
    groupPolicy: readPolicy(row.config, "group_policy"),
    allowFrom: readStringList(row.config, "allow_from"),
    requireMention: readBoolean(row.config, "require_mention"),
    directApprovalRequired: readBoolean(
      row.config,
      "access_control_dm",
    ),
    groupApprovalRequired: readBoolean(
      row.config,
      "access_control_group",
    ),
    rules: rules.map((rule) => ({
      targetKind: rule.target_kind,
      targetId: rule.target_id,
      effect: rule.effect,
    })),
  };
}

function missingSnapshot(): ChannelAccessSnapshot {
  return {
    exists: false,
    enabled: false,
    deleted: true,
    directDisabled: true,
    groupDisabled: true,
    directPolicy: "allowlist",
    groupPolicy: "allowlist",
    allowFrom: [],
    requireMention: true,
    directApprovalRequired: false,
    groupApprovalRequired: false,
    rules: [],
  };
}

function ruleMatches(
  rule: ChannelAccessRule,
  event: NormalizedChannelEvent,
): boolean {
  return rule.targetKind === "sender"
    ? rule.targetId === event.externalSenderId
    : rule.targetId === event.externalConversationId;
}

function rejected(reason: string): ChannelAccessDecision {
  return { kind: "rejected", allowed: false, reason };
}

function readBoolean(
  config: Record<string, unknown>,
  key: string,
): boolean {
  return config[key] === true;
}

function readPolicy(
  config: Record<string, unknown>,
  key: string,
): "open" | "allowlist" {
  return config[key] === "allowlist" ? "allowlist" : "open";
}

function readStringList(
  config: Record<string, unknown>,
  key: string,
): string[] {
  const value = config[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
