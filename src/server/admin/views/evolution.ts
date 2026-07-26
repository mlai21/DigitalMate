import type { Pool, PoolClient } from "pg";
import type { AgentScope } from "@/server/agents/types";
import type {
  DbGoal,
  DbGoalStep,
} from "@/server/db/repositories";
import {
  hasPersistentGoalNetworkAuthorization as hasGoalNetworkAuthorization,
} from "@/server/goals/contract";
import {
  reduceGoalStatus,
  type GoalEvent,
  type GoalStatus,
} from "@/server/goals/state-machine";
import type { InterjectionPolicy } from "@/server/channels/interjection";
import {
  createAdminAgentProfileService,
} from "@/server/admin/agent-profile";
import type { GoalContract } from "@/server/goals/contract";
import {
  CHANNEL_TYPES,
} from "@/server/channels/manifests/catalog";
import {
  formatPgVector,
  redactSensitiveMemory,
  type MemoryKind,
} from "@/server/agent/memory";
import { embedText } from "@/server/llm/embeddings";
import { defaultSettings } from "@/server/settings/defaults";

export type AdminGoalAction =
  | "confirm"
  | "pause"
  | "resume"
  | "cancel"
  | "human_replied";

export type AdminInterjectionDecision = Readonly<{
  id: string;
  agentId: string;
  channel: string;
  externalConversationId: string;
  shouldInterject: boolean;
  reason: string;
  createdAt: Date;
}>;

export type AdminMemoryEntry = Readonly<{
  id: string;
  kind: MemoryKind;
  content: string;
  confidence: number;
  sourceMessageId: string | null;
  createdAt: Date;
  expiresAt: Date | null;
}>;

export type AdminReflectionEntry = Readonly<{
  id: string;
  positives: readonly string[];
  negatives: readonly string[];
  suggestions: readonly string[];
  status: "recorded" | "applied" | "dismissed";
  createdAt: Date;
}>;

export type AdminEvolutionMutation = Readonly<{
  operationId: string;
  confirmed: boolean;
}>;

export type AdminEvolutionService = Readonly<{
  getInterjections(
    scope: AgentScope,
    signal?: AbortSignal,
  ): Promise<unknown>;
  updateInterjectionPolicy(
    scope: AgentScope,
    policy: InterjectionPolicy,
    mutation: Readonly<{
      expectedRevision: number;
      operationId: string;
    }>,
    signal?: AbortSignal,
  ): Promise<unknown>;
  listGoals(
    scope: AgentScope,
    filters: Readonly<{ status?: GoalStatus }>,
    signal?: AbortSignal,
  ): Promise<unknown[]>;
  getGoal(
    scope: AgentScope,
    goalId: string,
    signal?: AbortSignal,
  ): Promise<unknown | null>;
  actOnGoal(
    scope: AgentScope,
    goalId: string,
    action: AdminGoalAction,
    mutation: Readonly<{
      expectedRevision: number;
      operationId: string;
    }>,
    signal?: AbortSignal,
  ): Promise<unknown | null>;
  listMemories(
    scope: AgentScope,
    filters: Readonly<{ kind?: MemoryKind; limit: number }>,
    signal?: AbortSignal,
  ): Promise<unknown>;
  updateMemory(
    scope: AgentScope,
    memoryId: string,
    input: Readonly<{
      kind: MemoryKind;
      content: string;
      confidence: number;
    }>,
    mutation: AdminEvolutionMutation,
    signal?: AbortSignal,
  ): Promise<unknown | null>;
  deleteMemory(
    scope: AgentScope,
    memoryId: string,
    mutation: AdminEvolutionMutation,
    signal?: AbortSignal,
  ): Promise<unknown | null>;
  listReflections(
    scope: AgentScope,
    filters: Readonly<{
      status?: AdminReflectionEntry["status"];
      limit: number;
    }>,
    signal?: AbortSignal,
  ): Promise<unknown>;
  actOnReflection(
    scope: AgentScope,
    reflectionId: string,
    action: "apply" | "dismiss",
    mutation: Readonly<{
      expectedRevision: number;
      operationId: string;
      confirmed: boolean;
      suggestionIndexes: readonly number[];
    }>,
    signal?: AbortSignal,
  ): Promise<unknown | null>;
}>;

export class AdminEvolutionError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "AdminEvolutionError";
    this.status = status;
    this.code = code;
  }
}

const VERIFIED_UNMENTIONED_GROUP_CHANNELS =
  new Set(["telegram", "slack"]);

export function hasPersistentGoalNetworkAuthorization(
  goal: DbGoal,
): boolean {
  return hasGoalNetworkAuthorization(goal);
}

export function projectInterjectionOverview(
  input: Readonly<{
    scope: AgentScope;
    policy: InterjectionPolicy;
    now: Date;
    decisions: readonly AdminInterjectionDecision[];
    channels?: readonly string[];
  }>,
) {
  const decisions = input.decisions
    .filter((decision) => decision.agentId === input.scope.agentId)
    .sort(
      (left, right) =>
        right.createdAt.getTime() - left.createdAt.getTime(),
    );
  const channels: Record<string, Record<string, unknown>> = {};
  const channelNames = new Set([
    ...(input.channels ?? []),
    ...decisions.map((decision) => decision.channel),
  ]);
  for (const channel of channelNames) {
    const sameChannel = decisions.filter(
      (candidate) => candidate.channel === channel,
    );
    const sent = sameChannel.filter(
      (candidate) => candidate.shouldInterject,
    );
    const lastSent = sent[0]?.createdAt ?? null;
    channels[channel] = {
      capability:
        VERIFIED_UNMENTIONED_GROUP_CHANNELS.has(channel)
          ? "full"
          : "capability_limited",
      ...(!VERIFIED_UNMENTIONED_GROUP_CHANNELS.has(channel)
        ? {
            limitation:
              "unmentioned_group_events_unavailable",
          }
        : {}),
      sent_last_hour: sent.filter(
        (candidate) =>
          input.now.getTime() - candidate.createdAt.getTime() <
          60 * 60 * 1_000,
      ).length,
      sent_today: sent.filter(
        (candidate) =>
          utcDate(candidate.createdAt) === utcDate(input.now),
      ).length,
      next_allowed_at: lastSent
        ? new Date(
            lastSent.getTime() +
              input.policy.minIntervalMinutes * 60_000,
          ).toISOString()
        : null,
    };
  }
  return {
    policy: input.policy,
    channels,
    decisions: decisions.map((decision) => ({
      id: decision.id,
      channel: decision.channel,
      external_conversation_id:
        decision.externalConversationId,
      should_interject: decision.shouldInterject,
      reason: decision.reason,
      created_at: decision.createdAt.toISOString(),
    })),
  };
}

export function reduceAdminGoalAction(
  status: GoalStatus,
  action: AdminGoalAction,
) {
  return reduceGoalStatus(status, toGoalEvent(action));
}

export function authorizeConfirmedGoalContract(
  goalId: string,
  contract: GoalContract,
): GoalContract {
  if (!contract.scope.allowedTools.includes("web_search")) {
    return contract;
  }
  return {
    ...contract,
    authorization: {
      type: "goal_contract",
      sourceId: goalId,
      networkEnabled: true,
    },
  };
}

export function projectGoalDetail(
  scope: AgentScope,
  goal: DbGoal,
  steps: readonly DbGoalStep[],
) {
  if (
    goal.userId !== scope.userId ||
    goal.agentId !== scope.agentId
  ) {
    throw new Error("goal_scope_mismatch");
  }
  return {
    id: goal.id,
    title: goal.title,
    status: goal.status,
    revision: goal.revision,
    contract: {
      objective: goal.contract.objective,
      success_criteria: goal.contract.successCriteria,
      cadence: goal.contract.cadence,
      scope: {
        allowed_tools: goal.contract.scope.allowedTools,
        forbidden: goal.contract.scope.forbidden,
      },
      budget: goal.contract.budget,
      stop_conditions: goal.contract.stopConditions,
      deliverable: goal.contract.deliverable,
      network_authorized:
        hasPersistentGoalNetworkAuthorization(goal),
    },
    progress_summary: goal.progressSummary,
    budget_used: {
      rounds: goal.budgetUsed.rounds,
      tokens: goal.budgetUsed.tokens,
      cost_usd: goal.budgetUsed.costUsd,
    },
    no_progress_rounds: goal.noProgressRounds,
    needs_human_prompt: goal.needsHumanPrompt,
    next_run_at: goal.nextRunAt?.toISOString() ?? null,
    finished_at: goal.finishedAt?.toISOString() ?? null,
    created_at: goal.createdAt.toISOString(),
    updated_at: goal.updatedAt.toISOString(),
    steps: steps
      .filter(
        (step) =>
          step.agentId === scope.agentId &&
          step.goalId === goal.id,
      )
      .map((step) => ({
        id: step.id,
        round: step.round,
        phase: step.phase,
        intent: step.intent,
        evidence_count: step.evidence.length,
        failed_paths_count: step.failedPaths.length,
        tokens_used: step.tokensUsed,
        duration_ms: step.durationMs,
        error_code: step.error ? "goal_step_failed" : null,
        created_at: step.createdAt.toISOString(),
      })),
  };
}

export function projectMemoryEntry(
  entry: AdminMemoryEntry,
) {
  return {
    id: entry.id,
    kind: entry.kind,
    content: entry.content,
    confidence: entry.confidence,
    source: entry.sourceMessageId
      ? {
          type: "message",
          id: entry.sourceMessageId,
        }
      : {
          type: "system",
          id: null,
        },
    created_at: entry.createdAt.toISOString(),
    expires_at: entry.expiresAt?.toISOString() ?? null,
  };
}

export function projectReflectionEntry(
  entry: AdminReflectionEntry,
) {
  return {
    id: entry.id,
    positives: [...entry.positives],
    negatives: [...entry.negatives],
    suggestions: [...entry.suggestions],
    status: entry.status,
    created_at: entry.createdAt.toISOString(),
  };
}

export function createPostgresAdminEvolutionService(
  pool: Pool,
): AdminEvolutionService {
  const profileService = createAdminAgentProfileService(pool);
  return {
    async getInterjections(scope, signal) {
      signal?.throwIfAborted();
      const [profile, decisions] = await Promise.all([
        profileService.read(scope, signal),
        pool.query(
          `SELECT id, channel, external_conversation_id,
                  should_interject, reason, created_at
           FROM interjection_decisions
           WHERE user_id = $1 AND agent_id = $2
           ORDER BY created_at DESC
           LIMIT 500`,
          [scope.userId, scope.agentId],
        ),
      ]);
      signal?.throwIfAborted();
      return {
        ...projectInterjectionOverview({
          scope,
          policy: profile.proactivity,
          now: new Date(),
          decisions: decisions.rows.map((row) => ({
            id: String(row.id),
            agentId: scope.agentId,
            channel: String(row.channel),
            externalConversationId: String(
              row.external_conversation_id,
            ),
            shouldInterject: Boolean(row.should_interject),
            reason: String(row.reason),
            createdAt: new Date(row.created_at as string | Date),
          })),
          channels: CHANNEL_TYPES,
        }),
        revision: profile.revision,
      };
    },

    async updateInterjectionPolicy(
      scope,
      policy,
      mutation,
      signal,
    ) {
      signal?.throwIfAborted();
      const profile = await profileService.read(scope, signal);
      const result = await profileService.update(
        {
          scope,
          operationId: mutation.operationId,
          expectedRevision: mutation.expectedRevision,
          displayName: profile.displayName,
          persona: profile.persona,
          settings: {
            proactivity: policy,
            cadence: profile.cadence,
            search: profile.search,
          },
        },
        signal,
      );
      return {
        policy,
        revision: result.revision,
      };
    },

    async listGoals(scope, filters, signal) {
      signal?.throwIfAborted();
      const result = await pool.query(
        `SELECT *
         FROM goals
         WHERE user_id = $1
           AND agent_id = $2
           AND ($3::text IS NULL OR status = $3)
         ORDER BY updated_at DESC, id DESC
         LIMIT 500`,
        [
          scope.userId,
          scope.agentId,
          filters.status ?? null,
        ],
      );
      signal?.throwIfAborted();
      return result.rows.map((row) =>
        projectGoalSummary(mapGoalRow(row)),
      );
    },

    async getGoal(scope, goalId, signal) {
      signal?.throwIfAborted();
      const [goalResult, stepResult] = await Promise.all([
        pool.query(
          `SELECT *
           FROM goals
           WHERE user_id = $1 AND agent_id = $2 AND id = $3`,
          [scope.userId, scope.agentId, goalId],
        ),
        pool.query(
          `SELECT goal_steps.*
           FROM goal_steps
           JOIN goals ON goals.id = goal_steps.goal_id
           WHERE goals.user_id = $1
             AND goals.agent_id = $2
             AND goals.id = $3
           ORDER BY goal_steps.round ASC,
                    goal_steps.created_at ASC`,
          [scope.userId, scope.agentId, goalId],
        ),
      ]);
      signal?.throwIfAborted();
      if (!goalResult.rows[0]) return null;
      return projectGoalDetail(
        scope,
        mapGoalRow(goalResult.rows[0]),
        stepResult.rows.map(mapGoalStepRow),
      );
    },

    async actOnGoal(
      scope,
      goalId,
      action,
      mutation,
      signal,
    ) {
      signal?.throwIfAborted();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const selected = await client.query(
          `SELECT *
           FROM goals
           WHERE user_id = $1 AND agent_id = $2 AND id = $3
           FOR UPDATE`,
          [scope.userId, scope.agentId, goalId],
        );
        const row = selected.rows[0];
        if (!row) {
          await client.query("ROLLBACK");
          return null;
        }
        const replay = await client.query(
          `SELECT 1
           FROM admin_audit_logs
           WHERE user_id = $1
             AND agent_id = $2
             AND resource_type = 'goal'
             AND resource_id = $3
             AND confirmation_source->>'requestId' = $4
             AND status = 'success'
           LIMIT 1`,
          [
            scope.userId,
            scope.agentId,
            goalId,
            mutation.operationId,
          ],
        );
        if (replay.rows[0]) {
          await client.query("COMMIT");
          return projectGoalSummary(mapGoalRow(row));
        }
        if (Number(row.revision) !== mutation.expectedRevision) {
          throw new AdminEvolutionError(
            409,
            "revision_conflict",
          );
        }
        const transition = reduceAdminGoalAction(
          row.status as GoalStatus,
          action,
        );
        if (!transition.ok) {
          throw new AdminEvolutionError(
            409,
            "invalid_goal_transition",
          );
        }
        const isTerminal = transition.status === "cancelled";
        const currentGoal = mapGoalRow(row);
        const nextContract =
          action === "confirm"
            ? authorizeConfirmedGoalContract(
                goalId,
                currentGoal.contract,
              )
            : currentGoal.contract;
        const nextRunAt =
          transition.status === "running" ||
          transition.status === "confirmed"
            ? new Date()
            : null;
        const updated = await client.query(
          `UPDATE goals
           SET status = $4,
               next_run_at = $5,
               contract = $8::jsonb,
               needs_human_prompt = CASE
                 WHEN $4 = 'running' THEN NULL
                 ELSE needs_human_prompt
               END,
               finished_at = CASE
                 WHEN $6 THEN now()
                 ELSE finished_at
               END,
               revision = revision + 1,
               updated_at = now()
           WHERE user_id = $1
             AND agent_id = $2
             AND id = $3
             AND revision = $7
           RETURNING *`,
          [
            scope.userId,
            scope.agentId,
            goalId,
            transition.status,
            nextRunAt,
            isTerminal,
            mutation.expectedRevision,
            JSON.stringify(nextContract),
          ],
        );
        if (!updated.rows[0]) {
          throw new AdminEvolutionError(
            409,
            "revision_conflict",
          );
        }
        await client.query(
          `INSERT INTO admin_audit_logs (
             user_id, agent_id, action, resource_type, resource_id,
             before_summary, after_summary, confirmation_source,
             status, error_code
           )
           VALUES (
             $1, $2, $3, 'goal', $4, $5::jsonb, $6::jsonb,
             $7::jsonb, 'success', NULL
           )`,
          [
            scope.userId,
            scope.agentId,
            `goal.${action}`,
            goalId,
            JSON.stringify({
              status: row.status,
              revision: Number(row.revision),
            }),
            JSON.stringify({
              status: transition.status,
              revision: Number(updated.rows[0].revision),
            }),
            JSON.stringify({
              type: "console",
              requestId: mutation.operationId,
            }),
          ],
        );
        signal?.throwIfAborted();
        await client.query("COMMIT");
        return projectGoalSummary(
          mapGoalRow(updated.rows[0]),
        );
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async listMemories(scope, filters, signal) {
      signal?.throwIfAborted();
      const result = await pool.query(
        `SELECT id, kind, content, confidence,
                source_message_id, created_at, expires_at
         FROM memory_entries
         WHERE user_id = $1
           AND agent_id = $2
           AND deleted_at IS NULL
           AND (expires_at IS NULL OR expires_at > now())
           AND ($3::text IS NULL OR kind = $3)
         ORDER BY created_at DESC, id DESC
         LIMIT $4`,
        [
          scope.userId,
          scope.agentId,
          filters.kind ?? null,
          filters.limit,
        ],
      );
      signal?.throwIfAborted();
      return {
        items: result.rows.map((row) =>
          projectMemoryEntry(mapMemoryRow(row)),
        ),
        next_cursor: null,
      };
    },

    async updateMemory(
      scope,
      memoryId,
      input,
      mutation,
      signal,
    ) {
      if (!mutation.confirmed) {
        throw new AdminEvolutionError(
          409,
          "confirmation_required",
        );
      }
      signal?.throwIfAborted();
      const content = redactSensitiveMemory(input.content);
      if (!content) {
        throw new AdminEvolutionError(
          400,
          "invalid_memory_content",
        );
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const selected = await client.query(
          `SELECT id, kind, content, confidence,
                  source_message_id, created_at, expires_at
           FROM memory_entries
           WHERE user_id = $1
             AND agent_id = $2
             AND id = $3
             AND deleted_at IS NULL
           FOR UPDATE`,
          [scope.userId, scope.agentId, memoryId],
        );
        const row = selected.rows[0];
        if (!row) {
          await client.query("ROLLBACK");
          return null;
        }
        if (
          await hasAuditReplay(
            client,
            scope,
            "memory",
            memoryId,
            "memory.update",
            mutation.operationId,
          )
        ) {
          await client.query("COMMIT");
          return projectMemoryEntry(mapMemoryRow(row));
        }
        const embedding = formatPgVector(
          await embedText(content, undefined, signal),
        );
        signal?.throwIfAborted();
        const updated = await client.query(
          `UPDATE memory_entries
           SET kind = $4,
               content = $5,
               confidence = $6,
               embedding = $7::vector
           WHERE user_id = $1
             AND agent_id = $2
             AND id = $3
             AND deleted_at IS NULL
           RETURNING id, kind, content, confidence,
                     source_message_id, created_at, expires_at`,
          [
            scope.userId,
            scope.agentId,
            memoryId,
            input.kind,
            content,
            input.confidence,
            embedding,
          ],
        );
        await insertEvolutionAudit(client, {
          scope,
          action: "memory.update",
          resourceType: "memory",
          resourceId: memoryId,
          before: {
            kind: row.kind,
            confidence: Number(row.confidence),
          },
          after: {
            kind: input.kind,
            confidence: input.confidence,
            content_changed: row.content !== content,
          },
          operationId: mutation.operationId,
        });
        signal?.throwIfAborted();
        await client.query("COMMIT");
        return projectMemoryEntry(
          mapMemoryRow(updated.rows[0]),
        );
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async deleteMemory(
      scope,
      memoryId,
      mutation,
      signal,
    ) {
      if (!mutation.confirmed) {
        throw new AdminEvolutionError(
          409,
          "confirmation_required",
        );
      }
      signal?.throwIfAborted();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const selected = await client.query(
          `SELECT id, kind, content, confidence,
                  source_message_id, created_at, expires_at,
                  deleted_at
           FROM memory_entries
           WHERE user_id = $1
             AND agent_id = $2
             AND id = $3
           FOR UPDATE`,
          [scope.userId, scope.agentId, memoryId],
        );
        const row = selected.rows[0];
        if (!row) {
          await client.query("ROLLBACK");
          return null;
        }
        if (
          await hasAuditReplay(
            client,
            scope,
            "memory",
            memoryId,
            "memory.delete",
            mutation.operationId,
          )
        ) {
          await client.query("COMMIT");
          return {
            id: memoryId,
            deleted: true,
          };
        }
        if (row.deleted_at !== null) {
          await client.query("ROLLBACK");
          return null;
        }
        await client.query(
          `UPDATE memory_entries
           SET deleted_at = now()
           WHERE user_id = $1
             AND agent_id = $2
             AND id = $3
             AND deleted_at IS NULL`,
          [scope.userId, scope.agentId, memoryId],
        );
        await insertEvolutionAudit(client, {
          scope,
          action: "memory.delete",
          resourceType: "memory",
          resourceId: memoryId,
          before: {
            kind: row.kind,
            confidence: Number(row.confidence),
          },
          after: { deleted: true },
          operationId: mutation.operationId,
        });
        signal?.throwIfAborted();
        await client.query("COMMIT");
        return {
          id: memoryId,
          deleted: true,
        };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async listReflections(scope, filters, signal) {
      signal?.throwIfAborted();
      const [profile, result] = await Promise.all([
        profileService.read(scope, signal),
        pool.query(
          `SELECT id, positives, negatives, suggestions,
                  status, created_at
           FROM reflections
           WHERE user_id = $1
             AND agent_id = $2
             AND ($3::text IS NULL OR status = $3)
           ORDER BY created_at DESC, id DESC
           LIMIT $4`,
          [
            scope.userId,
            scope.agentId,
            filters.status ?? null,
            filters.limit,
          ],
        ),
      ]);
      signal?.throwIfAborted();
      return {
        items: result.rows.map((row) =>
          projectReflectionEntry(mapReflectionRow(row)),
        ),
        profile_revision: profile.revision,
        next_cursor: null,
      };
    },

    async actOnReflection(
      scope,
      reflectionId,
      action,
      mutation,
      signal,
    ) {
      if (!mutation.confirmed) {
        throw new AdminEvolutionError(
          409,
          "confirmation_required",
        );
      }
      signal?.throwIfAborted();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const selected = await client.query(
          `SELECT reflection.id, reflection.positives,
                  reflection.negatives,
                  reflection.suggestions,
                  reflection.status,
                  reflection.created_at,
                  digital_agents.display_name,
                  agent_settings.persona,
                  agent_settings.revision
           FROM reflections AS reflection
           JOIN digital_agents
             ON digital_agents.user_id = reflection.user_id
            AND digital_agents.id = reflection.agent_id
            AND digital_agents.status = 'active'
           JOIN agent_settings
             ON agent_settings.user_id = digital_agents.user_id
            AND agent_settings.agent_id = digital_agents.id
           WHERE reflection.user_id = $1
             AND reflection.agent_id = $2
             AND reflection.id = $3
           FOR UPDATE OF reflection, digital_agents,
                         agent_settings`,
          [scope.userId, scope.agentId, reflectionId],
        );
        const row = selected.rows[0];
        if (!row) {
          await client.query("ROLLBACK");
          return null;
        }
        if (
          await hasAuditReplay(
            client,
            scope,
            "reflection",
            reflectionId,
            `reflection.${action}`,
            mutation.operationId,
          )
        ) {
          await client.query("COMMIT");
          return {
            ...projectReflectionEntry(mapReflectionRow(row)),
            profile_revision: Number(row.revision),
          };
        }
        if (Number(row.revision) !== mutation.expectedRevision) {
          throw new AdminEvolutionError(
            409,
            "revision_conflict",
          );
        }
        if (row.status !== "recorded") {
          throw new AdminEvolutionError(
            409,
            "reflection_already_resolved",
          );
        }
        const suggestions = stringArray(row.suggestions);
        const selectedSuggestions =
          action === "apply"
            ? selectSuggestions(
                suggestions,
                mutation.suggestionIndexes,
              )
            : [];
        let revision = Number(row.revision);
        if (action === "apply") {
          const persona = mergePersona(row.persona);
          const nextPersona = {
            ...persona,
            style: mergeReflectionSuggestions(
              persona.style,
              selectedSuggestions,
            ),
          };
          const updatedSettings = await client.query<{
            revision: number;
          }>(
            `UPDATE agent_settings
             SET persona = $3::jsonb,
                 revision = revision + 1,
                 updated_at = now()
             WHERE user_id = $1
               AND agent_id = $2
               AND revision = $4
             RETURNING revision`,
            [
              scope.userId,
              scope.agentId,
              JSON.stringify(nextPersona),
              mutation.expectedRevision,
            ],
          );
          if (!updatedSettings.rows[0]) {
            throw new AdminEvolutionError(
              409,
              "revision_conflict",
            );
          }
          revision = Number(
            updatedSettings.rows[0].revision,
          );
          await client.query(
            `UPDATE digital_agents
             SET persona = $3::jsonb, updated_at = now()
             WHERE user_id = $1 AND id = $2`,
            [
              scope.userId,
              scope.agentId,
              JSON.stringify(nextPersona),
            ],
          );
        }
        const status =
          action === "apply" ? "applied" : "dismissed";
        await client.query(
          `UPDATE reflections
           SET status = $4
           WHERE user_id = $1 AND agent_id = $2 AND id = $3`,
          [scope.userId, scope.agentId, reflectionId, status],
        );
        await insertEvolutionAudit(client, {
          scope,
          action: `reflection.${action}`,
          resourceType: "reflection",
          resourceId: reflectionId,
          before: {
            status: row.status,
            profile_revision: Number(row.revision),
          },
          after: {
            status,
            profile_revision: revision,
            applied_suggestion_indexes:
              action === "apply"
                ? mutation.suggestionIndexes
                : [],
          },
          operationId: mutation.operationId,
        });
        signal?.throwIfAborted();
        await client.query("COMMIT");
        return {
          ...projectReflectionEntry({
            ...mapReflectionRow(row),
            status,
          }),
          profile_revision: revision,
        };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

function projectGoalSummary(goal: DbGoal) {
  return {
    id: goal.id,
    title: goal.title,
    status: goal.status,
    revision: goal.revision,
    objective: goal.contract.objective,
    network_authorized:
      hasPersistentGoalNetworkAuthorization(goal),
    progress_summary: goal.progressSummary,
    budget_used: {
      rounds: goal.budgetUsed.rounds,
      tokens: goal.budgetUsed.tokens,
      cost_usd: goal.budgetUsed.costUsd,
    },
    needs_human_prompt: goal.needsHumanPrompt,
    next_run_at: goal.nextRunAt?.toISOString() ?? null,
    finished_at: goal.finishedAt?.toISOString() ?? null,
    created_at: goal.createdAt.toISOString(),
    updated_at: goal.updatedAt.toISOString(),
  };
}

function mapMemoryRow(
  row: Record<string, unknown>,
): AdminMemoryEntry {
  return {
    id: String(row.id),
    kind: row.kind as MemoryKind,
    content: String(row.content),
    confidence: Number(row.confidence),
    sourceMessageId:
      typeof row.source_message_id === "string"
        ? row.source_message_id
        : null,
    createdAt: new Date(row.created_at as Date | string),
    expiresAt: dateOrNull(row.expires_at),
  };
}

function mapReflectionRow(
  row: Record<string, unknown>,
): AdminReflectionEntry {
  return {
    id: String(row.id),
    positives: stringArray(row.positives),
    negatives: stringArray(row.negatives),
    suggestions: stringArray(row.suggestions),
    status:
      row.status as AdminReflectionEntry["status"],
    createdAt: new Date(row.created_at as Date | string),
  };
}

async function hasAuditReplay(
  client: PoolClient,
  scope: AgentScope,
  resourceType: string,
  resourceId: string,
  action: string,
  operationId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
     FROM admin_audit_logs
     WHERE user_id = $1
       AND agent_id = $2
       AND resource_type = $3
       AND resource_id = $4
       AND action = $5
       AND confirmation_source->>'requestId' = $6
       AND status = 'success'
     LIMIT 1`,
    [
      scope.userId,
      scope.agentId,
      resourceType,
      resourceId,
      action,
      operationId,
    ],
  );
  return Boolean(result.rows[0]);
}

async function insertEvolutionAudit(
  client: PoolClient,
  input: Readonly<{
    scope: AgentScope;
    action: string;
    resourceType: string;
    resourceId: string;
    before: Readonly<Record<string, unknown>>;
    after: Readonly<Record<string, unknown>>;
    operationId: string;
  }>,
): Promise<void> {
  await client.query(
    `INSERT INTO admin_audit_logs (
       user_id, agent_id, action, resource_type,
       resource_id, before_summary, after_summary,
       confirmation_source, status, error_code
     )
     VALUES (
       $1, $2, $3, $4, $5,
       $6::jsonb, $7::jsonb, $8::jsonb,
       'success', NULL
     )`,
    [
      input.scope.userId,
      input.scope.agentId,
      input.action,
      input.resourceType,
      input.resourceId,
      JSON.stringify(input.before),
      JSON.stringify(input.after),
      JSON.stringify({
        type: "console",
        requestId: input.operationId,
        confirmed: true,
      }),
    ],
  );
}

function selectSuggestions(
  suggestions: readonly string[],
  indexes: readonly number[],
): string[] {
  const unique = [...new Set(indexes)];
  if (
    unique.length === 0 ||
    unique.some(
      (index) =>
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= suggestions.length,
    )
  ) {
    throw new AdminEvolutionError(
      400,
      "invalid_reflection_suggestions",
    );
  }
  return unique.map((index) => suggestions[index]);
}

function mergePersona(
  value: unknown,
): typeof defaultSettings.persona {
  const record =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  return {
    name:
      typeof record.name === "string" && record.name.trim()
        ? record.name.slice(0, 80)
        : defaultSettings.persona.name,
    style:
      typeof record.style === "string" &&
      record.style.trim()
        ? record.style.slice(0, 4_000)
        : defaultSettings.persona.style,
    emojiHabit:
      typeof record.emojiHabit === "string"
        ? record.emojiHabit.slice(0, 500)
        : defaultSettings.persona.emojiHabit,
  };
}

function mergeReflectionSuggestions(
  currentStyle: string,
  suggestions: readonly string[],
): string {
  const additions = suggestions
    .map((suggestion) =>
      suggestion.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim(),
    )
    .filter(
      (suggestion) =>
        suggestion.length > 0 &&
        !currentStyle.includes(suggestion),
    );
  if (additions.length === 0) return currentStyle;
  const next = `${currentStyle}\n改进偏好：${additions.join("；")}`;
  if (next.length > 4_000) {
    throw new AdminEvolutionError(
      400,
      "persona_style_too_long",
    );
  }
  return next;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.slice(0, 4_000))
    : [];
}

function mapGoalRow(
  row: Record<string, unknown>,
): DbGoal {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    agentId: String(row.agent_id),
    title: String(row.title),
    contract: asGoalContract(row.contract),
    status: row.status as GoalStatus,
    progressSummary: String(row.progress_summary ?? ""),
    reportDraft: String(row.report_draft ?? ""),
    budgetUsed: asBudgetUsed(row.budget_used),
    noProgressRounds: Number(row.no_progress_rounds ?? 0),
    runningStep:
      typeof row.running_step === "string"
        ? row.running_step
        : null,
    needsHumanPrompt:
      typeof row.needs_human_prompt === "string"
        ? row.needs_human_prompt
        : null,
    conversationId:
      typeof row.conversation_id === "string"
        ? row.conversation_id
        : null,
    nextRunAt: dateOrNull(row.next_run_at),
    finishedAt: dateOrNull(row.finished_at),
    revision: Number(row.revision ?? 1),
    createdAt: new Date(row.created_at as string | Date),
    updatedAt: new Date(row.updated_at as string | Date),
  };
}

function mapGoalStepRow(
  row: Record<string, unknown>,
): DbGoalStep {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    goalId: String(row.goal_id),
    round: Number(row.round),
    phase: row.phase as DbGoalStep["phase"],
    intent: String(row.intent ?? ""),
    evidence: Array.isArray(row.evidence) ? row.evidence : [],
    candidate: String(row.candidate ?? ""),
    verifyResult: row.verify_result,
    failedPaths: Array.isArray(row.failed_paths)
      ? row.failed_paths
      : [],
    tokensUsed: Number(row.tokens_used ?? 0),
    durationMs:
      row.duration_ms === null ||
      row.duration_ms === undefined
        ? null
        : Number(row.duration_ms),
    error:
      typeof row.error === "string" ? row.error : null,
    createdAt: new Date(row.created_at as string | Date),
  };
}

function asGoalContract(value: unknown): GoalContract {
  return (
    typeof value === "object" &&
    value !== null
      ? value
      : {}
  ) as GoalContract;
}

function asBudgetUsed(value: unknown): DbGoal["budgetUsed"] {
  const record =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  return {
    rounds: Number(record.rounds ?? 0),
    tokens: Number(record.tokens ?? 0),
    costUsd: Number(record.costUsd ?? 0),
  };
}

function dateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const date = new Date(value as string | Date);
  return Number.isFinite(date.getTime()) ? date : null;
}

function toGoalEvent(action: AdminGoalAction): GoalEvent {
  switch (action) {
    case "confirm":
      return { type: "contract_confirmed" };
    case "pause":
      return { type: "user_paused" };
    case "resume":
      return { type: "user_resumed" };
    case "cancel":
      return { type: "user_cancelled" };
    case "human_replied":
      return { type: "human_replied" };
  }
}

function utcDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}
