import type { Pool, PoolClient } from "pg";
import {
  formatPgVector,
  lexicalRelevanceScore,
  redactSensitiveMemory,
  type ExtractedMemory,
  type MemoryKind,
  type RankableMemory,
} from "@/server/agent/memory";
import { embedText } from "@/server/llm/embeddings";
import type { EnabledToolContext, SkillContext, ToolLogInput } from "@/server/agent/run-agent";
import type { NormalizedChannelMessage } from "@/server/channels/types";
import type { ReflectionRecord } from "@/server/evolution/reflection";
import type { SkillDraft } from "@/server/evolution/skills";
import { buildPersonalDataExport } from "@/server/admin/personal-data";
import type { LlmUsageLogInput } from "@/server/llm/usage";
import type { ToolRegistrationDraft } from "@/server/tasks/tools";
import {
  TaskCompletionAmbiguousError,
  TaskCompletionNotCommittedError,
} from "@/server/tasks/completion-errors";
import { defaultSettings } from "@/server/settings/defaults";
import { DEFAULT_GOAL_BUDGET_USED, type GoalBudgetUsed, type GoalContract } from "@/server/goals/contract";
import type { GoalStatus } from "@/server/goals/state-machine";
import { getPool, getTurnLockPool, getUserDataLockPool } from "@/server/db/client";
import {
  ATTACHMENT_LIMITS,
  type AttachmentKind,
  type AttachmentStatus,
} from "@/server/attachments/types";
import type { AgentScope } from "@/server/agents/types";
import { createAgentRepository } from "@/server/agents/repository";
import { createAgentSettingsRepository } from "@/server/settings/agent-settings";

const EPISODIC_MEMORY_TTL_DAYS = 180;
const ACTIVE_MEMORY_CONDITION = "deleted_at IS NULL AND (expires_at IS NULL OR expires_at > now())";
const PERSONAL_DATA_EXPORT_COLUMNS = {
  digital_agents: [
    "id", "user_id", "slug", "display_name", "persona", "status", "is_default",
    "inherits_user_resources", "created_at", "updated_at",
  ],
  agent_settings: [
    "user_id", "agent_id", "persona", "proactivity", "cadence", "search",
    "model_routing_override", "revision", "updated_at",
  ],
  agent_resource_grants: [
    "user_id", "agent_id", "resource_type", "resource_id", "enabled", "created_at",
  ],
  projects: ["id", "user_id", "agent_id", "name", "description", "created_at", "updated_at"],
  conversations: [
    "id", "user_id", "agent_id", "channel", "title", "project_id", "pinned", "created_at", "updated_at",
  ],
  messages: [
    "id", "user_id", "agent_id", "conversation_id", "role", "content",
    "visible_to_user", "memory_processed", "created_at",
  ],
  conversation_summaries: [
    "id", "user_id", "agent_id", "conversation_id", "summary", "message_count", "created_at",
  ],
  memory_entries: [
    "id", "user_id", "agent_id", "kind", "content", "confidence",
    "source_message_id", "expires_at", "deleted_at", "created_at",
  ],
  tool_call_logs: [
    "id", "user_id", "agent_id", "conversation_id", "goal_id", "tool_name",
    "input_summary", "output_summary", "status", "duration_ms", "error", "created_at",
  ],
  proactive_tasks: [
    "id", "user_id", "agent_id", "conversation_id", "kind", "content",
    "scheduled_at", "status", "metadata", "sent_at", "created_at", "updated_at",
  ],
  channel_identities: [
    "id", "user_id", "agent_id", "channel", "external_user_id", "display_name", "created_at", "updated_at",
  ],
  channel_messages: [
    "id", "user_id", "agent_id", "conversation_id", "channel", "external_conversation_id",
    "external_message_id", "sender_id", "chat_type", "text", "occurred_at", "created_at",
  ],
  interjection_decisions: [
    "id", "user_id", "agent_id", "conversation_id", "channel_message_id", "channel",
    "external_conversation_id", "should_interject", "reason", "created_at",
  ],
  reflections: [
    "id", "user_id", "agent_id", "positives", "negatives", "suggestions",
    "source_window", "status", "created_at",
  ],
  skills: [
    "id", "user_id", "name", "trigger", "content", "status", "source", "source_url",
    "version", "scan_report", "usage_count", "last_used_at", "created_at", "updated_at",
  ],
  skill_revisions: [
    "id", "user_id", "skill_id", "proposed_content", "reason", "status", "created_at", "updated_at",
  ],
  skill_usage_logs: [
    "id", "user_id", "agent_id", "skill_id", "conversation_id", "triggered_by", "created_at",
  ],
  task_runs: [
    "id", "user_id", "agent_id", "conversation_id", "kind", "status", "input_summary",
    "output_summary", "error", "metadata", "created_at", "updated_at",
  ],
  task_artifacts: [
    "id", "user_id", "agent_id", "task_run_id", "file_name", "mime_type", "metadata", "created_at",
  ],
  tool_registrations: [
    "id", "user_id", "name", "description", "kind", "status",
    "requires_confirmation", "created_at", "updated_at",
  ],
  llm_usage_logs: [
    "id", "user_id", "agent_id", "conversation_id", "purpose", "model",
    "input_tokens", "output_tokens", "total_tokens", "created_at",
  ],
  memory_jobs: [
    "id", "user_id", "agent_id", "conversation_id", "status", "created_at", "updated_at",
  ],
  goals: [
    "id", "user_id", "agent_id", "title", "contract", "status", "progress_summary",
    "report_draft", "budget_used", "no_progress_rounds", "needs_human_prompt",
    "conversation_id", "next_run_at", "finished_at", "created_at", "updated_at",
  ],
  settings: [
    "id", "user_id", "persona", "proactivity", "model_routing", "cadence", "search", "updated_at",
  ],
} as const;
const GOAL_STEP_EXPORT_COLUMNS = [
  "id", "agent_id", "goal_id", "round", "phase", "intent", "evidence", "candidate",
  "verify_result", "failed_paths", "tokens_used", "duration_ms", "error", "created_at",
] as const;
const ATTACHMENT_EXPORT_COLUMNS = [
  "id", "user_id", "agent_id", "message_id", "kind", "file_name", "mime_type",
  "size_bytes", "text_truncated", "status", "error_code", "created_at", "updated_at",
] as const;
const SENSITIVE_EXPORT_KEY_SEGMENTS = new Set([
  "secret",
  "token",
  "nonce",
  "ciphertext",
  "password",
  "credential",
  "credentials",
]);
const SENSITIVE_EXPORT_KEY_CONCEPTS = new Set([
  "authtag",
  "apikey",
  "privatekey",
  "accesskey",
  "storagekey",
  "storagepath",
  "extractedtext",
  "replytoken",
  "pollcursor",
  "temporarypath",
]);

export type DbUser = {
  id: string;
  displayName: string;
};

export type DbConversation = {
  id: string;
  userId: string;
  agentId: string;
  channel: string;
  title: string;
  projectId: string | null;
  pinned: boolean;
  updatedAt: Date;
};

export type DbProject = {
  id: string;
  userId: string;
  agentId: string;
  name: string;
  description: string;
  updatedAt: Date;
};

export type DbConversationSummaryRow = DbConversation & {
  messageCount: number;
  lastMessageAt: Date | null;
};

export type DbSkill = {
  id: string;
  userId: string;
  name: string;
  trigger: string;
  content: string;
  status: "pending" | "enabled" | "disabled" | "rejected";
  source: "manual" | "agent" | "task" | "imported";
  sourceUrl: string | null;
  version: number;
  scanReport: unknown;
  usageCount: number;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type DbSkillRevision = {
  id: string;
  userId: string;
  skillId: string;
  skillName: string;
  currentContent: string;
  proposedContent: string;
  reason: string;
  status: "pending" | "applied" | "rejected";
  createdAt: Date;
};

export type DbMessage = {
  id: string;
  userId: string;
  agentId: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: Date;
};

export type DbMessageAttachment = {
  id: string;
  userId: string;
  agentId: string;
  messageId: string | null;
  kind: AttachmentKind;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  extractedText: string | null;
  textTruncated: boolean;
  status: DbAttachmentStatus;
  errorCode: string | null;
  deletionClaimToken: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type DbAttachmentStatus = AttachmentStatus | "deleting";

export type DbMemoryEntry = RankableMemory & {
  agentId: string;
  kind: string;
  confidence: number;
};

export type DbGoal = {
  id: string;
  userId: string;
  agentId: string;
  title: string;
  contract: GoalContract;
  status: GoalStatus;
  progressSummary: string;
  reportDraft: string;
  budgetUsed: GoalBudgetUsed;
  noProgressRounds: number;
  runningStep: string | null;
  needsHumanPrompt: string | null;
  conversationId: string | null;
  nextRunAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type GoalStepPhase = "collecting" | "drafting" | "verifying" | "committed" | "failed";

export type DbGoalStep = {
  id: string;
  agentId: string;
  goalId: string;
  round: number;
  phase: GoalStepPhase;
  intent: string;
  evidence: unknown[];
  candidate: string;
  verifyResult: unknown;
  failedPaths: unknown[];
  tokensUsed: number;
  durationMs: number | null;
  error: string | null;
  createdAt: Date;
};

export type DbProactiveTask = {
  id: string;
  userId: string;
  agentId: string;
  conversationId: string;
  kind: "reminder" | "follow_up" | "share";
  content: string;
  scheduledAt: Date;
  status: string;
  metadata: Record<string, unknown>;
};

export type UserDataRequestFence = Readonly<{
  userId: string;
  epoch: string;
}>;

export type UserDataLease = Readonly<{
  userId: string;
  epoch: string;
  mode: "shared" | "exclusive";
  release(): Promise<void>;
}>;

export function createRepositories(
  providedPool?: Pool,
  providedTurnLockPool?: Pool,
  providedUserDataLockPool?: Pool,
) {
  const pool = providedPool ?? getPool();
  const turnLockPool = providedTurnLockPool ?? (providedPool ? pool : getTurnLockPool());
  const userDataLockPool = providedUserDataLockPool
    ?? (providedPool ? turnLockPool : getUserDataLockPool());
  const agents = createAgentRepository(pool);

  async function verifyTaskCompletionAfterCommitError(
    verificationPool: Pool,
    scope: AgentScope,
    taskRunId: string,
    artifactIds: string[],
  ): Promise<"committed" | "not_committed" | "ambiguous"> {
    let verificationClient: PoolClient | undefined;
    let verificationFailed = false;
    try {
      verificationClient = await verificationPool.connect();
      const task = await verificationClient.query<{ status: string }>(
        `SELECT status
         FROM task_runs
         WHERE user_id = $1 AND agent_id = $2 AND id = $3`,
        [scope.userId, scope.agentId, taskRunId],
      );
      if (task.rows.length !== 1) return "ambiguous";

      let artifactRows: Array<{ id: string; status: string }> = [];
      if (artifactIds.length > 0) {
        const artifacts = await verificationClient.query<{ id: string; status: string }>(
          `SELECT id, status
           FROM task_artifacts
           WHERE user_id = $1
             AND agent_id = $2
             AND task_run_id = $3
             AND id = ANY($4::uuid[])`,
          [scope.userId, scope.agentId, taskRunId, artifactIds],
        );
        artifactRows = artifacts.rows;
      }

      const exactArtifactIds = new Set(artifactRows.map((artifact) => artifact.id));
      if (
        artifactRows.length !== artifactIds.length
        || artifactIds.some((artifactId) => !exactArtifactIds.has(artifactId))
      ) {
        return "ambiguous";
      }

      const allArtifactsReady = artifactRows.every((artifact) => artifact.status === "ready");
      if (task.rows[0].status === "succeeded" && allArtifactsReady) {
        return "committed";
      }

      const allArtifactsPending = artifactRows.every((artifact) => artifact.status === "pending");
      if (task.rows[0].status === "running" && allArtifactsPending) {
        return "not_committed";
      }

      return "ambiguous";
    } catch {
      verificationFailed = true;
      return "ambiguous";
    } finally {
      if (verificationFailed) {
        verificationClient?.release(true);
      } else {
        verificationClient?.release();
      }
    }
  }

  async function ensureUserDataEpoch(userId: string): Promise<void> {
    await pool.query(
      `INSERT INTO user_data_epochs (user_id)
       VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
  }

  async function beginUserDataRequest(userId: string): Promise<UserDataRequestFence> {
    await ensureUserDataEpoch(userId);
    const result = await pool.query<{ epoch: string }>(
      "SELECT epoch::text AS epoch FROM user_data_epochs WHERE user_id = $1",
      [userId],
    );
    const epoch = result.rows[0]?.epoch;
    if (epoch === undefined) throw new Error("user_data_epoch_missing");
    return { userId, epoch };
  }

  async function acquireSharedUserDataLease(
    fence: UserDataRequestFence,
    options: { signal?: AbortSignal } = {},
  ): Promise<UserDataLease> {
    const lockKey = `user-data-quiescence:${fence.userId}`;
    const client = await connectPoolClient(userDataLockPool, options.signal);
    let locked = false;
    let destroyed = false;
    const abortPendingQuery = () => {
      if (destroyed) return;
      destroyed = true;
      client.release(true);
    };
    options.signal?.addEventListener("abort", abortPendingQuery, { once: true });
    try {
      options.signal?.throwIfAborted();
      await client.query(
        "SELECT pg_advisory_lock_shared(hashtextextended($1, 0))",
        [lockKey],
      );
      options.signal?.throwIfAborted();
      locked = true;
      const current = await client.query<{ epoch: string }>(
        "SELECT epoch::text AS epoch FROM user_data_epochs WHERE user_id = $1",
        [fence.userId],
      );
      options.signal?.throwIfAborted();
      if (current.rows[0]?.epoch !== fence.epoch) {
        throw new Error("user_data_epoch_changed");
      }
    } catch (error) {
      if (locked && !destroyed) {
        await releaseAdvisoryLease(client, lockKey, "shared").catch(() => undefined);
      } else if (!destroyed) {
        client.release(true);
      }
      options.signal?.throwIfAborted();
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", abortPendingQuery);
    }
    return createAdvisoryLease(client, lockKey, fence.userId, fence.epoch, "shared");
  }

  async function acquireExclusiveClearLease(userId: string): Promise<UserDataLease> {
    await ensureUserDataEpoch(userId);
    const lockKey = `user-data-quiescence:${userId}`;
    const client = await userDataLockPool.connect();
    let locked = false;
    try {
      await client.query(
        "SELECT pg_advisory_lock(hashtextextended($1, 0))",
        [lockKey],
      );
      locked = true;
      const result = await client.query<{ epoch: string }>(
        `UPDATE user_data_epochs
         SET epoch = epoch + 1,
             updated_at = now()
         WHERE user_id = $1
         RETURNING epoch::text AS epoch`,
        [userId],
      );
      const epoch = result.rows[0]?.epoch;
      if (epoch === undefined) throw new Error("user_data_epoch_missing");
      return createAdvisoryLease(client, lockKey, userId, epoch, "exclusive");
    } catch (error) {
      if (locked) {
        await releaseAdvisoryLease(client, lockKey, "exclusive").catch(() => undefined);
      } else {
        client.release(true);
      }
      throw error;
    }
  }

  return {
    agents,
    userDataMutations: {
      beginRequest: beginUserDataRequest,
      acquireSharedLease: acquireSharedUserDataLease,
      acquireExclusiveClearLease,
    },
    agentSettings: createAgentSettingsRepository(pool),
    users: {
      async ensureDefault(): Promise<DbUser> {
        const existing = await pool.query<{ id: string; display_name: string }>(
          "SELECT id, display_name FROM users ORDER BY created_at ASC LIMIT 1",
        );
        if (existing.rows[0]) return mapUser(existing.rows[0]);

        const created = await pool.query<{ id: string; display_name: string }>(
          "INSERT INTO users (display_name) VALUES ($1) RETURNING id, display_name",
          ["Tang"],
        );
        await ensureSettings(pool, created.rows[0].id);
        return mapUser(created.rows[0]);
      },
    },
    conversations: {
      async getOrCreateDefault(scope: AgentScope): Promise<DbConversation> {
        const existing = await pool.query(
          "SELECT * FROM conversations WHERE user_id = $1 AND agent_id = $2 AND channel = 'web' ORDER BY updated_at DESC LIMIT 1",
          [scope.userId, scope.agentId],
        );
        if (existing.rows[0]) return mapConversation(existing.rows[0]);

        const created = await pool.query(
          "INSERT INTO conversations (user_id, agent_id, title) VALUES ($1, $2, $3) RETURNING *",
          [scope.userId, scope.agentId, "和 DigitalMate 的对话"],
        );
        return mapConversation(created.rows[0]);
      },
      async create(scope: AgentScope, input?: { title?: string; projectId?: string | null }): Promise<DbConversation> {
        const created = await pool.query(
          `INSERT INTO conversations (user_id, agent_id, title, project_id)
           SELECT $1, $2, $3, project.id
           FROM (SELECT $4::uuid AS requested_id) AS requested
           LEFT JOIN projects AS project
             ON project.user_id = $1 AND project.agent_id = $2 AND project.id = requested.requested_id
           WHERE requested.requested_id IS NULL OR project.id IS NOT NULL
           RETURNING conversations.*`,
          [scope.userId, scope.agentId, input?.title?.trim() || "新的对话", input?.projectId ?? null],
        );
        if (!created.rows[0]) throw new Error("project_not_found");
        return mapConversation(created.rows[0]);
      },
      async get(scope: AgentScope, conversationId: string): Promise<DbConversation | null> {
        const result = await pool.query("SELECT * FROM conversations WHERE user_id = $1 AND agent_id = $2 AND id = $3", [
          scope.userId,
          scope.agentId,
          conversationId,
        ]);
        return result.rows[0] ? mapConversation(result.rows[0]) : null;
      },
      async list(scope: AgentScope): Promise<DbConversation[]> {
        const result = await pool.query(
          "SELECT * FROM conversations WHERE user_id = $1 AND agent_id = $2 ORDER BY updated_at DESC",
          [scope.userId, scope.agentId],
        );
        return result.rows.map(mapConversation);
      },
      async listWithStats(scope: AgentScope): Promise<DbConversationSummaryRow[]> {
        const result = await pool.query(
          `SELECT c.*,
                  count(m.id) FILTER (WHERE m.visible_to_user = true)::int AS message_count,
                  max(m.created_at) AS last_message_at
           FROM conversations c
           LEFT JOIN messages m
             ON m.conversation_id = c.id AND m.user_id = c.user_id AND m.agent_id = c.agent_id
           WHERE c.user_id = $1 AND c.agent_id = $2
           GROUP BY c.id
           ORDER BY c.pinned DESC, c.updated_at DESC`,
          [scope.userId, scope.agentId],
        );
        return result.rows.map((row) => ({
          ...mapConversation(row),
          messageCount: Number(row.message_count ?? 0),
          lastMessageAt: (row.last_message_at as Date | null) ?? null,
        }));
      },
      async update(
        scope: AgentScope,
        conversationId: string,
        input: { title?: string; pinned?: boolean; projectId?: string | null },
      ): Promise<DbConversation | null> {
        const result = await pool.query(
          `UPDATE conversations SET
             title = COALESCE($4, title),
             pinned = COALESCE($5, pinned),
             project_id = CASE WHEN $6 THEN $7::uuid ELSE project_id END,
             updated_at = now()
           WHERE user_id = $1 AND agent_id = $2 AND id = $3
             AND (
               $6 = false
               OR $7::uuid IS NULL
               OR EXISTS (
                 SELECT 1 FROM projects
                 WHERE projects.user_id = $1 AND projects.agent_id = $2 AND projects.id = $7
               )
             )
           RETURNING *`,
          [
            scope.userId,
            scope.agentId,
            conversationId,
            input.title?.trim() || null,
            input.pinned ?? null,
            input.projectId !== undefined,
            input.projectId ?? null,
          ],
        );
        return result.rows[0] ? mapConversation(result.rows[0]) : null;
      },
      async setTitleIfDefault(scope: AgentScope, conversationId: string, title: string): Promise<void> {
        const trimmed = title.trim();
        if (!trimmed) return;
        await pool.query(
          `UPDATE conversations SET title = $4
           WHERE user_id = $1 AND agent_id = $2 AND id = $3
             AND title IN ('新的对话', '和 DigitalMate 的对话')`,
          [scope.userId, scope.agentId, conversationId, trimmed.slice(0, 60)],
        );
      },
      async delete(scope: AgentScope, conversationId: string): Promise<void> {
        await pool.query(
          "DELETE FROM conversations WHERE user_id = $1 AND agent_id = $2 AND id = $3",
          [scope.userId, scope.agentId, conversationId],
        );
      },
    },
    projects: {
      async create(scope: AgentScope, input: { name: string; description?: string }): Promise<DbProject> {
        const result = await pool.query(
          "INSERT INTO projects (user_id, agent_id, name, description) VALUES ($1, $2, $3, $4) RETURNING *",
          [scope.userId, scope.agentId, input.name.trim(), input.description?.trim() ?? ""],
        );
        return mapProject(result.rows[0]);
      },
      async list(scope: AgentScope): Promise<DbProject[]> {
        const result = await pool.query(
          "SELECT * FROM projects WHERE user_id = $1 AND agent_id = $2 ORDER BY updated_at DESC",
          [scope.userId, scope.agentId],
        );
        return result.rows.map(mapProject);
      },
      async get(scope: AgentScope, projectId: string): Promise<DbProject | null> {
        const result = await pool.query(
          "SELECT * FROM projects WHERE user_id = $1 AND agent_id = $2 AND id = $3",
          [scope.userId, scope.agentId, projectId],
        );
        return result.rows[0] ? mapProject(result.rows[0]) : null;
      },
      async update(scope: AgentScope, projectId: string, input: { name?: string; description?: string }): Promise<DbProject | null> {
        const result = await pool.query(
          `UPDATE projects SET
             name = COALESCE($4, name),
             description = COALESCE($5, description),
             updated_at = now()
           WHERE user_id = $1 AND agent_id = $2 AND id = $3
           RETURNING *`,
          [scope.userId, scope.agentId, projectId, input.name?.trim() || null, input.description?.trim() ?? null],
        );
        return result.rows[0] ? mapProject(result.rows[0]) : null;
      },
      async delete(scope: AgentScope, projectId: string): Promise<void> {
        await pool.query(
          "DELETE FROM projects WHERE user_id = $1 AND agent_id = $2 AND id = $3",
          [scope.userId, scope.agentId, projectId],
        );
      },
    },
    messages: {
      async create(scope: AgentScope, input: {
        conversationId: string;
        role: DbMessage["role"];
        content: string;
        visibleToUser?: boolean;
        memoryProcessed?: boolean;
      }): Promise<DbMessage> {
        const result = await pool.query(
          `INSERT INTO messages (user_id, agent_id, conversation_id, role, content, visible_to_user, memory_processed)
           SELECT $1, $2, conversation.id, $4, $5, $6, $7
           FROM conversations AS conversation
           WHERE conversation.user_id = $1
             AND conversation.agent_id = $2
             AND conversation.id = $3
           RETURNING *`,
          [
            scope.userId,
            scope.agentId,
            input.conversationId,
            input.role,
            input.content,
            input.visibleToUser ?? true,
            input.memoryProcessed ?? false,
          ],
        );
        if (!result.rows[0]) throw new Error("conversation_not_found");
        await pool.query(
          "UPDATE conversations SET updated_at = now() WHERE user_id = $1 AND agent_id = $2 AND id = $3",
          [scope.userId, scope.agentId, input.conversationId],
        );
        return mapMessage(result.rows[0]);
      },
      async createWithAttachments(scope: AgentScope, input: {
        conversationId: string;
        content: string;
        attachmentIds: string[];
      }): Promise<{ message: DbMessage; attachments: DbMessageAttachment[] }> {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");

          if (input.attachmentIds.length > ATTACHMENT_LIMITS.maxCount) {
            throw new Error("attachment_count_exceeded");
          }
          if (new Set(input.attachmentIds).size !== input.attachmentIds.length) {
            throw new Error("attachment_not_bindable");
          }

          const conversation = await client.query(
            "SELECT id FROM conversations WHERE user_id = $1 AND agent_id = $2 AND id = $3",
            [scope.userId, scope.agentId, input.conversationId],
          );
          if (!conversation.rows[0]) {
            throw new Error("conversation_not_found");
          }

          let lockedAttachments: DbMessageAttachment[] = [];
          if (input.attachmentIds.length > 0) {
            const locked = await client.query(
              `SELECT * FROM message_attachments
               WHERE user_id = $1 AND agent_id = $2 AND id = ANY($3::uuid[])
               ORDER BY id
               FOR UPDATE`,
              [scope.userId, scope.agentId, input.attachmentIds],
            );
            lockedAttachments = locked.rows.map(mapMessageAttachment);

            const allBindable =
              lockedAttachments.length === input.attachmentIds.length
              && lockedAttachments.every(
                (attachment) =>
                  attachment.userId === scope.userId
                  && attachment.agentId === scope.agentId
                  && attachment.status === "ready"
                  && attachment.messageId === null,
              );
            if (!allBindable) {
              throw new Error("attachment_not_bindable");
            }

            const totalSize = lockedAttachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0);
            if (totalSize > ATTACHMENT_LIMITS.maxMessageBytes) {
              throw new Error("attachment_total_size_exceeded");
            }
          }

          const createdMessage = await client.query(
            `INSERT INTO messages (user_id, agent_id, conversation_id, role, content)
             VALUES ($1, $2, $3, 'user', $4)
             RETURNING *`,
            [scope.userId, scope.agentId, input.conversationId, input.content],
          );
          const message = mapMessage(createdMessage.rows[0]);

          let attachments: DbMessageAttachment[] = [];
          if (input.attachmentIds.length > 0) {
            const bound = await client.query(
              `UPDATE message_attachments
               SET message_id = $4, status = 'bound', updated_at = now()
               WHERE user_id = $1
                 AND agent_id = $2
                 AND id = ANY($3::uuid[])
                 AND status = 'ready'
                 AND message_id IS NULL
               RETURNING *`,
              [scope.userId, scope.agentId, input.attachmentIds, message.id],
            );
            if (bound.rows.length !== input.attachmentIds.length) {
              throw new Error("attachment_not_bindable");
            }
            const byId = new Map(
              bound.rows.map((row) => {
                const attachment = mapMessageAttachment(row);
                return [attachment.id, attachment] as const;
              }),
            );
            attachments = input.attachmentIds.map((attachmentId) => byId.get(attachmentId)!);
          }

          await client.query(
            "UPDATE conversations SET updated_at = now() WHERE user_id = $1 AND agent_id = $2 AND id = $3",
            [scope.userId, scope.agentId, input.conversationId],
          );
          await client.query("COMMIT");
          return { message, attachments };
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      },
      async createIdempotentUserTurn(scope: AgentScope, input: {
        conversationId: string;
        clientTurnId: string;
        payloadHash: string;
        content: string;
        attachmentIds: string[];
      }): Promise<{ message: DbMessage; attachments: DbMessageAttachment[]; created: boolean }> {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          if (input.attachmentIds.length > ATTACHMENT_LIMITS.maxCount) {
            throw new Error("attachment_count_exceeded");
          }
          if (new Set(input.attachmentIds).size !== input.attachmentIds.length) {
            throw new Error("attachment_not_bindable");
          }

          const conversation = await client.query(
            "SELECT id FROM conversations WHERE user_id = $1 AND agent_id = $2 AND id = $3",
            [scope.userId, scope.agentId, input.conversationId],
          );
          if (!conversation.rows[0]) throw new Error("conversation_not_found");

          const inserted = await client.query(
            `INSERT INTO messages
             (user_id, agent_id, conversation_id, role, content, client_turn_id, client_turn_payload_hash)
             VALUES ($1, $2, $3, 'user', $4, $5, $6)
             ON CONFLICT (user_id, agent_id, client_turn_id, role) WHERE client_turn_id IS NOT NULL
             DO NOTHING
             RETURNING *`,
            [scope.userId, scope.agentId, input.conversationId, input.content, input.clientTurnId, input.payloadHash],
          );
          const created = inserted.rows.length > 0;
          const storedRow = created
            ? inserted.rows[0]
            : (await client.query(
                `SELECT * FROM messages
                 WHERE user_id = $1 AND agent_id = $2 AND client_turn_id = $3 AND role = 'user'
                 FOR UPDATE`,
                [scope.userId, scope.agentId, input.clientTurnId],
              )).rows[0];
          if (
            !storedRow
            || String(storedRow.conversation_id) !== input.conversationId
            || String(storedRow.content) !== input.content
            || String(storedRow.client_turn_payload_hash) !== input.payloadHash
          ) {
            throw new Error("client_turn_conflict");
          }
          const message = mapMessage(storedRow);

          if (!created) {
            const existingAttachments = input.attachmentIds.length === 0
              ? []
              : (await client.query(
                  `SELECT * FROM message_attachments
                   WHERE user_id = $1 AND agent_id = $2 AND message_id = $3`,
                  [scope.userId, scope.agentId, message.id],
                )).rows.map(mapMessageAttachment);
            const byId = new Map(existingAttachments.map((attachment) => [attachment.id, attachment]));
            if (
              existingAttachments.length !== input.attachmentIds.length
              || input.attachmentIds.some((attachmentId) => !byId.has(attachmentId))
            ) {
              throw new Error("client_turn_conflict");
            }
            await client.query("COMMIT");
            return {
              message,
              attachments: input.attachmentIds.map((attachmentId) => byId.get(attachmentId)!),
              created: false,
            };
          }

          let attachments: DbMessageAttachment[] = [];
          if (input.attachmentIds.length > 0) {
            const locked = await client.query(
              `SELECT * FROM message_attachments
               WHERE user_id = $1 AND agent_id = $2 AND id = ANY($3::uuid[])
               ORDER BY id
               FOR UPDATE`,
              [scope.userId, scope.agentId, input.attachmentIds],
            );
            const lockedAttachments = locked.rows.map(mapMessageAttachment);
            const allBindable =
              lockedAttachments.length === input.attachmentIds.length
              && lockedAttachments.every(
                (attachment) => attachment.status === "ready" && attachment.messageId === null,
              );
            if (!allBindable) throw new Error("attachment_not_bindable");
            const totalSize = lockedAttachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0);
            if (totalSize > ATTACHMENT_LIMITS.maxMessageBytes) {
              throw new Error("attachment_total_size_exceeded");
            }

            const bound = await client.query(
              `UPDATE message_attachments
               SET message_id = $4, status = 'bound', updated_at = now()
               WHERE user_id = $1
                 AND agent_id = $2
                 AND id = ANY($3::uuid[])
                 AND status = 'ready'
                 AND message_id IS NULL
               RETURNING *`,
              [scope.userId, scope.agentId, input.attachmentIds, message.id],
            );
            if (bound.rows.length !== input.attachmentIds.length) {
              throw new Error("attachment_not_bindable");
            }
            const byId = new Map(
              bound.rows.map((row) => {
                const attachment = mapMessageAttachment(row);
                return [attachment.id, attachment] as const;
              }),
            );
            attachments = input.attachmentIds.map((attachmentId) => byId.get(attachmentId)!);
          }

          await client.query(
            "UPDATE conversations SET updated_at = now() WHERE user_id = $1 AND agent_id = $2 AND id = $3",
            [scope.userId, scope.agentId, input.conversationId],
          );
          await client.query("COMMIT");
          return { message, attachments, created: true };
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      },
      async createIdempotentAssistantTurn(scope: AgentScope, input: {
        conversationId: string;
        clientTurnId: string;
        content: string;
      }): Promise<{ message: DbMessage; created: boolean }> {
        const inserted = await pool.query(
          `INSERT INTO messages (user_id, agent_id, conversation_id, role, content, client_turn_id)
           SELECT $1, $2, conversation.id, 'assistant', $4, $5
           FROM conversations AS conversation
           WHERE conversation.user_id = $1 AND conversation.agent_id = $2 AND conversation.id = $3
           ON CONFLICT (user_id, agent_id, client_turn_id, role) WHERE client_turn_id IS NOT NULL
           DO NOTHING
           RETURNING *`,
          [scope.userId, scope.agentId, input.conversationId, input.content, input.clientTurnId],
        );
        const created = inserted.rows.length > 0;
        const row = created
          ? inserted.rows[0]
          : (await pool.query(
              `SELECT * FROM messages
               WHERE user_id = $1 AND agent_id = $2 AND client_turn_id = $3 AND role = 'assistant'`,
              [scope.userId, scope.agentId, input.clientTurnId],
            )).rows[0];
        if (!row) throw new Error("client_turn_assistant_missing");
        if (created) {
          await pool.query(
            "UPDATE conversations SET updated_at = now() WHERE user_id = $1 AND agent_id = $2 AND id = $3",
            [scope.userId, scope.agentId, input.conversationId],
          );
        }
        return { message: mapMessage(row), created };
      },
      async acquireClientTurnExecutionLock(
        scope: AgentScope,
        clientTurnId: string,
        signal?: AbortSignal,
      ): Promise<() => Promise<void>> {
        const lockKey = `${scope.userId}:${scope.agentId}:${clientTurnId}`;
        const client = await connectPoolClient(turnLockPool, signal);
        let locked = false;
        let destroyed = false;
        const abortPendingQuery = () => {
          if (destroyed) return;
          destroyed = true;
          client.release(true);
        };
        signal?.addEventListener("abort", abortPendingQuery, { once: true });
        try {
          signal?.throwIfAborted();
          await client.query(
            "SELECT pg_advisory_lock(hashtextextended($1, 0))",
            [lockKey],
          );
          signal?.throwIfAborted();
          locked = true;
        } catch (error) {
          if (locked && !destroyed) {
            await releaseTurnExecutionLock(client, lockKey).catch(() => undefined);
          } else if (!destroyed) {
            client.release(true);
          }
          signal?.throwIfAborted();
          throw error;
        } finally {
          signal?.removeEventListener("abort", abortPendingQuery);
        }

        let released = false;
        return async () => {
          if (released) return;
          released = true;
          await releaseTurnExecutionLock(client, lockKey);
        };
      },
      async claimClientTurnExecution(scope: AgentScope, clientTurnId: string): Promise<boolean> {
        const result = await pool.query(
          `UPDATE messages
           SET client_turn_execution_started_at = now()
           WHERE user_id = $1
             AND agent_id = $2
             AND client_turn_id = $3
             AND role = 'user'
             AND client_turn_execution_started_at IS NULL
           RETURNING id`,
          [scope.userId, scope.agentId, clientTurnId],
        );
        return result.rows.length === 1;
      },
      async findByClientTurn(
        scope: AgentScope,
        clientTurnId: string,
        role: "user" | "assistant",
      ): Promise<DbMessage | null> {
        const result = await pool.query(
          `SELECT * FROM messages
           WHERE user_id = $1 AND agent_id = $2 AND client_turn_id = $3 AND role = $4`,
          [scope.userId, scope.agentId, clientTurnId, role],
        );
        return result.rows[0] ? mapMessage(result.rows[0]) : null;
      },
      async createFromProactiveTask(scope: AgentScope, input: {
        taskId: string;
        conversationId: string;
        content: string;
      }): Promise<boolean> {
        const result = await pool.query(
          `INSERT INTO messages (user_id, agent_id, conversation_id, role, content, source_task_id)
           SELECT $1, $2, conversation.id, 'assistant', $4, proactive_task.id
           FROM conversations AS conversation
           JOIN proactive_tasks AS proactive_task
             ON proactive_task.user_id = $1 AND proactive_task.agent_id = $2 AND proactive_task.id = $3
           WHERE conversation.user_id = $1 AND conversation.agent_id = $2 AND conversation.id = $5
           ON CONFLICT (agent_id, source_task_id) WHERE source_task_id IS NOT NULL DO NOTHING
           RETURNING id`,
          [scope.userId, scope.agentId, input.taskId, input.content, input.conversationId],
        );
        if (result.rows.length === 0) return false;
        await pool.query(
          "UPDATE conversations SET updated_at = now() WHERE user_id = $1 AND agent_id = $2 AND id = $3",
          [scope.userId, scope.agentId, input.conversationId],
        );
        return true;
      },
      async list(scope: AgentScope, conversationId: string): Promise<DbMessage[]> {
        const result = await pool.query(
          `SELECT * FROM messages
           WHERE user_id = $1 AND agent_id = $2 AND conversation_id = $3
             AND visible_to_user = true
           ORDER BY created_at ASC`,
          [scope.userId, scope.agentId, conversationId],
        );
        return result.rows.map(mapMessage);
      },
      async listAllForAudit(scope: AgentScope, conversationId: string): Promise<Array<DbMessage & { visibleToUser: boolean }>> {
        const result = await pool.query(
          "SELECT * FROM messages WHERE user_id = $1 AND agent_id = $2 AND conversation_id = $3 ORDER BY created_at ASC",
          [scope.userId, scope.agentId, conversationId],
        );
        return result.rows.map((row) => ({ ...mapMessage(row), visibleToUser: Boolean(row.visible_to_user) }));
      },
      async recentHistory(scope: AgentScope, conversationId: string, limit = 12, excludeClientTurnId?: string) {
        const result = await pool.query(
          `SELECT id, role, content FROM messages
           WHERE user_id = $1 AND agent_id = $2 AND conversation_id = $3
             AND visible_to_user = true AND role IN ('user', 'assistant')
             ${excludeClientTurnId ? "AND client_turn_id IS DISTINCT FROM $5::uuid" : ""}
           ORDER BY created_at DESC LIMIT $4`,
          excludeClientTurnId
            ? [scope.userId, scope.agentId, conversationId, limit, excludeClientTurnId]
            : [scope.userId, scope.agentId, conversationId, limit],
        );
        return result.rows
          .reverse()
          .map((row: { id: string; role: "user" | "assistant"; content: string }) => ({
            id: row.id,
            role: row.role,
            content: row.content,
          }));
      },
      async listAfter(scope: AgentScope, conversationId: string, after: Date): Promise<DbMessage[]> {
        const result = await pool.query(
          `SELECT * FROM messages
           WHERE user_id = $1 AND agent_id = $2 AND conversation_id = $3
             AND visible_to_user = true AND created_at > $4
           ORDER BY created_at ASC`,
          [scope.userId, scope.agentId, conversationId, after],
        );
        return result.rows.map(mapMessage);
      },
      async unprocessedForMemory(scope: AgentScope, limit = 20): Promise<DbMessage[]> {
        const result = await pool.query(
          `SELECT * FROM messages
           WHERE user_id = $1 AND agent_id = $2
             AND memory_processed = false AND visible_to_user = true AND role = 'user'
           ORDER BY created_at ASC LIMIT $3`,
          [scope.userId, scope.agentId, limit],
        );
        return result.rows.map(mapMessage);
      },
      async markMemoryProcessed(scope: AgentScope, ids: string[]): Promise<void> {
        if (ids.length === 0) return;
        await pool.query(
          "UPDATE messages SET memory_processed = true WHERE user_id = $1 AND agent_id = $2 AND id = ANY($3::uuid[])",
          [scope.userId, scope.agentId, ids],
        );
      },
    },
    messageAttachments: {
      async createDraft(scope: AgentScope, input: {
        kind: AttachmentKind;
        fileName: string;
        mimeType: string;
        sizeBytes: number;
        storageKey: string;
        extractedText?: string | null;
        textTruncated?: boolean;
      }): Promise<DbMessageAttachment> {
        const result = await pool.query(
          `INSERT INTO message_attachments
           (user_id, agent_id, kind, file_name, mime_type, size_bytes, storage_key, extracted_text, text_truncated, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
           RETURNING *`,
          [
            scope.userId,
            scope.agentId,
            input.kind,
            input.fileName,
            input.mimeType,
            input.sizeBytes,
            input.storageKey,
            input.extractedText ?? null,
            input.textTruncated ?? false,
          ],
        );
        return mapMessageAttachment(result.rows[0]);
      },
      async markReady(scope: AgentScope, attachmentId: string): Promise<DbMessageAttachment | null> {
        const result = await pool.query(
          `UPDATE message_attachments
           SET status = 'ready', error_code = NULL, deletion_claim_token = NULL, updated_at = now()
           WHERE user_id = $1 AND agent_id = $2 AND id = $3
             AND message_id IS NULL AND status = 'pending'
           RETURNING *`,
          [scope.userId, scope.agentId, attachmentId],
        );
        return result.rows[0] ? mapMessageAttachment(result.rows[0]) : null;
      },
      async get(scope: AgentScope, attachmentId: string): Promise<DbMessageAttachment | null> {
        const result = await pool.query(
          "SELECT * FROM message_attachments WHERE user_id = $1 AND agent_id = $2 AND id = $3",
          [scope.userId, scope.agentId, attachmentId],
        );
        return result.rows[0] ? mapMessageAttachment(result.rows[0]) : null;
      },
      async listForMessages(scope: AgentScope, messageIds: string[]): Promise<DbMessageAttachment[]> {
        if (messageIds.length === 0) return [];
        const result = await pool.query(
          `SELECT * FROM message_attachments
           WHERE user_id = $1 AND agent_id = $2 AND message_id = ANY($3::uuid[])
           ORDER BY created_at ASC, id ASC`,
          [scope.userId, scope.agentId, messageIds],
        );
        return result.rows.map(mapMessageAttachment);
      },
      async listExistingStorageKeys(storageKeys: string[]): Promise<string[]> {
        if (storageKeys.length === 0) return [];
        const result = await pool.query<{ storage_key: string }>(
          "SELECT storage_key FROM message_attachments WHERE storage_key = ANY($1::text[])",
          [storageKeys],
        );
        return result.rows.map((row) => row.storage_key);
      },
      async claimDraftForDeletion(
        scope: AgentScope,
        attachmentId: string,
      ): Promise<DbMessageAttachment | null> {
        const result = await pool.query(
          `UPDATE message_attachments
           SET status = 'deleting', deletion_claim_token = gen_random_uuid(), updated_at = now()
           WHERE user_id = $1 AND agent_id = $2 AND id = $3
             AND message_id IS NULL AND status IN ('ready', 'failed', 'deleting')
           RETURNING *`,
          [scope.userId, scope.agentId, attachmentId],
        );
        return result.rows[0] ? mapMessageAttachment(result.rows[0]) : null;
      },
      async deleteDraft(
        scope: AgentScope,
        attachmentId: string,
        deletionClaimToken: string,
      ): Promise<boolean> {
        const result = await pool.query(
          `DELETE FROM message_attachments
           WHERE user_id = $1 AND agent_id = $2 AND id = $3
             AND message_id IS NULL AND status = 'deleting'
             AND deletion_claim_token = $4
           RETURNING id`,
          [scope.userId, scope.agentId, attachmentId, deletionClaimToken],
        );
        return result.rows.length > 0;
      },
      async claimExpiredDrafts(scope: AgentScope, hours: number, limit = 100): Promise<DbMessageAttachment[]> {
        const { safeHours, safeLimit } = validateAttachmentClaimLimit(hours, limit);
        const result = await pool.query(
          `WITH candidates AS (
             SELECT id
             FROM message_attachments
             WHERE user_id = $1 AND agent_id = $2 AND message_id IS NULL
               AND (
                 (status = 'ready'
                   AND created_at < now() - ($3 * interval '1 hour'))
                 OR (status = 'pending'
                   AND created_at < now() - ($3 * interval '1 hour'))
                 OR (status = 'failed'
                   AND created_at < now() - ($3 * interval '1 hour')
                   AND updated_at < now() - interval '5 minutes')
                 OR (status = 'deleting'
                   AND updated_at < now() - interval '15 minutes')
               )
             ORDER BY updated_at ASC, id ASC
             LIMIT $4
             FOR UPDATE SKIP LOCKED
           )
           UPDATE message_attachments AS attachment
           SET status = 'deleting', deletion_claim_token = gen_random_uuid(), updated_at = now()
           FROM candidates
           WHERE attachment.user_id = $1 AND attachment.agent_id = $2
             AND attachment.id = candidates.id
           RETURNING attachment.*`,
          [scope.userId, scope.agentId, safeHours, safeLimit],
        );
        return result.rows.map(mapMessageAttachment);
      },
      async markFailed(scope: AgentScope, attachmentId: string, errorCode: string): Promise<void> {
        await pool.query(
          `UPDATE message_attachments
           SET status = 'failed', error_code = $4, deletion_claim_token = NULL, updated_at = now()
           WHERE user_id = $1
             AND agent_id = $2
             AND id = $3
             AND message_id IS NULL
             AND status IN ('pending', 'ready', 'failed')`,
          [scope.userId, scope.agentId, attachmentId, errorCode],
        );
      },
      async releaseDeletionClaim(
        scope: AgentScope,
        attachmentId: string,
        deletionClaimToken: string,
        errorCode: string,
      ): Promise<boolean> {
        const result = await pool.query(
          `UPDATE message_attachments
           SET status = 'failed', error_code = $5, deletion_claim_token = NULL, updated_at = now()
           WHERE user_id = $1 AND agent_id = $2 AND id = $3
             AND message_id IS NULL AND status = 'deleting'
             AND deletion_claim_token = $4
           RETURNING id`,
          [scope.userId, scope.agentId, attachmentId, deletionClaimToken, errorCode],
        );
        return result.rows.length > 0;
      },
    },
    memories: {
      async findRelevant(
        scope: AgentScope,
        query: string,
        signal?: AbortSignal,
      ): Promise<RankableMemory[]> {
        signal?.throwIfAborted();
        const queryEmbedding = formatPgVector(await embedText(query, undefined, signal));
        signal?.throwIfAborted();
        const semanticResult = await pool.query(
          `SELECT id, content, created_at, 1 - (embedding <=> $3::vector) AS similarity
           FROM memory_entries
           WHERE user_id = $1 AND agent_id = $2 AND ${ACTIVE_MEMORY_CONDITION} AND embedding IS NOT NULL
           ORDER BY embedding <=> $3::vector
           LIMIT 12`,
          [scope.userId, scope.agentId, queryEmbedding],
        );
        signal?.throwIfAborted();
        const lexicalResult = await pool.query(
          `SELECT id, content, created_at
           FROM memory_entries
           WHERE user_id = $1 AND agent_id = $2 AND ${ACTIVE_MEMORY_CONDITION}
           ORDER BY created_at DESC LIMIT 80`,
          [scope.userId, scope.agentId],
        );
        signal?.throwIfAborted();
        return mergeMemoryCandidates(
          query,
          lexicalResult.rows.map((row) => ({ id: row.id, content: row.content, createdAt: row.created_at })),
          semanticResult.rows.map((row) => ({
            id: row.id,
            content: row.content,
            createdAt: row.created_at,
            similarity: Number(row.similarity ?? 0),
          })),
        );
      },
      async createMany(
        scope: AgentScope,
        sourceMessageId: string | null,
        memories: ExtractedMemory[],
        signal?: AbortSignal,
      ): Promise<void> {
        for (const entry of memories) {
          signal?.throwIfAborted();
          const safeContent = redactSensitiveMemory(entry.content);
          if (!safeContent) continue;
          const memory = { ...entry, content: safeContent };
          const embedding = formatPgVector(await embedText(memory.content, undefined, signal));
          signal?.throwIfAborted();
          const expiresAt = memoryExpiresAt(memory);
          await pool.query(
            `INSERT INTO memory_entries (
               user_id, agent_id, kind, content, confidence, source_message_id, embedding, expires_at
             )
             SELECT $1, $2, $3, $4, $5, $6, $7::vector, $8
             WHERE (
               $6::uuid IS NULL
               OR EXISTS (
                 SELECT 1 FROM messages
                 WHERE messages.user_id = $1 AND messages.agent_id = $2 AND messages.id = $6
               )
             )
             AND NOT EXISTS (
               SELECT 1 FROM memory_entries
               WHERE user_id = $1 AND agent_id = $2 AND content = $4 AND ${ACTIVE_MEMORY_CONDITION}
             )`,
            [scope.userId, scope.agentId, memory.kind, memory.content, memory.confidence, sourceMessageId, embedding, expiresAt],
          );
          signal?.throwIfAborted();
        }
      },
      async listActiveByKind(scope: AgentScope, kind: MemoryKind): Promise<DbMemoryEntry[]> {
        const result = await pool.query(
          `SELECT id, kind, content, confidence, created_at
           FROM memory_entries
           WHERE user_id = $1 AND agent_id = $2 AND kind = $3 AND ${ACTIVE_MEMORY_CONDITION}
           ORDER BY created_at ASC`,
          [scope.userId, scope.agentId, kind],
        );
        return result.rows.map((row) => ({
          id: row.id,
          agentId: scope.agentId,
          kind: row.kind,
          content: row.content,
          confidence: Number(row.confidence),
          createdAt: row.created_at,
        }));
      },
      async softDeleteMany(scope: AgentScope, memoryIds: string[]): Promise<void> {
        if (memoryIds.length === 0) return;
        await pool.query(
          "UPDATE memory_entries SET deleted_at = now() WHERE user_id = $1 AND agent_id = $2 AND id = ANY($3::uuid[])",
          [scope.userId, scope.agentId, memoryIds],
        );
      },
      async list(scope: AgentScope): Promise<DbMemoryEntry[]> {
        const result = await pool.query(
          `SELECT id, kind, content, confidence, created_at
           FROM memory_entries
           WHERE user_id = $1 AND agent_id = $2 AND ${ACTIVE_MEMORY_CONDITION}
           ORDER BY created_at DESC`,
          [scope.userId, scope.agentId],
        );
        return result.rows.map((row) => ({
          id: row.id,
          agentId: scope.agentId,
          kind: row.kind,
          content: row.content,
          confidence: Number(row.confidence),
          createdAt: row.created_at,
        }));
      },
      async update(
        scope: AgentScope,
        memoryId: string,
        input: { kind: MemoryKind; content: string; confidence: number },
        signal?: AbortSignal,
      ): Promise<void> {
        signal?.throwIfAborted();
        const content = redactSensitiveMemory(input.content);
        if (!content) return;
        const embedding = formatPgVector(await embedText(content, undefined, signal));
        signal?.throwIfAborted();
        await pool.query(
          `UPDATE memory_entries
           SET kind = $4, content = $5, confidence = $6, embedding = $7::vector
           WHERE user_id = $1 AND agent_id = $2 AND id = $3 AND deleted_at IS NULL`,
          [scope.userId, scope.agentId, memoryId, input.kind, content, input.confidence, embedding],
        );
        signal?.throwIfAborted();
      },
      async delete(scope: AgentScope, memoryId: string): Promise<void> {
        await pool.query(
          "UPDATE memory_entries SET deleted_at = now() WHERE user_id = $1 AND agent_id = $2 AND id = $3",
          [scope.userId, scope.agentId, memoryId],
        );
      },
    },
    conversationSummaries: {
      async latest(scope: AgentScope, conversationId: string): Promise<string | null> {
        const result = await pool.query(
          `SELECT summary FROM conversation_summaries
           WHERE user_id = $1 AND agent_id = $2 AND conversation_id = $3
           ORDER BY created_at DESC LIMIT 1`,
          [scope.userId, scope.agentId, conversationId],
        );
        return result.rows[0]?.summary ?? null;
      },
      async create(scope: AgentScope, input: {
        conversationId: string;
        summary: string;
        messageCount: number;
      }): Promise<void> {
        await pool.query(
          `INSERT INTO conversation_summaries (user_id, agent_id, conversation_id, summary, message_count)
           SELECT $1, $2, conversation.id, $4, $5
           FROM conversations AS conversation
           WHERE conversation.user_id = $1 AND conversation.agent_id = $2 AND conversation.id = $3`,
          [scope.userId, scope.agentId, input.conversationId, input.summary, input.messageCount],
        );
      },
    },
    toolLogs: {
      async create(input: ToolLogInput): Promise<void> {
        await pool.query(
          `INSERT INTO tool_call_logs
           (user_id, agent_id, conversation_id, goal_id, tool_name, input_summary, output_summary, status, duration_ms, error)
           SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
           WHERE (
             $3::uuid IS NULL OR EXISTS (
               SELECT 1 FROM conversations
               WHERE conversations.user_id = $1 AND conversations.agent_id = $2 AND conversations.id = $3
             )
           )
           AND (
             $4::uuid IS NULL OR EXISTS (
               SELECT 1 FROM goals
               WHERE goals.user_id = $1 AND goals.agent_id = $2 AND goals.id = $4
             )
           )`,
          [
            input.userId,
            input.agentId,
            input.conversationId,
            input.goalId ?? null,
            input.toolName,
            input.inputSummary,
            input.outputSummary,
            input.status,
            input.durationMs,
            input.error ?? null,
          ],
        );
      },
      async list(scope: AgentScope) {
        const result = await pool.query(
          "SELECT * FROM tool_call_logs WHERE user_id = $1 AND agent_id = $2 ORDER BY created_at DESC LIMIT 100",
          [scope.userId, scope.agentId],
        );
        return result.rows;
      },
      async listByConversation(scope: AgentScope, conversationId: string) {
        const result = await pool.query(
          `SELECT * FROM tool_call_logs
           WHERE user_id = $1 AND agent_id = $2 AND conversation_id = $3
           ORDER BY created_at ASC LIMIT 200`,
          [scope.userId, scope.agentId, conversationId],
        );
        return result.rows;
      },
    },
    llmUsage: {
      async create(input: LlmUsageLogInput): Promise<void> {
        await pool.query(
          `INSERT INTO llm_usage_logs
           (user_id, agent_id, conversation_id, purpose, model, input_tokens, output_tokens, total_tokens)
           SELECT $1, $2, $3, $4, $5, $6, $7, $8
           WHERE (
             $3::uuid IS NULL OR EXISTS (
               SELECT 1 FROM conversations
               WHERE conversations.user_id = $1 AND conversations.agent_id = $2 AND conversations.id = $3
             )
           )`,
          [
            input.userId,
            input.agentId,
            input.conversationId ?? null,
            input.purpose,
            input.model,
            input.inputTokens,
            input.outputTokens,
            input.totalTokens,
          ],
        );
      },
      async list(scope: AgentScope) {
        const result = await pool.query(
          `SELECT id, purpose, model, input_tokens, output_tokens, total_tokens, created_at
           FROM llm_usage_logs
           WHERE user_id = $1 AND agent_id = $2
           ORDER BY created_at DESC
           LIMIT 500`,
          [scope.userId, scope.agentId],
        );
        return result.rows;
      },
    },
    proactiveTasks: {
      async create(scope: AgentScope, input: {
        conversationId: string;
        kind: "reminder" | "follow_up" | "share";
        content: string;
        scheduledAt: Date;
        metadata?: Record<string, unknown>;
      }): Promise<void> {
        await pool.query(
          `INSERT INTO proactive_tasks (user_id, agent_id, conversation_id, kind, content, scheduled_at, metadata)
           SELECT $1, $2, conversation.id, $4, $5, $6, $7
           FROM conversations AS conversation
           WHERE conversation.user_id = $1 AND conversation.agent_id = $2 AND conversation.id = $3`,
          [scope.userId, scope.agentId, input.conversationId, input.kind, input.content, input.scheduledAt, JSON.stringify(input.metadata ?? {})],
        );
      },
      async due(scope: AgentScope, now = new Date()): Promise<DbProactiveTask[]> {
        const result = await pool.query(
          `SELECT * FROM proactive_tasks
           WHERE user_id = $1 AND agent_id = $2 AND status = 'pending' AND scheduled_at <= $3
           ORDER BY scheduled_at ASC LIMIT 20`,
          [scope.userId, scope.agentId, now],
        );
        return result.rows.map(mapProactiveTask);
      },
      async markSent(scope: AgentScope, taskId: string): Promise<void> {
        await pool.query(
          "UPDATE proactive_tasks SET status = 'sent', sent_at = now(), updated_at = now() WHERE user_id = $1 AND agent_id = $2 AND id = $3",
          [scope.userId, scope.agentId, taskId],
        );
      },
      async markCancelled(scope: AgentScope, taskId: string): Promise<void> {
        await pool.query(
          "UPDATE proactive_tasks SET status = 'cancelled', updated_at = now() WHERE user_id = $1 AND agent_id = $2 AND id = $3",
          [scope.userId, scope.agentId, taskId],
        );
      },
      async markFailed(scope: AgentScope, taskId: string): Promise<void> {
        await pool.query(
          "UPDATE proactive_tasks SET status = 'failed', updated_at = now() WHERE user_id = $1 AND agent_id = $2 AND id = $3",
          [scope.userId, scope.agentId, taskId],
        );
      },
      async countSentToday(scope: AgentScope, now = new Date()): Promise<number> {
        const result = await pool.query(
          `SELECT count(*)::int AS count FROM proactive_tasks
           WHERE user_id = $1 AND agent_id = $2 AND status = 'sent' AND sent_at::date = $3::date`,
          [scope.userId, scope.agentId, now],
        );
        return Number(result.rows[0]?.count ?? 0);
      },
      async list(scope: AgentScope): Promise<DbProactiveTask[]> {
        const result = await pool.query(
          "SELECT * FROM proactive_tasks WHERE user_id = $1 AND agent_id = $2 ORDER BY scheduled_at DESC LIMIT 100",
          [scope.userId, scope.agentId],
        );
        return result.rows.map(mapProactiveTask);
      },
      async latestByKind(scope: AgentScope, kind: DbProactiveTask["kind"]): Promise<Date | null> {
        const result = await pool.query(
          "SELECT created_at FROM proactive_tasks WHERE user_id = $1 AND agent_id = $2 AND kind = $3 ORDER BY created_at DESC LIMIT 1",
          [scope.userId, scope.agentId, kind],
        );
        return result.rows[0]?.created_at ?? null;
      },
      async unansweredStreak(scope: AgentScope): Promise<number> {
        const result = await pool.query(
          `WITH recent AS (
             SELECT id, conversation_id, sent_at
             FROM proactive_tasks
             WHERE user_id = $1 AND agent_id = $2 AND status = 'sent' AND sent_at IS NOT NULL
             ORDER BY sent_at DESC
             LIMIT 3
           )
           SELECT count(*)::int AS count
           FROM recent
           WHERE NOT EXISTS (
             SELECT 1 FROM messages
             WHERE messages.user_id = $1 AND messages.agent_id = $2
               AND messages.conversation_id = recent.conversation_id
               AND messages.role = 'user'
               AND messages.created_at > recent.sent_at
           )`,
          [scope.userId, scope.agentId],
        );
        return Number(result.rows[0]?.count ?? 0);
      },
    },
    goals: {
      async create(scope: AgentScope, input: {
        title: string;
        contract: GoalContract;
        conversationId?: string | null;
      }): Promise<DbGoal> {
        const result = await pool.query(
          `INSERT INTO goals (user_id, agent_id, title, contract, conversation_id)
           SELECT $1, $2, $3, $4, $5
           WHERE (
             $5::uuid IS NULL OR EXISTS (
               SELECT 1 FROM conversations
               WHERE conversations.user_id = $1 AND conversations.agent_id = $2 AND conversations.id = $5
             )
           )
           RETURNING *`,
          [scope.userId, scope.agentId, input.title.trim(), JSON.stringify(input.contract), input.conversationId ?? null],
        );
        if (!result.rows[0]) throw new Error("conversation_not_found");
        return mapGoal(result.rows[0]);
      },
      async get(scope: AgentScope, goalId: string): Promise<DbGoal | null> {
        const result = await pool.query(
          "SELECT * FROM goals WHERE user_id = $1 AND agent_id = $2 AND id = $3",
          [scope.userId, scope.agentId, goalId],
        );
        return result.rows[0] ? mapGoal(result.rows[0]) : null;
      },
      async list(scope: AgentScope): Promise<DbGoal[]> {
        const result = await pool.query(
          "SELECT * FROM goals WHERE user_id = $1 AND agent_id = $2 ORDER BY updated_at DESC LIMIT 100",
          [scope.userId, scope.agentId],
        );
        return result.rows.map(mapGoal);
      },
      async listDue(scope: AgentScope, now = new Date()): Promise<DbGoal[]> {
        const result = await pool.query(
          `SELECT * FROM goals
           WHERE user_id = $1 AND agent_id = $2
             AND (
               status = 'confirmed'
               OR (status = 'running' AND next_run_at IS NOT NULL AND next_run_at <= $3)
             )
           ORDER BY next_run_at ASC NULLS FIRST
           LIMIT 10`,
          [scope.userId, scope.agentId, now],
        );
        return result.rows.map(mapGoal);
      },
      async setStatus(
        scope: AgentScope,
        goalId: string,
        status: GoalStatus,
        options?: { needsHumanPrompt?: string | null; nextRunAt?: Date | null; finished?: boolean },
      ): Promise<void> {
        await pool.query(
          `UPDATE goals SET
             status = $4,
             needs_human_prompt = CASE WHEN $5 THEN $6 ELSE needs_human_prompt END,
             next_run_at = CASE WHEN $7 THEN $8 ELSE next_run_at END,
             finished_at = CASE WHEN $9 THEN now() ELSE finished_at END,
             updated_at = now()
           WHERE user_id = $1 AND agent_id = $2 AND id = $3`,
          [
            scope.userId,
            scope.agentId,
            goalId,
            status,
            options?.needsHumanPrompt !== undefined,
            options?.needsHumanPrompt ?? null,
            options?.nextRunAt !== undefined,
            options?.nextRunAt ?? null,
            options?.finished ?? false,
          ],
        );
      },
      // Marks a goal as executing one round. Returns false when another worker
      // already holds a fresh claim; claims older than 30 minutes are treated
      // as interrupted rounds and may be taken over (restart recovery).
      async claimRunningStep(scope: AgentScope, goalId: string, stepId: string): Promise<boolean> {
        const result = await pool.query(
          `UPDATE goals SET running_step = $4, updated_at = now()
           WHERE user_id = $1 AND agent_id = $2 AND id = $3
             AND (running_step IS NULL OR updated_at < now() - interval '30 minutes')
           RETURNING id`,
          [scope.userId, scope.agentId, goalId, stepId],
        );
        return result.rows.length > 0;
      },
      async releaseRunningStep(scope: AgentScope, goalId: string, nextRunAt: Date | null): Promise<void> {
        await pool.query(
          `UPDATE goals SET running_step = NULL, next_run_at = $4, updated_at = now()
           WHERE user_id = $1 AND agent_id = $2 AND id = $3`,
          [scope.userId, scope.agentId, goalId, nextRunAt],
        );
      },
      async updateProgress(
        scope: AgentScope,
        goalId: string,
        input: { progressSummary?: string; reportDraft?: string; budgetUsed?: GoalBudgetUsed; noProgressRounds?: number },
      ): Promise<void> {
        await pool.query(
          `UPDATE goals SET
             progress_summary = COALESCE($4, progress_summary),
             report_draft = COALESCE($5, report_draft),
             budget_used = COALESCE($6, budget_used),
             no_progress_rounds = COALESCE($7, no_progress_rounds),
             updated_at = now()
           WHERE user_id = $1 AND agent_id = $2 AND id = $3`,
          [
            scope.userId,
            scope.agentId,
            goalId,
            input.progressSummary ?? null,
            input.reportDraft ?? null,
            input.budgetUsed ? JSON.stringify(input.budgetUsed) : null,
            input.noProgressRounds ?? null,
          ],
        );
      },
    },
    goalSteps: {
      async create(scope: AgentScope, input: {
        goalId: string;
        round: number;
        phase: GoalStepPhase;
        intent?: string;
        evidence?: unknown[];
        candidate?: string;
        verifyResult?: unknown;
        failedPaths?: unknown[];
        tokensUsed?: number;
        durationMs?: number | null;
        error?: string | null;
      }): Promise<string> {
        const result = await pool.query(
          `INSERT INTO goal_steps
           (agent_id, goal_id, round, phase, intent, evidence, candidate, verify_result, failed_paths, tokens_used, duration_ms, error)
           SELECT $2, goal.id, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
           FROM goals AS goal
           WHERE goal.user_id = $1 AND goal.agent_id = $2 AND goal.id = $3
           RETURNING id`,
          [
            scope.userId,
            scope.agentId,
            input.goalId,
            input.round,
            input.phase,
            input.intent ?? "",
            JSON.stringify(input.evidence ?? []),
            input.candidate ?? "",
            input.verifyResult !== undefined ? JSON.stringify(input.verifyResult) : null,
            JSON.stringify(input.failedPaths ?? []),
            input.tokensUsed ?? 0,
            input.durationMs ?? null,
            input.error ?? null,
          ],
        );
        if (!result.rows[0]) throw new Error("goal_not_found");
        return result.rows[0].id;
      },
      async listByGoal(scope: AgentScope, goalId: string): Promise<DbGoalStep[]> {
        const result = await pool.query(
          `SELECT step.* FROM goal_steps AS step
           JOIN goals AS goal ON goal.id = step.goal_id AND goal.agent_id = step.agent_id
           WHERE goal.user_id = $1 AND step.agent_id = $2 AND step.goal_id = $3
           ORDER BY step.round ASC, step.created_at ASC`,
          [scope.userId, scope.agentId, goalId],
        );
        return result.rows.map(mapGoalStep);
      },
      async latestRound(scope: AgentScope, goalId: string): Promise<number> {
        const result = await pool.query(
          `SELECT max(step.round)::int AS round FROM goal_steps AS step
           JOIN goals AS goal ON goal.id = step.goal_id AND goal.agent_id = step.agent_id
           WHERE goal.user_id = $1 AND step.agent_id = $2 AND step.goal_id = $3`,
          [scope.userId, scope.agentId, goalId],
        );
        return Number(result.rows[0]?.round ?? 0);
      },
    },
    channels: {
      async ensureConversation(scope: AgentScope, message: NormalizedChannelMessage): Promise<DbConversation> {
        const existing = await pool.query(
          `SELECT * FROM conversations
           WHERE user_id = $1 AND agent_id = $2 AND channel = $3 AND title = $4
           ORDER BY updated_at DESC LIMIT 1`,
          [scope.userId, scope.agentId, message.channel, channelConversationTitle(message)],
        );
        if (existing.rows[0]) return mapConversation(existing.rows[0]);

        const created = await pool.query(
          "INSERT INTO conversations (user_id, agent_id, channel, title) VALUES ($1, $2, $3, $4) RETURNING *",
          [scope.userId, scope.agentId, message.channel, channelConversationTitle(message)],
        );
        return mapConversation(created.rows[0]);
      },
      async createChannelMessage(scope: AgentScope, input: {
        conversationId: string;
        message: NormalizedChannelMessage;
      }): Promise<void> {
        await pool.query(
          `INSERT INTO channel_messages
           (user_id, agent_id, conversation_id, channel, external_conversation_id, external_message_id, sender_id, chat_type, text, raw_payload, occurred_at)
           SELECT $1, $2, conversation.id, $4, $5, $6, $7, $8, $9, $10, $11
           FROM conversations AS conversation
           WHERE conversation.user_id = $1 AND conversation.agent_id = $2 AND conversation.id = $3
           ON CONFLICT (agent_id, channel, external_message_id) DO NOTHING`,
          [
            scope.userId,
            scope.agentId,
            input.conversationId,
            input.message.channel,
            input.message.externalConversationId,
            input.message.externalMessageId,
            input.message.senderId,
            input.message.chatType,
            input.message.text,
            JSON.stringify(input.message.raw ?? {}),
            input.message.occurredAt,
          ],
        );
      },
      async recentBotMessageAt(scope: AgentScope, channel: string, externalConversationId: string): Promise<Date | null> {
        const result = await pool.query(
          `SELECT created_at FROM interjection_decisions
           WHERE user_id = $1 AND agent_id = $2
             AND channel = $3 AND external_conversation_id = $4 AND should_interject = true
           ORDER BY created_at DESC LIMIT 1`,
          [scope.userId, scope.agentId, channel, externalConversationId],
        );
        return result.rows[0]?.created_at ?? null;
      },
      async sentCounts(scope: AgentScope, channel: string, externalConversationId: string, now = new Date()) {
        const result = await pool.query(
          `SELECT
             count(*) FILTER (WHERE created_at >= $5::timestamptz - interval '1 hour')::int AS last_hour,
             count(*) FILTER (WHERE created_at::date = $5::date)::int AS today
           FROM interjection_decisions
           WHERE user_id = $1 AND agent_id = $2
             AND channel = $3 AND external_conversation_id = $4 AND should_interject = true`,
          [scope.userId, scope.agentId, channel, externalConversationId, now],
        );
        return {
          sentInLastHour: Number(result.rows[0]?.last_hour ?? 0),
          sentToday: Number(result.rows[0]?.today ?? 0),
        };
      },
      async recentMessageCount(scope: AgentScope, channel: string, externalConversationId: string, since: Date): Promise<number> {
        const result = await pool.query(
          `SELECT count(*)::int AS count
           FROM channel_messages
           WHERE user_id = $1 AND agent_id = $2
             AND channel = $3
             AND external_conversation_id = $4
             AND occurred_at >= $5`,
          [scope.userId, scope.agentId, channel, externalConversationId, since],
        );
        return Number(result.rows[0]?.count ?? 0);
      },
      async createDecision(scope: AgentScope, input: {
        conversationId: string;
        message: NormalizedChannelMessage;
        shouldInterject: boolean;
        reason: string;
      }): Promise<void> {
        await pool.query(
          `INSERT INTO interjection_decisions
           (user_id, agent_id, conversation_id, channel, external_conversation_id, should_interject, reason)
           SELECT $1, $2, conversation.id, $4, $5, $6, $7
           FROM conversations AS conversation
           WHERE conversation.user_id = $1 AND conversation.agent_id = $2 AND conversation.id = $3`,
          [
            scope.userId,
            scope.agentId,
            input.conversationId,
            input.message.channel,
            input.message.externalConversationId,
            input.shouldInterject,
            input.reason,
          ],
        );
      },
      async listDecisions(scope: AgentScope) {
        const result = await pool.query(
          `SELECT id, channel, external_conversation_id, should_interject, reason, created_at
           FROM interjection_decisions
           WHERE user_id = $1 AND agent_id = $2
           ORDER BY created_at DESC
           LIMIT 200`,
          [scope.userId, scope.agentId],
        );
        return result.rows;
      },
      async latestDirectTarget(scope: AgentScope): Promise<NormalizedChannelMessage | null> {
        const result = await pool.query(
          `SELECT channel, external_conversation_id, external_message_id, sender_id, chat_type, text, raw_payload, occurred_at
           FROM channel_messages
           WHERE user_id = $1 AND agent_id = $2 AND chat_type = 'direct'
           ORDER BY occurred_at DESC
           LIMIT 1`,
          [scope.userId, scope.agentId],
        );
        const row = result.rows[0];
        if (!row) return null;
        return {
          channel: row.channel as NormalizedChannelMessage["channel"],
          externalConversationId: row.external_conversation_id,
          externalMessageId: row.external_message_id,
          senderId: row.sender_id,
          chatType: row.chat_type,
          text: row.text,
          occurredAt: row.occurred_at,
          raw: row.raw_payload,
        };
      },
    },
    reflections: {
      async create(scope: AgentScope, input: { reflection: ReflectionRecord; sourceWindow?: unknown }): Promise<void> {
        await pool.query(
          `INSERT INTO reflections (user_id, agent_id, positives, negatives, suggestions, source_window)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            scope.userId,
            scope.agentId,
            input.reflection.positives,
            input.reflection.negatives,
            input.reflection.suggestions,
            JSON.stringify(input.sourceWindow ?? {}),
          ],
        );
      },
      async list(scope: AgentScope) {
        const result = await pool.query(
          "SELECT * FROM reflections WHERE user_id = $1 AND agent_id = $2 ORDER BY created_at DESC LIMIT 100",
          [scope.userId, scope.agentId],
        );
        return result.rows;
      },
      async findAppliedSuggestions(scope: AgentScope): Promise<string[]> {
        const result = await pool.query<{ suggestions: string[] }>(
          "SELECT suggestions FROM reflections WHERE user_id = $1 AND agent_id = $2 AND status = 'applied' ORDER BY created_at DESC LIMIT 5",
          [scope.userId, scope.agentId],
        );
        return result.rows.flatMap((row) => row.suggestions).filter(Boolean).slice(0, 12);
      },
      async latestCreatedAt(scope: AgentScope): Promise<Date | null> {
        const result = await pool.query(
          "SELECT created_at FROM reflections WHERE user_id = $1 AND agent_id = $2 ORDER BY created_at DESC LIMIT 1",
          [scope.userId, scope.agentId],
        );
        return result.rows[0]?.created_at ?? null;
      },
      async latestBySourceEvent(scope: AgentScope, event: string): Promise<Date | null> {
        const result = await pool.query(
          `SELECT created_at
           FROM reflections
           WHERE user_id = $1 AND agent_id = $2 AND source_window->>'event' = $3
           ORDER BY created_at DESC
           LIMIT 1`,
          [scope.userId, scope.agentId, event],
        );
        return result.rows[0]?.created_at ?? null;
      },
      async setStatus(scope: AgentScope, reflectionId: string, status: "applied" | "dismissed"): Promise<void> {
        await pool.query(
          "UPDATE reflections SET status = $4 WHERE user_id = $1 AND agent_id = $2 AND id = $3",
          [scope.userId, scope.agentId, reflectionId, status],
        );
      },
    },
    skills: {
      async create(userId: string, draft: SkillDraft): Promise<string> {
        const result = await pool.query(
          `INSERT INTO skills (user_id, name, trigger, content, status, source, source_url, scan_report)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [
            userId,
            draft.name,
            draft.trigger,
            draft.content,
            draft.status,
            draft.source ?? "manual",
            draft.sourceUrl ?? null,
            draft.scanReport ? JSON.stringify(draft.scanReport) : null,
          ],
        );
        return result.rows[0].id;
      },
      async list(userId: string): Promise<DbSkill[]> {
        const result = await pool.query("SELECT * FROM skills WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100", [userId]);
        return result.rows.map(mapSkillRow);
      },
      async listEnabled(userId: string): Promise<DbSkill[]> {
        const result = await pool.query(
          "SELECT * FROM skills WHERE user_id = $1 AND status = 'enabled' ORDER BY updated_at DESC LIMIT 100",
          [userId],
        );
        return result.rows.map(mapSkillRow);
      },
      async listEnabledForAgent(scope: AgentScope): Promise<DbSkill[]> {
        const result = await pool.query(
          `SELECT skill.*
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
             AND skill.status = 'enabled'
             AND COALESCE(resource_grant.enabled, agent.inherits_user_resources)
           ORDER BY skill.updated_at DESC
           LIMIT 100`,
          [scope.userId, scope.agentId],
        );
        return result.rows.map(mapSkillRow);
      },
      async findEnabled(scope: AgentScope, query: string): Promise<SkillContext[]> {
        const result = await pool.query<{ id: string; name: string; trigger: string; content: string }>(
          `SELECT skill.id, skill.name, skill.trigger, skill.content
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
             AND skill.status = 'enabled'
             AND COALESCE(resource_grant.enabled, agent.inherits_user_resources)
           ORDER BY skill.updated_at DESC
           LIMIT 50`,
          [scope.userId, scope.agentId],
        );
        // Auto-matching is deliberately strict (PRD 6.3: prefer no skill over a
        // wrong skill) — only inject when the name or trigger clearly matches.
        return result.rows
          .map((row) => ({ ...row, score: scoreSkill(query, row) }))
          .filter((row) => row.score >= AUTO_MATCH_MIN_SCORE)
          .sort((left, right) => right.score - left.score)
          .slice(0, 3)
          .map(({ id, name, trigger, content }) => ({ id, name, trigger, content }));
      },
      async findByIds(scope: AgentScope, skillIds: string[]): Promise<SkillContext[]> {
        if (skillIds.length === 0) return [];
        const result = await pool.query<{ id: string; name: string; trigger: string; content: string }>(
          `SELECT skill.id, skill.name, skill.trigger, skill.content
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
             AND skill.id = ANY($3::uuid[])
             AND skill.status = 'enabled'
             AND COALESCE(resource_grant.enabled, agent.inherits_user_resources)`,
          [scope.userId, scope.agentId, skillIds],
        );
        return result.rows;
      },
      async findEnabledByName(scope: AgentScope, name: string): Promise<{ id: string; name: string } | null> {
        const result = await pool.query<{ id: string; name: string }>(
          `SELECT skill.id, skill.name
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
             AND lower(skill.name) = lower($3)
             AND skill.status = 'enabled'
             AND COALESCE(resource_grant.enabled, agent.inherits_user_resources)
           LIMIT 1`,
          [scope.userId, scope.agentId, name],
        );
        return result.rows[0] ?? null;
      },
      async setStatus(userId: string, skillId: string, status: "enabled" | "disabled" | "rejected"): Promise<void> {
        await pool.query("UPDATE skills SET status = $3, updated_at = now() WHERE user_id = $1 AND id = $2", [
          userId,
          skillId,
          status,
        ]);
      },
      async recordUsage(
        scope: AgentScope,
        skillIds: string[],
        conversationId: string | null,
        triggeredBy: "auto" | "explicit" = "auto",
      ): Promise<void> {
        if (skillIds.length === 0) return;
        await pool.query(
          "UPDATE skills SET usage_count = usage_count + 1, last_used_at = now() WHERE user_id = $1 AND id = ANY($2::uuid[])",
          [scope.userId, skillIds],
        );
        for (const skillId of skillIds) {
          await pool.query(
            `INSERT INTO skill_usage_logs (user_id, agent_id, skill_id, conversation_id, triggered_by)
             SELECT $1, $2, skill.id, $4, $5
             FROM skills AS skill
             WHERE skill.user_id = $1 AND skill.id = $3
               AND (
                 $4::uuid IS NULL OR EXISTS (
                   SELECT 1 FROM conversations
                   WHERE conversations.user_id = $1 AND conversations.agent_id = $2 AND conversations.id = $4
                 )
               )`,
            [scope.userId, scope.agentId, skillId, conversationId, triggeredBy],
          );
        }
      },
      async applyRevision(userId: string, skillId: string, content: string): Promise<void> {
        await pool.query(
          "UPDATE skills SET content = $3, version = version + 1, updated_at = now() WHERE user_id = $1 AND id = $2",
          [userId, skillId, content],
        );
      },
    },
    skillRevisions: {
      async create(input: { userId: string; skillId: string; proposedContent: string; reason: string }): Promise<void> {
        await pool.query(
          `INSERT INTO skill_revisions (user_id, skill_id, proposed_content, reason)
           VALUES ($1, $2, $3, $4)`,
          [input.userId, input.skillId, input.proposedContent, input.reason],
        );
      },
      async listPending(userId: string): Promise<DbSkillRevision[]> {
        const result = await pool.query(
          `SELECT r.*, s.name AS skill_name, s.content AS current_content
           FROM skill_revisions r JOIN skills s ON s.id = r.skill_id
           WHERE r.user_id = $1 AND r.status = 'pending'
           ORDER BY r.created_at DESC LIMIT 50`,
          [userId],
        );
        return result.rows.map(mapSkillRevisionRow);
      },
      async hasPendingForSkill(skillId: string): Promise<boolean> {
        const result = await pool.query("SELECT 1 FROM skill_revisions WHERE skill_id = $1 AND status = 'pending' LIMIT 1", [
          skillId,
        ]);
        return result.rows.length > 0;
      },
      async latestForSkill(skillId: string): Promise<{ createdAt: Date } | null> {
        const result = await pool.query<{ created_at: Date }>(
          "SELECT created_at FROM skill_revisions WHERE skill_id = $1 ORDER BY created_at DESC LIMIT 1",
          [skillId],
        );
        return result.rows[0] ? { createdAt: result.rows[0].created_at } : null;
      },
      async get(userId: string, revisionId: string): Promise<DbSkillRevision | null> {
        const result = await pool.query(
          `SELECT r.*, s.name AS skill_name, s.content AS current_content
           FROM skill_revisions r JOIN skills s ON s.id = r.skill_id
           WHERE r.user_id = $1 AND r.id = $2`,
          [userId, revisionId],
        );
        return result.rows[0] ? mapSkillRevisionRow(result.rows[0]) : null;
      },
      async setStatus(userId: string, revisionId: string, status: "applied" | "rejected"): Promise<void> {
        await pool.query("UPDATE skill_revisions SET status = $3, updated_at = now() WHERE user_id = $1 AND id = $2", [
          userId,
          revisionId,
          status,
        ]);
      },
    },
    skillUsageLogs: {
      async countSince(scope: AgentScope, skillId: string, since: Date | null): Promise<number> {
        const result = since
          ? await pool.query<{ count: string }>(
              `SELECT count(*) AS count FROM skill_usage_logs
               WHERE user_id = $1 AND agent_id = $2 AND skill_id = $3 AND created_at > $4`,
              [scope.userId, scope.agentId, skillId, since],
            )
          : await pool.query<{ count: string }>(
              "SELECT count(*) AS count FROM skill_usage_logs WHERE user_id = $1 AND agent_id = $2 AND skill_id = $3",
              [scope.userId, scope.agentId, skillId],
            );
        return Number(result.rows[0]?.count ?? 0);
      },
      async recentConversationIds(scope: AgentScope, skillId: string, limit: number): Promise<string[]> {
        const result = await pool.query<{ conversation_id: string }>(
          `SELECT DISTINCT ON (conversation_id) conversation_id
           FROM skill_usage_logs
           WHERE user_id = $1 AND agent_id = $2 AND skill_id = $3 AND conversation_id IS NOT NULL
           ORDER BY conversation_id, created_at DESC
           LIMIT $4`,
          [scope.userId, scope.agentId, skillId, limit],
        );
        return result.rows.map((row) => row.conversation_id);
      },
    },
    taskRuns: {
      async list(scope: AgentScope) {
        const result = await pool.query(
          "SELECT * FROM task_runs WHERE user_id = $1 AND agent_id = $2 ORDER BY created_at DESC LIMIT 100",
          [scope.userId, scope.agentId],
        );
        return result.rows;
      },
      async create(scope: AgentScope, input: {
        conversationId?: string | null;
        kind: "sandbox" | "spreadsheet" | "presentation";
        inputSummary: string;
        metadata?: unknown;
      }): Promise<string> {
        const result = await pool.query(
          `INSERT INTO task_runs (user_id, agent_id, conversation_id, kind, status, input_summary, metadata)
           SELECT $1, $2, $3, $4, 'running', $5, $6
           WHERE (
             $3::uuid IS NULL OR EXISTS (
               SELECT 1 FROM conversations
               WHERE conversations.user_id = $1 AND conversations.agent_id = $2 AND conversations.id = $3
             )
           )
           RETURNING id`,
          [scope.userId, scope.agentId, input.conversationId ?? null, input.kind, input.inputSummary, JSON.stringify(input.metadata ?? {})],
        );
        if (!result.rows[0]) throw new Error("conversation_not_found");
        return result.rows[0].id;
      },
      async completeWithArtifacts(
        scope: AgentScope,
        taskRunId: string,
        outputSummary: string,
        artifactIds: string[],
      ): Promise<void> {
        const uniqueArtifactIds = [...new Set(artifactIds)];
        if (uniqueArtifactIds.length !== artifactIds.length) {
          throw new Error("task_artifact_transition_failed");
        }

        const client = await pool.connect();
        let commitAttempted = false;
        let clientReleased = false;
        try {
          await client.query("BEGIN");
          if (uniqueArtifactIds.length > 0) {
            const artifacts = await client.query<{ id: string }>(
              `UPDATE task_artifacts
               SET status = 'ready', temporary_storage_path = NULL, updated_at = now()
               WHERE user_id = $1
                 AND agent_id = $2
                 AND task_run_id = $3
                 AND id = ANY($4::uuid[])
                 AND status = 'pending'
               RETURNING id`,
              [scope.userId, scope.agentId, taskRunId, uniqueArtifactIds],
            );
            if (artifacts.rows.length !== uniqueArtifactIds.length) {
              throw new Error("task_artifact_transition_failed");
            }
          }

          const task = await client.query<{ id: string }>(
            `UPDATE task_runs
             SET status = 'succeeded', output_summary = $4, error = NULL, updated_at = now()
             WHERE user_id = $1 AND agent_id = $2 AND id = $3 AND status = 'running'
             RETURNING id`,
            [scope.userId, scope.agentId, taskRunId, outputSummary],
          );
          if (!task.rows[0]) throw new Error("task_completion_transition_failed");
          commitAttempted = true;
          await client.query("COMMIT");
        } catch (error) {
          if (commitAttempted) {
            client.release(true);
            clientReleased = true;
            const outcome = await verifyTaskCompletionAfterCommitError(
              pool,
              scope,
              taskRunId,
              uniqueArtifactIds,
            );
            if (outcome === "committed") return;
            if (outcome === "not_committed") {
              throw new TaskCompletionNotCommittedError();
            }
            throw new TaskCompletionAmbiguousError();
          }
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          if (!clientReleased) client.release();
        }
      },
      async fail(scope: AgentScope, taskRunId: string, error: string): Promise<void> {
        await pool.query(
          `UPDATE task_runs
           SET status = 'failed', error = $4, updated_at = now()
           WHERE user_id = $1 AND agent_id = $2 AND id = $3 AND status = 'running'`,
          [scope.userId, scope.agentId, taskRunId, error],
        );
      },
    },
    taskArtifacts: {
      async createPending(scope: AgentScope, input: {
        taskRunId: string;
        fileName: string;
        mimeType: string;
        storagePath: string;
        temporaryStoragePath: string;
        metadata?: unknown;
      }): Promise<string> {
        const result = await pool.query(
          `INSERT INTO task_artifacts (
             user_id, agent_id, task_run_id, file_name, mime_type,
             storage_path, temporary_storage_path, status, metadata
           )
           SELECT $1, $2, task_run.id, $4, $5, $6, $7, 'pending', $8
           FROM task_runs AS task_run
           WHERE task_run.user_id = $1
             AND task_run.agent_id = $2
             AND task_run.id = $3
             AND task_run.status = 'running'
           RETURNING id`,
          [
            scope.userId,
            scope.agentId,
            input.taskRunId,
            input.fileName,
            input.mimeType,
            input.storagePath,
            input.temporaryStoragePath,
            JSON.stringify(input.metadata ?? {}),
          ],
        );
        if (!result.rows[0]) throw new Error("task_run_not_found");
        return result.rows[0].id;
      },
      async deletePending(scope: AgentScope, artifactId: string): Promise<boolean> {
        const result = await pool.query(
          `DELETE FROM task_artifacts
           WHERE user_id = $1 AND agent_id = $2 AND id = $3 AND status = 'pending'
           RETURNING id`,
          [scope.userId, scope.agentId, artifactId],
        );
        return Boolean(result.rows[0]);
      },
      async list(scope: AgentScope) {
        const result = await pool.query(
          `SELECT * FROM task_artifacts
           WHERE user_id = $1 AND agent_id = $2 AND status = 'ready'
           ORDER BY created_at DESC LIMIT 200`,
          [scope.userId, scope.agentId],
        );
        return result.rows;
      },
      async get(scope: AgentScope, artifactId: string) {
        const result = await pool.query(
          `SELECT * FROM task_artifacts
           WHERE user_id = $1 AND agent_id = $2 AND id = $3 AND status = 'ready'`,
          [scope.userId, scope.agentId, artifactId],
        );
        return result.rows[0] ?? null;
      },
      async listExpiredPending(scope: AgentScope, hours: number, limit = 100) {
        const result = await pool.query(
          `SELECT * FROM task_artifacts
           WHERE user_id = $1
             AND agent_id = $2
             AND status = 'pending'
             AND updated_at < now() - ($3 * interval '1 hour')
           ORDER BY updated_at
           LIMIT $4`,
          [scope.userId, scope.agentId, hours, limit],
        );
        return result.rows;
      },
    },
    toolRegistrations: {
      async create(userId: string, draft: ToolRegistrationDraft): Promise<void> {
        await pool.query(
          `INSERT INTO tool_registrations (user_id, name, description, command, kind, mcp_tool_name, status, requires_confirmation)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            userId,
            draft.name,
            draft.description,
            draft.command,
            draft.kind,
            draft.mcpToolName ?? null,
            draft.status,
            draft.requiresConfirmation,
          ],
        );
      },
      async list(userId: string) {
        const result = await pool.query("SELECT * FROM tool_registrations WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100", [
          userId,
        ]);
        return result.rows;
      },
      async listEnabled(scope: AgentScope): Promise<EnabledToolContext[]> {
        const result = await pool.query<{
          id: string;
          name: string;
          description: string;
          command: string;
          kind: "script" | "mcp";
          mcpToolName: string | null;
        }>(
          `SELECT tool.id, tool.name, tool.description, tool.command, tool.kind,
                  tool.mcp_tool_name AS "mcpToolName"
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
             AND tool.status = 'enabled'
             AND COALESCE(resource_grant.enabled, agent.inherits_user_resources)
           ORDER BY tool.updated_at DESC
           LIMIT 20`,
          [scope.userId, scope.agentId],
        );
        return result.rows
          .map((row) => ({
            name: row.name,
            description: row.description,
            command: row.command,
            kind: row.kind,
            mcpToolName: row.mcpToolName,
          }));
      },
      async setStatus(userId: string, id: string, status: "enabled" | "disabled" | "rejected"): Promise<void> {
        await pool.query("UPDATE tool_registrations SET status = $3, updated_at = now() WHERE user_id = $1 AND id = $2", [
          userId,
          id,
          status,
        ]);
      },
    },
    settings: {
      async get(scope: AgentScope) {
        return createAgentSettingsRepository(pool).get(scope);
      },
      async getUserModelRouting(userId: string): Promise<typeof defaultSettings.modelRouting> {
        await ensureSettings(pool, userId);
        const result = await pool.query("SELECT model_routing FROM settings WHERE user_id = $1", [userId]);
        return result.rows[0]?.model_routing ?? defaultSettings.modelRouting;
      },
      async update(scope: AgentScope, settings: typeof defaultSettings): Promise<void> {
        await ensureSettings(pool, scope.userId);
        await createAgentSettingsRepository(pool).ensure(scope);
        await pool.query(
          "UPDATE settings SET model_routing = $2, updated_at = now() WHERE user_id = $1",
          [scope.userId, settings.modelRouting],
        );
        await pool.query(
          `UPDATE agent_settings
           SET persona = $3,
               proactivity = $4,
               cadence = $5,
               search = $6,
               revision = revision + 1,
               updated_at = now()
           WHERE user_id = $1 AND agent_id = $2`,
          [scope.userId, scope.agentId, settings.persona, settings.proactivity, settings.cadence, settings.search],
        );
      },
    },
    personalData: {
      async export(userId: string) {
        const exported: Record<string, unknown[]> = {};
        for (const [table, columns] of Object.entries(PERSONAL_DATA_EXPORT_COLUMNS)) {
          const visibilityFilter = table === "task_artifacts" ? " AND status = 'ready'" : "";
          const result = await pool.query(
            `SELECT ${columns.join(", ")} FROM ${table} WHERE user_id = $1${visibilityFilter}`,
            [userId],
          );
          exported[table] = result.rows.map((row) => pickExportRow(row, columns));
        }
        const goalSteps = await pool.query(
          `SELECT ${GOAL_STEP_EXPORT_COLUMNS.map((column) => `goal_steps.${column}`).join(", ")}
           FROM goal_steps
           JOIN goals ON goals.id = goal_steps.goal_id
           WHERE goals.user_id = $1
           ORDER BY goal_steps.created_at ASC, goal_steps.id ASC`,
          [userId],
        );
        exported.goal_steps = goalSteps.rows.map((row) => pickExportRow(row, GOAL_STEP_EXPORT_COLUMNS));
        const attachments = await pool.query(
          `SELECT ${ATTACHMENT_EXPORT_COLUMNS.join(", ")}
           FROM message_attachments
           WHERE user_id = $1
           ORDER BY created_at ASC, id ASC`,
          [userId],
        );
        exported.message_attachments = attachments.rows.map((row) => pickExportRow(row, ATTACHMENT_EXPORT_COLUMNS));
        return buildPersonalDataExport({ userId, exportedAt: new Date(), tables: exported });
      },
      async listAttachmentStorageKeys(userId: string): Promise<string[]> {
        const result = await pool.query<{ storage_key: string }>(
          `SELECT storage_key
           FROM message_attachments
           WHERE user_id = $1
           ORDER BY created_at ASC, id ASC`,
          [userId],
        );
        return result.rows.map((row) => row.storage_key);
      },
      async clear(userId: string): Promise<void> {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const selectedAgent = await client.query<{ id: string }>(
            `SELECT id
             FROM digital_agents
             WHERE user_id = $1
             ORDER BY is_default DESC, created_at ASC, id ASC
             LIMIT 1
             FOR UPDATE`,
            [userId],
          );
          let defaultAgentId = selectedAgent.rows[0]?.id ?? null;

          const tables = [
            "goals",
            "skill_usage_logs",
            "skill_revisions",
            "task_artifacts",
            "task_runs",
            "tool_registrations",
            "skills",
            "reflections",
            "interjection_decisions",
            "channel_messages",
            "channel_identities",
            "proactive_tasks",
            "tool_call_logs",
            "llm_usage_logs",
            "memory_jobs",
            "conversation_summaries",
            "memory_entries",
            "message_attachments",
            "messages",
            "conversations",
            "projects",
            "agent_resource_grants",
          ];
          for (const table of tables) {
            await client.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
          }

          if (defaultAgentId) {
            // Delete other agents before claiming the canonical slug so a
            // non-default "digitalmate" row cannot violate the unique key.
            await client.query(
              "DELETE FROM digital_agents WHERE user_id = $1 AND id <> $2",
              [userId, defaultAgentId],
            );
            await client.query(
              `UPDATE digital_agents
               SET slug = 'digitalmate',
                   display_name = 'DigitalMate',
                   persona = '{}'::jsonb,
                   status = 'active',
                   is_default = true,
                   inherits_user_resources = true,
                   updated_at = now()
               WHERE user_id = $1 AND id = $2`,
              [userId, defaultAgentId],
            );
          } else {
            const createdAgent = await client.query<{ id: string }>(
              `INSERT INTO digital_agents (
                 user_id, slug, display_name, persona, status, is_default, inherits_user_resources
               )
               VALUES ($1, 'digitalmate', 'DigitalMate', '{}'::jsonb, 'active', true, true)
               RETURNING id`,
              [userId],
            );
            defaultAgentId = createdAgent.rows[0].id;
          }

          await client.query(
            `INSERT INTO settings (user_id, persona, proactivity, model_routing, cadence, search)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (user_id) DO UPDATE
             SET persona = EXCLUDED.persona,
                 proactivity = EXCLUDED.proactivity,
                 model_routing = EXCLUDED.model_routing,
                 cadence = EXCLUDED.cadence,
                 search = EXCLUDED.search,
                 updated_at = now()`,
            [
              userId,
              defaultSettings.persona,
              defaultSettings.proactivity,
              defaultSettings.modelRouting,
              defaultSettings.cadence,
              defaultSettings.search,
            ],
          );
          await client.query(
            `INSERT INTO agent_settings (
               user_id, agent_id, persona, proactivity, cadence, search, model_routing_override
             )
             VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb)
             ON CONFLICT (user_id, agent_id) DO UPDATE
             SET persona = EXCLUDED.persona,
                 proactivity = EXCLUDED.proactivity,
                 cadence = EXCLUDED.cadence,
                 search = EXCLUDED.search,
                 model_routing_override = '{}'::jsonb,
                 revision = agent_settings.revision + 1,
                 updated_at = now()`,
            [
              userId,
              defaultAgentId,
              defaultSettings.persona,
              defaultSettings.proactivity,
              defaultSettings.cadence,
              defaultSettings.search,
            ],
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      },
    },
  };
}

function channelConversationTitle(message: NormalizedChannelMessage): string {
  return `${message.channel}:${message.externalConversationId}`;
}

const SEMANTIC_WEIGHT = 0.7;
const LEXICAL_WEIGHT = 0.3;

function mergeMemoryCandidates(
  query: string,
  lexicalCandidates: RankableMemory[],
  semanticCandidates: Array<RankableMemory & { similarity: number }>,
): RankableMemory[] {
  const scored = new Map<string, { memory: RankableMemory; score: number }>();
  const now = Date.now();

  for (const candidate of semanticCandidates) {
    scored.set(candidate.id, {
      memory: { id: candidate.id, content: candidate.content, createdAt: candidate.createdAt },
      score: SEMANTIC_WEIGHT * Math.max(0, candidate.similarity),
    });
  }
  for (const memory of lexicalCandidates) {
    const lexical = LEXICAL_WEIGHT * lexicalRelevanceScore(query, memory.content);
    const existing = scored.get(memory.id);
    if (existing) {
      existing.score += lexical;
    } else {
      scored.set(memory.id, { memory, score: lexical });
    }
  }

  return [...scored.values()]
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || recencyValue(b.memory, now) - recencyValue(a.memory, now))
    .slice(0, 8)
    .map((entry) => entry.memory);
}

function recencyValue(memory: RankableMemory, now: number): number {
  return -(now - memory.createdAt.getTime());
}

function memoryExpiresAt(memory: ExtractedMemory): Date | null {
  if (memory.kind !== "episodic") return null;
  return new Date(Date.now() + EPISODIC_MEMORY_TTL_DAYS * 86_400_000);
}

function mapSkillRow(row: Record<string, unknown>): DbSkill {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    name: row.name as string,
    trigger: row.trigger as string,
    content: row.content as string,
    status: row.status as DbSkill["status"],
    source: (row.source ?? "manual") as DbSkill["source"],
    sourceUrl: (row.source_url ?? null) as string | null,
    version: Number(row.version ?? 1),
    scanReport: row.scan_report ?? null,
    usageCount: Number(row.usage_count ?? 0),
    lastUsedAt: (row.last_used_at ?? null) as Date | null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

function mapSkillRevisionRow(row: Record<string, unknown>): DbSkillRevision {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    skillId: row.skill_id as string,
    skillName: (row.skill_name ?? "") as string,
    currentContent: (row.current_content ?? "") as string,
    proposedContent: row.proposed_content as string,
    reason: row.reason as string,
    status: row.status as DbSkillRevision["status"],
    createdAt: row.created_at as Date,
  };
}

/** Requires at least a trigger/name-level match (weights: name 4, trigger 3, content 1). */
const AUTO_MATCH_MIN_SCORE = 3;

function scoreSkill(query: string, skill: { name: string; trigger: string; content: string }): number {
  const normalizedQuery = query.toLowerCase();
  const fields = [
    { value: skill.name, weight: 4 },
    { value: skill.trigger, weight: 3 },
    { value: skill.content, weight: 1 },
  ];
  return fields.reduce((score, field) => {
    const normalizedValue = field.value.toLowerCase();
    return normalizedQuery.includes(normalizedValue) || normalizedValue.includes(normalizedQuery)
      ? score + field.weight
      : score;
  }, 0);
}

async function ensureSettings(pool: Pool, userId: string): Promise<void> {
  await pool.query(
    `INSERT INTO settings (user_id, persona, proactivity, model_routing, cadence, search)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id) DO NOTHING`,
    [
      userId,
      defaultSettings.persona,
      defaultSettings.proactivity,
      defaultSettings.modelRouting,
      defaultSettings.cadence,
      defaultSettings.search,
    ],
  );
}

function mapUser(row: { id: string; display_name: string }): DbUser {
  return { id: row.id, displayName: row.display_name };
}

function mapConversation(row: Record<string, unknown>): DbConversation {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    agentId: String(row.agent_id),
    channel: String(row.channel),
    title: String(row.title),
    projectId: row.project_id ? String(row.project_id) : null,
    pinned: Boolean(row.pinned),
    updatedAt: row.updated_at as Date,
  };
}

function mapProject(row: Record<string, unknown>): DbProject {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    agentId: String(row.agent_id),
    name: String(row.name),
    description: String(row.description ?? ""),
    updatedAt: row.updated_at as Date,
  };
}

function mapMessage(row: Record<string, unknown>): DbMessage {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    agentId: String(row.agent_id),
    conversationId: String(row.conversation_id),
    role: row.role as DbMessage["role"],
    content: String(row.content),
    createdAt: row.created_at as Date,
  };
}

function mapMessageAttachment(row: Record<string, unknown>): DbMessageAttachment {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    agentId: String(row.agent_id),
    messageId: row.message_id ? String(row.message_id) : null,
    kind: row.kind as AttachmentKind,
    fileName: String(row.file_name),
    mimeType: String(row.mime_type),
    sizeBytes: Number(row.size_bytes),
    storageKey: String(row.storage_key),
    extractedText: row.extracted_text === null || row.extracted_text === undefined ? null : String(row.extracted_text),
    textTruncated: Boolean(row.text_truncated),
    status: row.status as DbAttachmentStatus,
    errorCode: row.error_code === null || row.error_code === undefined ? null : String(row.error_code),
    deletionClaimToken:
      row.deletion_claim_token === null || row.deletion_claim_token === undefined
        ? null
        : String(row.deletion_claim_token),
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

function validateAttachmentClaimLimit(hours: number, limit: number): { safeHours: number; safeLimit: number } {
  if (!Number.isSafeInteger(hours) || hours <= 0 || !Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError("invalid_attachment_claim_limit");
  }
  return { safeHours: hours, safeLimit: Math.min(limit, 100) };
}

function mapGoal(row: Record<string, unknown>): DbGoal {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    agentId: String(row.agent_id),
    title: String(row.title),
    contract: (isRecord(row.contract) ? row.contract : {}) as GoalContract,
    status: row.status as GoalStatus,
    progressSummary: String(row.progress_summary ?? ""),
    reportDraft: String(row.report_draft ?? ""),
    budgetUsed: (isRecord(row.budget_used) ? row.budget_used : { ...DEFAULT_GOAL_BUDGET_USED }) as GoalBudgetUsed,
    noProgressRounds: Number(row.no_progress_rounds ?? 0),
    runningStep: row.running_step ? String(row.running_step) : null,
    needsHumanPrompt: row.needs_human_prompt ? String(row.needs_human_prompt) : null,
    conversationId: row.conversation_id ? String(row.conversation_id) : null,
    nextRunAt: (row.next_run_at as Date | null) ?? null,
    finishedAt: (row.finished_at as Date | null) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

function mapGoalStep(row: Record<string, unknown>): DbGoalStep {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    goalId: String(row.goal_id),
    round: Number(row.round),
    phase: row.phase as GoalStepPhase,
    intent: String(row.intent ?? ""),
    evidence: Array.isArray(row.evidence) ? row.evidence : [],
    candidate: String(row.candidate ?? ""),
    verifyResult: row.verify_result ?? null,
    failedPaths: Array.isArray(row.failed_paths) ? row.failed_paths : [],
    tokensUsed: Number(row.tokens_used ?? 0),
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
    error: row.error ? String(row.error) : null,
    createdAt: row.created_at as Date,
  };
}

function mapProactiveTask(row: Record<string, unknown>): DbProactiveTask {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    agentId: String(row.agent_id),
    conversationId: String(row.conversation_id),
    kind: row.kind as DbProactiveTask["kind"],
    content: String(row.content),
    scheduledAt: row.scheduled_at as Date,
    status: String(row.status),
    metadata: isRecord(row.metadata) ? row.metadata : {},
  };
}

function pickExportRow(
  row: Record<string, unknown>,
  columns: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    columns
      .filter((column) => Object.hasOwn(row, column))
      .map((column) => [column, sanitizeExportValue(row[column])]),
  );
}

function sanitizeExportValue(value: unknown): unknown {
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(sanitizeExportValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isInternalExportKey(key))
      .map(([key, nestedValue]) => [key, sanitizeExportValue(nestedValue)]),
  );
}

function isInternalExportKey(key: string): boolean {
  const segments = key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[^a-zA-Z0-9]+/)
    .map((segment) => segment.toLowerCase())
    .filter(Boolean);
  const concept = segments.join("");
  return SENSITIVE_EXPORT_KEY_CONCEPTS.has(concept)
    || segments.some((segment) => SENSITIVE_EXPORT_KEY_SEGMENTS.has(segment));
}

function createAdvisoryLease(
  client: PoolClient,
  lockKey: string,
  userId: string,
  epoch: string,
  mode: UserDataLease["mode"],
): UserDataLease {
  let released = false;
  return {
    userId,
    epoch,
    mode,
    async release() {
      if (released) return;
      released = true;
      await releaseAdvisoryLease(client, lockKey, mode);
    },
  };
}

async function releaseAdvisoryLease(
  client: PoolClient,
  lockKey: string,
  mode: UserDataLease["mode"],
): Promise<void> {
  const sql = mode === "shared"
    ? "SELECT pg_advisory_unlock_shared(hashtextextended($1, 0)) AS unlocked"
    : "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked";
  try {
    const result = await client.query<{ unlocked: boolean }>(sql, [lockKey]);
    if (result.rows[0]?.unlocked !== true) {
      throw new Error("user_data_lease_not_held");
    }
    client.release();
  } catch (error) {
    client.release(true);
    throw error;
  }
}

async function releaseTurnExecutionLock(
  client: PoolClient,
  lockKey: string,
): Promise<void> {
  try {
    const result = await client.query<{ unlocked: boolean }>(
      "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked",
      [lockKey],
    );
    if (result.rows[0]?.unlocked !== true) {
      throw new Error("client_turn_lock_not_held");
    }
    client.release();
  } catch (error) {
    client.release(true);
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function connectPoolClient(pool: Pool, signal?: AbortSignal): Promise<PoolClient> {
  signal?.throwIfAborted();
  if (!signal) return pool.connect();

  return new Promise<PoolClient>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void pool.connect().then(
      (client) => {
        if (settled) {
          client.release();
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(client);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
