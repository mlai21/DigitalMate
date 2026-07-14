import type { Pool } from "pg";
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
import { defaultSettings } from "@/server/settings/defaults";
import { DEFAULT_GOAL_BUDGET_USED, type GoalBudgetUsed, type GoalContract } from "@/server/goals/contract";
import type { GoalStatus } from "@/server/goals/state-machine";
import { getPool, getTurnLockPool } from "@/server/db/client";
import {
  ATTACHMENT_LIMITS,
  type AttachmentKind,
  type AttachmentStatus,
} from "@/server/attachments/types";

const EPISODIC_MEMORY_TTL_DAYS = 180;
const ACTIVE_MEMORY_CONDITION = "deleted_at IS NULL AND (expires_at IS NULL OR expires_at > now())";

export type DbUser = {
  id: string;
  displayName: string;
};

export type DbConversation = {
  id: string;
  userId: string;
  channel: string;
  title: string;
  projectId: string | null;
  pinned: boolean;
  updatedAt: Date;
};

export type DbProject = {
  id: string;
  userId: string;
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
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: Date;
};

export type DbMessageAttachment = {
  id: string;
  userId: string;
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
  kind: string;
  confidence: number;
};

export type DbGoal = {
  id: string;
  userId: string;
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
  conversationId: string;
  kind: "reminder" | "follow_up" | "share";
  content: string;
  scheduledAt: Date;
  status: string;
  metadata: Record<string, unknown>;
};

export function createRepositories(providedPool?: Pool, providedTurnLockPool?: Pool) {
  const pool = providedPool ?? getPool();
  const turnLockPool = providedTurnLockPool ?? (providedPool ? pool : getTurnLockPool());
  return {
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
      async getOrCreateDefault(userId: string): Promise<DbConversation> {
        const existing = await pool.query(
          "SELECT * FROM conversations WHERE user_id = $1 AND channel = 'web' ORDER BY updated_at DESC LIMIT 1",
          [userId],
        );
        if (existing.rows[0]) return mapConversation(existing.rows[0]);

        const created = await pool.query("INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING *", [
          userId,
          "和 DigitalMate 的对话",
        ]);
        return mapConversation(created.rows[0]);
      },
      async create(userId: string, input?: { title?: string; projectId?: string | null }): Promise<DbConversation> {
        const created = await pool.query(
          "INSERT INTO conversations (user_id, title, project_id) VALUES ($1, $2, $3) RETURNING *",
          [userId, input?.title?.trim() || "新的对话", input?.projectId ?? null],
        );
        return mapConversation(created.rows[0]);
      },
      async getForUser(userId: string, conversationId: string): Promise<DbConversation | null> {
        const result = await pool.query("SELECT * FROM conversations WHERE user_id = $1 AND id = $2", [
          userId,
          conversationId,
        ]);
        return result.rows[0] ? mapConversation(result.rows[0]) : null;
      },
      async list(userId: string): Promise<DbConversation[]> {
        const result = await pool.query("SELECT * FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC", [userId]);
        return result.rows.map(mapConversation);
      },
      async listWithStats(userId: string): Promise<DbConversationSummaryRow[]> {
        const result = await pool.query(
          `SELECT c.*,
                  count(m.id) FILTER (WHERE m.visible_to_user = true)::int AS message_count,
                  max(m.created_at) AS last_message_at
           FROM conversations c
           LEFT JOIN messages m ON m.conversation_id = c.id
           WHERE c.user_id = $1
           GROUP BY c.id
           ORDER BY c.pinned DESC, c.updated_at DESC`,
          [userId],
        );
        return result.rows.map((row) => ({
          ...mapConversation(row),
          messageCount: Number(row.message_count ?? 0),
          lastMessageAt: (row.last_message_at as Date | null) ?? null,
        }));
      },
      async update(
        userId: string,
        conversationId: string,
        input: { title?: string; pinned?: boolean; projectId?: string | null },
      ): Promise<DbConversation | null> {
        const result = await pool.query(
          `UPDATE conversations SET
             title = COALESCE($3, title),
             pinned = COALESCE($4, pinned),
             project_id = CASE WHEN $5 THEN $6::uuid ELSE project_id END,
             updated_at = now()
           WHERE user_id = $1 AND id = $2
           RETURNING *`,
          [
            userId,
            conversationId,
            input.title?.trim() || null,
            input.pinned ?? null,
            input.projectId !== undefined,
            input.projectId ?? null,
          ],
        );
        return result.rows[0] ? mapConversation(result.rows[0]) : null;
      },
      async setTitleIfDefault(conversationId: string, title: string): Promise<void> {
        const trimmed = title.trim();
        if (!trimmed) return;
        await pool.query("UPDATE conversations SET title = $2 WHERE id = $1 AND title IN ('新的对话', '和 DigitalMate 的对话')", [
          conversationId,
          trimmed.slice(0, 60),
        ]);
      },
      async delete(userId: string, conversationId: string): Promise<void> {
        await pool.query("DELETE FROM conversations WHERE user_id = $1 AND id = $2", [userId, conversationId]);
      },
    },
    projects: {
      async create(userId: string, input: { name: string; description?: string }): Promise<DbProject> {
        const result = await pool.query(
          "INSERT INTO projects (user_id, name, description) VALUES ($1, $2, $3) RETURNING *",
          [userId, input.name.trim(), input.description?.trim() ?? ""],
        );
        return mapProject(result.rows[0]);
      },
      async list(userId: string): Promise<DbProject[]> {
        const result = await pool.query("SELECT * FROM projects WHERE user_id = $1 ORDER BY updated_at DESC", [userId]);
        return result.rows.map(mapProject);
      },
      async getForUser(userId: string, projectId: string): Promise<DbProject | null> {
        const result = await pool.query("SELECT * FROM projects WHERE user_id = $1 AND id = $2", [userId, projectId]);
        return result.rows[0] ? mapProject(result.rows[0]) : null;
      },
      async update(userId: string, projectId: string, input: { name?: string; description?: string }): Promise<DbProject | null> {
        const result = await pool.query(
          `UPDATE projects SET
             name = COALESCE($3, name),
             description = COALESCE($4, description),
             updated_at = now()
           WHERE user_id = $1 AND id = $2
           RETURNING *`,
          [userId, projectId, input.name?.trim() || null, input.description?.trim() ?? null],
        );
        return result.rows[0] ? mapProject(result.rows[0]) : null;
      },
      async delete(userId: string, projectId: string): Promise<void> {
        await pool.query("DELETE FROM projects WHERE user_id = $1 AND id = $2", [userId, projectId]);
      },
    },
    messages: {
      async create(input: {
        userId: string;
        conversationId: string;
        role: DbMessage["role"];
        content: string;
        visibleToUser?: boolean;
        memoryProcessed?: boolean;
      }): Promise<DbMessage> {
        const result = await pool.query(
          `INSERT INTO messages (user_id, conversation_id, role, content, visible_to_user, memory_processed)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [
            input.userId,
            input.conversationId,
            input.role,
            input.content,
            input.visibleToUser ?? true,
            input.memoryProcessed ?? false,
          ],
        );
        await pool.query("UPDATE conversations SET updated_at = now() WHERE id = $1", [input.conversationId]);
        return mapMessage(result.rows[0]);
      },
      async createWithAttachments(input: {
        userId: string;
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
            "SELECT id FROM conversations WHERE id = $1 AND user_id = $2",
            [input.conversationId, input.userId],
          );
          if (!conversation.rows[0]) {
            throw new Error("conversation_not_found");
          }

          let lockedAttachments: DbMessageAttachment[] = [];
          if (input.attachmentIds.length > 0) {
            const locked = await client.query(
              `SELECT * FROM message_attachments
               WHERE id = ANY($1::uuid[]) AND user_id = $2
               ORDER BY id
               FOR UPDATE`,
              [input.attachmentIds, input.userId],
            );
            lockedAttachments = locked.rows.map(mapMessageAttachment);

            const allBindable =
              lockedAttachments.length === input.attachmentIds.length
              && lockedAttachments.every(
                (attachment) =>
                  attachment.userId === input.userId
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
            `INSERT INTO messages (user_id, conversation_id, role, content)
             VALUES ($1, $2, 'user', $3)
             RETURNING *`,
            [input.userId, input.conversationId, input.content],
          );
          const message = mapMessage(createdMessage.rows[0]);

          let attachments: DbMessageAttachment[] = [];
          if (input.attachmentIds.length > 0) {
            const bound = await client.query(
              `UPDATE message_attachments
               SET message_id = $2, status = 'bound', updated_at = now()
               WHERE id = ANY($1::uuid[])
                 AND user_id = $3
                 AND status = 'ready'
                 AND message_id IS NULL
               RETURNING *`,
              [input.attachmentIds, message.id, input.userId],
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
            "UPDATE conversations SET updated_at = now() WHERE id = $1 AND user_id = $2",
            [input.conversationId, input.userId],
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
      async createIdempotentUserTurn(input: {
        userId: string;
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
            "SELECT id FROM conversations WHERE id = $1 AND user_id = $2",
            [input.conversationId, input.userId],
          );
          if (!conversation.rows[0]) throw new Error("conversation_not_found");

          const inserted = await client.query(
            `INSERT INTO messages
             (user_id, conversation_id, role, content, client_turn_id, client_turn_payload_hash)
             VALUES ($1, $2, 'user', $3, $4, $5)
             ON CONFLICT (user_id, client_turn_id, role) WHERE client_turn_id IS NOT NULL
             DO NOTHING
             RETURNING *`,
            [input.userId, input.conversationId, input.content, input.clientTurnId, input.payloadHash],
          );
          const created = inserted.rows.length > 0;
          const storedRow = created
            ? inserted.rows[0]
            : (await client.query(
                `SELECT * FROM messages
                 WHERE user_id = $1 AND client_turn_id = $2 AND role = 'user'
                 FOR UPDATE`,
                [input.userId, input.clientTurnId],
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
                   WHERE user_id = $1 AND message_id = $2`,
                  [input.userId, message.id],
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
               WHERE id = ANY($1::uuid[]) AND user_id = $2
               ORDER BY id
               FOR UPDATE`,
              [input.attachmentIds, input.userId],
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
               SET message_id = $2, status = 'bound', updated_at = now()
               WHERE id = ANY($1::uuid[])
                 AND user_id = $3
                 AND status = 'ready'
                 AND message_id IS NULL
               RETURNING *`,
              [input.attachmentIds, message.id, input.userId],
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
            "UPDATE conversations SET updated_at = now() WHERE id = $1 AND user_id = $2",
            [input.conversationId, input.userId],
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
      async createIdempotentAssistantTurn(input: {
        userId: string;
        conversationId: string;
        clientTurnId: string;
        content: string;
      }): Promise<{ message: DbMessage; created: boolean }> {
        const inserted = await pool.query(
          `INSERT INTO messages (user_id, conversation_id, role, content, client_turn_id)
           VALUES ($1, $2, 'assistant', $3, $4)
           ON CONFLICT (user_id, client_turn_id, role) WHERE client_turn_id IS NOT NULL
           DO NOTHING
           RETURNING *`,
          [input.userId, input.conversationId, input.content, input.clientTurnId],
        );
        const created = inserted.rows.length > 0;
        const row = created
          ? inserted.rows[0]
          : (await pool.query(
              `SELECT * FROM messages
               WHERE user_id = $1 AND client_turn_id = $2 AND role = 'assistant'`,
              [input.userId, input.clientTurnId],
            )).rows[0];
        if (!row) throw new Error("client_turn_assistant_missing");
        if (created) {
          await pool.query("UPDATE conversations SET updated_at = now() WHERE id = $1", [input.conversationId]);
        }
        return { message: mapMessage(row), created };
      },
      async acquireClientTurnExecutionLock(
        userId: string,
        clientTurnId: string,
      ): Promise<() => Promise<void>> {
        const lockKey = `${userId}:${clientTurnId}`;
        while (true) {
          const client = await turnLockPool.connect();
          let locked = false;
          try {
            const result = await client.query<{ locked: boolean }>(
              "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
              [lockKey],
            );
            locked = result.rows[0]?.locked === true;
          } catch (error) {
            client.release(true);
            throw error;
          }
          if (!locked) {
            client.release();
            await new Promise((resolve) => setTimeout(resolve, 25));
            continue;
          }

          let released = false;
          return async () => {
            if (released) return;
            released = true;
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
          };
        }
      },
      async findByClientTurn(
        userId: string,
        clientTurnId: string,
        role: "user" | "assistant",
      ): Promise<DbMessage | null> {
        const result = await pool.query(
          `SELECT * FROM messages
           WHERE user_id = $1 AND client_turn_id = $2 AND role = $3`,
          [userId, clientTurnId, role],
        );
        return result.rows[0] ? mapMessage(result.rows[0]) : null;
      },
      async createFromProactiveTask(input: {
        taskId: string;
        userId: string;
        conversationId: string;
        content: string;
      }): Promise<boolean> {
        const result = await pool.query(
          `INSERT INTO messages (user_id, conversation_id, role, content, source_task_id)
           VALUES ($1, $2, 'assistant', $3, $4)
           ON CONFLICT (source_task_id) WHERE source_task_id IS NOT NULL DO NOTHING
           RETURNING id`,
          [input.userId, input.conversationId, input.content, input.taskId],
        );
        if (result.rows.length === 0) return false;
        await pool.query("UPDATE conversations SET updated_at = now() WHERE id = $1", [input.conversationId]);
        return true;
      },
      async list(conversationId: string): Promise<DbMessage[]> {
        const result = await pool.query(
          "SELECT * FROM messages WHERE conversation_id = $1 AND visible_to_user = true ORDER BY created_at ASC",
          [conversationId],
        );
        return result.rows.map(mapMessage);
      },
      async listAllForAudit(conversationId: string): Promise<Array<DbMessage & { visibleToUser: boolean }>> {
        const result = await pool.query("SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC", [
          conversationId,
        ]);
        return result.rows.map((row) => ({ ...mapMessage(row), visibleToUser: Boolean(row.visible_to_user) }));
      },
      async recentHistory(conversationId: string, limit = 12, excludeClientTurnId?: string) {
        const result = await pool.query(
          `SELECT id, role, content FROM messages
           WHERE conversation_id = $1 AND visible_to_user = true AND role IN ('user', 'assistant')
             ${excludeClientTurnId ? "AND client_turn_id IS DISTINCT FROM $3::uuid" : ""}
           ORDER BY created_at DESC LIMIT $2`,
          excludeClientTurnId ? [conversationId, limit, excludeClientTurnId] : [conversationId, limit],
        );
        return result.rows
          .reverse()
          .map((row: { id: string; role: "user" | "assistant"; content: string }) => ({
            id: row.id,
            role: row.role,
            content: row.content,
          }));
      },
      async listAfter(conversationId: string, after: Date): Promise<DbMessage[]> {
        const result = await pool.query(
          "SELECT * FROM messages WHERE conversation_id = $1 AND visible_to_user = true AND created_at > $2 ORDER BY created_at ASC",
          [conversationId, after],
        );
        return result.rows.map(mapMessage);
      },
      async unprocessedForMemory(limit = 20): Promise<DbMessage[]> {
        const result = await pool.query(
          `SELECT * FROM messages
           WHERE memory_processed = false AND visible_to_user = true AND role = 'user'
           ORDER BY created_at ASC LIMIT $1`,
          [limit],
        );
        return result.rows.map(mapMessage);
      },
      async markMemoryProcessed(ids: string[]): Promise<void> {
        if (ids.length === 0) return;
        await pool.query("UPDATE messages SET memory_processed = true WHERE id = ANY($1::uuid[])", [ids]);
      },
    },
    messageAttachments: {
      async createDraft(input: {
        userId: string;
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
           (user_id, kind, file_name, mime_type, size_bytes, storage_key, extracted_text, text_truncated, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
           RETURNING *`,
          [
            input.userId,
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
      async markReady(userId: string, attachmentId: string): Promise<DbMessageAttachment | null> {
        const result = await pool.query(
          `UPDATE message_attachments
           SET status = 'ready', error_code = NULL, deletion_claim_token = NULL, updated_at = now()
           WHERE user_id = $1 AND id = $2
             AND message_id IS NULL AND status = 'pending'
           RETURNING *`,
          [userId, attachmentId],
        );
        return result.rows[0] ? mapMessageAttachment(result.rows[0]) : null;
      },
      async getForUser(userId: string, attachmentId: string): Promise<DbMessageAttachment | null> {
        const result = await pool.query(
          "SELECT * FROM message_attachments WHERE user_id = $1 AND id = $2",
          [userId, attachmentId],
        );
        return result.rows[0] ? mapMessageAttachment(result.rows[0]) : null;
      },
      async listForMessages(userId: string, messageIds: string[]): Promise<DbMessageAttachment[]> {
        if (messageIds.length === 0) return [];
        const result = await pool.query(
          `SELECT * FROM message_attachments
           WHERE user_id = $1 AND message_id = ANY($2::uuid[])
           ORDER BY created_at ASC, id ASC`,
          [userId, messageIds],
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
        userId: string,
        attachmentId: string,
      ): Promise<DbMessageAttachment | null> {
        const result = await pool.query(
          `UPDATE message_attachments
           SET status = 'deleting', deletion_claim_token = gen_random_uuid(), updated_at = now()
           WHERE user_id = $1 AND id = $2
             AND message_id IS NULL AND status IN ('ready', 'failed', 'deleting')
           RETURNING *`,
          [userId, attachmentId],
        );
        return result.rows[0] ? mapMessageAttachment(result.rows[0]) : null;
      },
      async deleteDraft(
        userId: string,
        attachmentId: string,
        deletionClaimToken: string,
      ): Promise<boolean> {
        const result = await pool.query(
          `DELETE FROM message_attachments
           WHERE user_id = $1 AND id = $2
             AND message_id IS NULL AND status = 'deleting'
             AND deletion_claim_token = $3
           RETURNING id`,
          [userId, attachmentId, deletionClaimToken],
        );
        return result.rows.length > 0;
      },
      async claimExpiredDrafts(hours: number, limit = 100): Promise<DbMessageAttachment[]> {
        const { safeHours, safeLimit } = validateAttachmentClaimLimit(hours, limit);
        const result = await pool.query(
          `WITH candidates AS (
             SELECT id
             FROM message_attachments
             WHERE message_id IS NULL
               AND (
                 (status = 'ready'
                   AND created_at < now() - ($1 * interval '1 hour'))
                 OR (status = 'pending'
                   AND created_at < now() - ($1 * interval '1 hour'))
                 OR (status = 'failed'
                   AND created_at < now() - ($1 * interval '1 hour')
                   AND updated_at < now() - interval '5 minutes')
                 OR (status = 'deleting'
                   AND updated_at < now() - interval '15 minutes')
               )
             ORDER BY updated_at ASC, id ASC
             LIMIT $2
             FOR UPDATE SKIP LOCKED
           )
           UPDATE message_attachments AS attachment
           SET status = 'deleting', deletion_claim_token = gen_random_uuid(), updated_at = now()
           FROM candidates
           WHERE attachment.id = candidates.id
           RETURNING attachment.*`,
          [safeHours, safeLimit],
        );
        return result.rows.map(mapMessageAttachment);
      },
      async markFailed(userId: string, attachmentId: string, errorCode: string): Promise<void> {
        await pool.query(
          `UPDATE message_attachments
           SET status = 'failed', error_code = $3, deletion_claim_token = NULL, updated_at = now()
           WHERE user_id = $1
             AND id = $2
             AND message_id IS NULL
             AND status IN ('pending', 'ready', 'failed')`,
          [userId, attachmentId, errorCode],
        );
      },
      async releaseDeletionClaim(
        userId: string,
        attachmentId: string,
        deletionClaimToken: string,
        errorCode: string,
      ): Promise<boolean> {
        const result = await pool.query(
          `UPDATE message_attachments
           SET status = 'failed', error_code = $4, deletion_claim_token = NULL, updated_at = now()
           WHERE user_id = $1 AND id = $2
             AND message_id IS NULL AND status = 'deleting'
             AND deletion_claim_token = $3
           RETURNING id`,
          [userId, attachmentId, deletionClaimToken, errorCode],
        );
        return result.rows.length > 0;
      },
    },
    memories: {
      async findRelevant(userId: string, query: string): Promise<RankableMemory[]> {
        const queryEmbedding = formatPgVector(await embedText(query));
        const semanticResult = await pool.query(
          `SELECT id, content, created_at, 1 - (embedding <=> $2::vector) AS similarity
           FROM memory_entries
           WHERE user_id = $1 AND ${ACTIVE_MEMORY_CONDITION} AND embedding IS NOT NULL
           ORDER BY embedding <=> $2::vector
           LIMIT 12`,
          [userId, queryEmbedding],
        );
        const lexicalResult = await pool.query(
          `SELECT id, content, created_at
           FROM memory_entries
           WHERE user_id = $1 AND ${ACTIVE_MEMORY_CONDITION}
           ORDER BY created_at DESC LIMIT 80`,
          [userId],
        );
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
      async createMany(userId: string, sourceMessageId: string | null, memories: ExtractedMemory[]): Promise<void> {
        for (const entry of memories) {
          const safeContent = redactSensitiveMemory(entry.content);
          if (!safeContent) continue;
          const memory = { ...entry, content: safeContent };
          const embedding = formatPgVector(await embedText(memory.content));
          const expiresAt = memoryExpiresAt(memory);
          await pool.query(
            `INSERT INTO memory_entries (user_id, kind, content, confidence, source_message_id, embedding, expires_at)
             SELECT $1, $2, $3, $4, $5, $6::vector, $7
             WHERE NOT EXISTS (
               SELECT 1 FROM memory_entries
               WHERE user_id = $1 AND content = $3 AND ${ACTIVE_MEMORY_CONDITION}
             )`,
            [userId, memory.kind, memory.content, memory.confidence, sourceMessageId, embedding, expiresAt],
          );
        }
      },
      async listActiveByKind(userId: string, kind: MemoryKind): Promise<DbMemoryEntry[]> {
        const result = await pool.query(
          `SELECT id, kind, content, confidence, created_at
           FROM memory_entries
           WHERE user_id = $1 AND kind = $2 AND ${ACTIVE_MEMORY_CONDITION}
           ORDER BY created_at ASC`,
          [userId, kind],
        );
        return result.rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          content: row.content,
          confidence: Number(row.confidence),
          createdAt: row.created_at,
        }));
      },
      async softDeleteMany(userId: string, memoryIds: string[]): Promise<void> {
        if (memoryIds.length === 0) return;
        await pool.query("UPDATE memory_entries SET deleted_at = now() WHERE user_id = $1 AND id = ANY($2::uuid[])", [
          userId,
          memoryIds,
        ]);
      },
      async list(userId: string): Promise<DbMemoryEntry[]> {
        const result = await pool.query(
          `SELECT id, kind, content, confidence, created_at
           FROM memory_entries
           WHERE user_id = $1 AND ${ACTIVE_MEMORY_CONDITION}
           ORDER BY created_at DESC`,
          [userId],
        );
        return result.rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          content: row.content,
          confidence: Number(row.confidence),
          createdAt: row.created_at,
        }));
      },
      async update(
        userId: string,
        memoryId: string,
        input: { kind: MemoryKind; content: string; confidence: number },
      ): Promise<void> {
        const content = redactSensitiveMemory(input.content);
        if (!content) return;
        const embedding = formatPgVector(await embedText(content));
        await pool.query(
          `UPDATE memory_entries
           SET kind = $3, content = $4, confidence = $5, embedding = $6::vector
           WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL`,
          [userId, memoryId, input.kind, content, input.confidence, embedding],
        );
      },
      async delete(userId: string, memoryId: string): Promise<void> {
        await pool.query("UPDATE memory_entries SET deleted_at = now() WHERE user_id = $1 AND id = $2", [userId, memoryId]);
      },
    },
    conversationSummaries: {
      async latest(conversationId: string): Promise<string | null> {
        const result = await pool.query(
          "SELECT summary FROM conversation_summaries WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1",
          [conversationId],
        );
        return result.rows[0]?.summary ?? null;
      },
      async create(input: {
        userId: string;
        conversationId: string;
        summary: string;
        messageCount: number;
      }): Promise<void> {
        await pool.query(
          `INSERT INTO conversation_summaries (user_id, conversation_id, summary, message_count)
           VALUES ($1, $2, $3, $4)`,
          [input.userId, input.conversationId, input.summary, input.messageCount],
        );
      },
    },
    toolLogs: {
      async create(input: ToolLogInput): Promise<void> {
        await pool.query(
          `INSERT INTO tool_call_logs
           (user_id, conversation_id, goal_id, tool_name, input_summary, output_summary, status, duration_ms, error)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            input.userId,
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
      async list(userId: string) {
        const result = await pool.query("SELECT * FROM tool_call_logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100", [
          userId,
        ]);
        return result.rows;
      },
      async listByConversation(userId: string, conversationId: string) {
        const result = await pool.query(
          "SELECT * FROM tool_call_logs WHERE user_id = $1 AND conversation_id = $2 ORDER BY created_at ASC LIMIT 200",
          [userId, conversationId],
        );
        return result.rows;
      },
    },
    llmUsage: {
      async create(input: LlmUsageLogInput): Promise<void> {
        await pool.query(
          `INSERT INTO llm_usage_logs
           (user_id, conversation_id, purpose, model, input_tokens, output_tokens, total_tokens)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            input.userId,
            input.conversationId ?? null,
            input.purpose,
            input.model,
            input.inputTokens,
            input.outputTokens,
            input.totalTokens,
          ],
        );
      },
      async list(userId: string) {
        const result = await pool.query(
          `SELECT id, purpose, model, input_tokens, output_tokens, total_tokens, created_at
           FROM llm_usage_logs
           WHERE user_id = $1
           ORDER BY created_at DESC
           LIMIT 500`,
          [userId],
        );
        return result.rows;
      },
    },
    proactiveTasks: {
      async create(input: {
        userId: string;
        conversationId: string;
        kind: "reminder" | "follow_up" | "share";
        content: string;
        scheduledAt: Date;
        metadata?: Record<string, unknown>;
      }): Promise<void> {
        await pool.query(
          `INSERT INTO proactive_tasks (user_id, conversation_id, kind, content, scheduled_at, metadata)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [input.userId, input.conversationId, input.kind, input.content, input.scheduledAt, JSON.stringify(input.metadata ?? {})],
        );
      },
      async due(now = new Date()): Promise<DbProactiveTask[]> {
        const result = await pool.query(
          "SELECT * FROM proactive_tasks WHERE status = 'pending' AND scheduled_at <= $1 ORDER BY scheduled_at ASC LIMIT 20",
          [now],
        );
        return result.rows.map(mapProactiveTask);
      },
      async markSent(taskId: string): Promise<void> {
        await pool.query("UPDATE proactive_tasks SET status = 'sent', sent_at = now(), updated_at = now() WHERE id = $1", [taskId]);
      },
      async markCancelled(taskId: string): Promise<void> {
        await pool.query("UPDATE proactive_tasks SET status = 'cancelled', updated_at = now() WHERE id = $1", [taskId]);
      },
      async markFailed(taskId: string): Promise<void> {
        await pool.query("UPDATE proactive_tasks SET status = 'failed', updated_at = now() WHERE id = $1", [taskId]);
      },
      async countSentToday(userId: string, now = new Date()): Promise<number> {
        const result = await pool.query(
          `SELECT count(*)::int AS count FROM proactive_tasks
           WHERE user_id = $1 AND status = 'sent' AND sent_at::date = $2::date`,
          [userId, now],
        );
        return Number(result.rows[0]?.count ?? 0);
      },
      async list(userId: string): Promise<DbProactiveTask[]> {
        const result = await pool.query("SELECT * FROM proactive_tasks WHERE user_id = $1 ORDER BY scheduled_at DESC LIMIT 100", [
          userId,
        ]);
        return result.rows.map(mapProactiveTask);
      },
      async latestByKind(userId: string, kind: DbProactiveTask["kind"]): Promise<Date | null> {
        const result = await pool.query(
          "SELECT created_at FROM proactive_tasks WHERE user_id = $1 AND kind = $2 ORDER BY created_at DESC LIMIT 1",
          [userId, kind],
        );
        return result.rows[0]?.created_at ?? null;
      },
      async unansweredStreak(userId: string): Promise<number> {
        const result = await pool.query(
          `WITH recent AS (
             SELECT id, conversation_id, sent_at
             FROM proactive_tasks
             WHERE user_id = $1 AND status = 'sent' AND sent_at IS NOT NULL
             ORDER BY sent_at DESC
             LIMIT 3
           )
           SELECT count(*)::int AS count
           FROM recent
           WHERE NOT EXISTS (
             SELECT 1 FROM messages
             WHERE messages.conversation_id = recent.conversation_id
               AND messages.role = 'user'
               AND messages.created_at > recent.sent_at
           )`,
          [userId],
        );
        return Number(result.rows[0]?.count ?? 0);
      },
    },
    goals: {
      async create(input: {
        userId: string;
        title: string;
        contract: GoalContract;
        conversationId?: string | null;
      }): Promise<DbGoal> {
        const result = await pool.query(
          `INSERT INTO goals (user_id, title, contract, conversation_id)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [input.userId, input.title.trim(), JSON.stringify(input.contract), input.conversationId ?? null],
        );
        return mapGoal(result.rows[0]);
      },
      async getForUser(userId: string, goalId: string): Promise<DbGoal | null> {
        const result = await pool.query("SELECT * FROM goals WHERE user_id = $1 AND id = $2", [userId, goalId]);
        return result.rows[0] ? mapGoal(result.rows[0]) : null;
      },
      async list(userId: string): Promise<DbGoal[]> {
        const result = await pool.query("SELECT * FROM goals WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 100", [userId]);
        return result.rows.map(mapGoal);
      },
      async listDue(now = new Date()): Promise<DbGoal[]> {
        const result = await pool.query(
          `SELECT * FROM goals
           WHERE status = 'confirmed'
              OR (status = 'running' AND next_run_at IS NOT NULL AND next_run_at <= $1)
           ORDER BY next_run_at ASC NULLS FIRST
           LIMIT 10`,
          [now],
        );
        return result.rows.map(mapGoal);
      },
      async setStatus(
        goalId: string,
        status: GoalStatus,
        options?: { needsHumanPrompt?: string | null; nextRunAt?: Date | null; finished?: boolean },
      ): Promise<void> {
        await pool.query(
          `UPDATE goals SET
             status = $2,
             needs_human_prompt = CASE WHEN $3 THEN $4 ELSE needs_human_prompt END,
             next_run_at = CASE WHEN $5 THEN $6 ELSE next_run_at END,
             finished_at = CASE WHEN $7 THEN now() ELSE finished_at END,
             updated_at = now()
           WHERE id = $1`,
          [
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
      async claimRunningStep(goalId: string, stepId: string): Promise<boolean> {
        const result = await pool.query(
          `UPDATE goals SET running_step = $2, updated_at = now()
           WHERE id = $1
             AND (running_step IS NULL OR updated_at < now() - interval '30 minutes')
           RETURNING id`,
          [goalId, stepId],
        );
        return result.rows.length > 0;
      },
      async releaseRunningStep(goalId: string, nextRunAt: Date | null): Promise<void> {
        await pool.query(
          "UPDATE goals SET running_step = NULL, next_run_at = $2, updated_at = now() WHERE id = $1",
          [goalId, nextRunAt],
        );
      },
      async updateProgress(
        goalId: string,
        input: { progressSummary?: string; reportDraft?: string; budgetUsed?: GoalBudgetUsed; noProgressRounds?: number },
      ): Promise<void> {
        await pool.query(
          `UPDATE goals SET
             progress_summary = COALESCE($2, progress_summary),
             report_draft = COALESCE($3, report_draft),
             budget_used = COALESCE($4, budget_used),
             no_progress_rounds = COALESCE($5, no_progress_rounds),
             updated_at = now()
           WHERE id = $1`,
          [
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
      async create(input: {
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
           (goal_id, round, phase, intent, evidence, candidate, verify_result, failed_paths, tokens_used, duration_ms, error)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING id`,
          [
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
        return result.rows[0].id;
      },
      async listByGoal(goalId: string): Promise<DbGoalStep[]> {
        const result = await pool.query("SELECT * FROM goal_steps WHERE goal_id = $1 ORDER BY round ASC, created_at ASC", [
          goalId,
        ]);
        return result.rows.map(mapGoalStep);
      },
      async latestRound(goalId: string): Promise<number> {
        const result = await pool.query("SELECT max(round)::int AS round FROM goal_steps WHERE goal_id = $1", [goalId]);
        return Number(result.rows[0]?.round ?? 0);
      },
    },
    channels: {
      async ensureConversation(userId: string, message: NormalizedChannelMessage): Promise<DbConversation> {
        const existing = await pool.query(
          "SELECT * FROM conversations WHERE user_id = $1 AND channel = $2 AND title = $3 ORDER BY updated_at DESC LIMIT 1",
          [userId, message.channel, channelConversationTitle(message)],
        );
        if (existing.rows[0]) return mapConversation(existing.rows[0]);

        const created = await pool.query(
          "INSERT INTO conversations (user_id, channel, title) VALUES ($1, $2, $3) RETURNING *",
          [userId, message.channel, channelConversationTitle(message)],
        );
        return mapConversation(created.rows[0]);
      },
      async createChannelMessage(input: {
        userId: string;
        conversationId: string;
        message: NormalizedChannelMessage;
      }): Promise<void> {
        await pool.query(
          `INSERT INTO channel_messages
           (user_id, conversation_id, channel, external_conversation_id, external_message_id, sender_id, chat_type, text, raw_payload, occurred_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (channel, external_message_id) DO NOTHING`,
          [
            input.userId,
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
      async recentBotMessageAt(channel: string, externalConversationId: string): Promise<Date | null> {
        const result = await pool.query(
          `SELECT created_at FROM interjection_decisions
           WHERE channel = $1 AND external_conversation_id = $2 AND should_interject = true
           ORDER BY created_at DESC LIMIT 1`,
          [channel, externalConversationId],
        );
        return result.rows[0]?.created_at ?? null;
      },
      async sentCounts(userId: string, channel: string, externalConversationId: string, now = new Date()) {
        const result = await pool.query(
          `SELECT
             count(*) FILTER (WHERE created_at >= $4::timestamptz - interval '1 hour')::int AS last_hour,
             count(*) FILTER (WHERE created_at::date = $4::date)::int AS today
           FROM interjection_decisions
           WHERE user_id = $1 AND channel = $2 AND external_conversation_id = $3 AND should_interject = true`,
          [userId, channel, externalConversationId, now],
        );
        return {
          sentInLastHour: Number(result.rows[0]?.last_hour ?? 0),
          sentToday: Number(result.rows[0]?.today ?? 0),
        };
      },
      async recentMessageCount(channel: string, externalConversationId: string, since: Date): Promise<number> {
        const result = await pool.query(
          `SELECT count(*)::int AS count
           FROM channel_messages
           WHERE channel = $1
             AND external_conversation_id = $2
             AND occurred_at >= $3`,
          [channel, externalConversationId, since],
        );
        return Number(result.rows[0]?.count ?? 0);
      },
      async createDecision(input: {
        userId: string;
        conversationId: string;
        message: NormalizedChannelMessage;
        shouldInterject: boolean;
        reason: string;
      }): Promise<void> {
        await pool.query(
          `INSERT INTO interjection_decisions
           (user_id, conversation_id, channel, external_conversation_id, should_interject, reason)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            input.userId,
            input.conversationId,
            input.message.channel,
            input.message.externalConversationId,
            input.shouldInterject,
            input.reason,
          ],
        );
      },
      async listDecisions(userId: string) {
        const result = await pool.query(
          `SELECT id, channel, external_conversation_id, should_interject, reason, created_at
           FROM interjection_decisions
           WHERE user_id = $1
           ORDER BY created_at DESC
           LIMIT 200`,
          [userId],
        );
        return result.rows;
      },
      async latestDirectTarget(userId: string): Promise<NormalizedChannelMessage | null> {
        const result = await pool.query(
          `SELECT channel, external_conversation_id, external_message_id, sender_id, chat_type, text, raw_payload, occurred_at
           FROM channel_messages
           WHERE user_id = $1 AND chat_type = 'direct'
           ORDER BY occurred_at DESC
           LIMIT 1`,
          [userId],
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
      async create(input: { userId: string; reflection: ReflectionRecord; sourceWindow?: unknown }): Promise<void> {
        await pool.query(
          `INSERT INTO reflections (user_id, positives, negatives, suggestions, source_window)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            input.userId,
            input.reflection.positives,
            input.reflection.negatives,
            input.reflection.suggestions,
            JSON.stringify(input.sourceWindow ?? {}),
          ],
        );
      },
      async list(userId: string) {
        const result = await pool.query("SELECT * FROM reflections WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100", [
          userId,
        ]);
        return result.rows;
      },
      async findAppliedSuggestions(userId: string): Promise<string[]> {
        const result = await pool.query<{ suggestions: string[] }>(
          "SELECT suggestions FROM reflections WHERE user_id = $1 AND status = 'applied' ORDER BY created_at DESC LIMIT 5",
          [userId],
        );
        return result.rows.flatMap((row) => row.suggestions).filter(Boolean).slice(0, 12);
      },
      async latestCreatedAt(userId: string): Promise<Date | null> {
        const result = await pool.query("SELECT created_at FROM reflections WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1", [
          userId,
        ]);
        return result.rows[0]?.created_at ?? null;
      },
      async latestBySourceEvent(userId: string, event: string): Promise<Date | null> {
        const result = await pool.query(
          `SELECT created_at
           FROM reflections
           WHERE user_id = $1 AND source_window->>'event' = $2
           ORDER BY created_at DESC
           LIMIT 1`,
          [userId, event],
        );
        return result.rows[0]?.created_at ?? null;
      },
      async setStatus(userId: string, reflectionId: string, status: "applied" | "dismissed"): Promise<void> {
        await pool.query("UPDATE reflections SET status = $3 WHERE user_id = $1 AND id = $2", [userId, reflectionId, status]);
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
      async findEnabled(userId: string, query: string): Promise<SkillContext[]> {
        const result = await pool.query<{ id: string; name: string; trigger: string; content: string }>(
          "SELECT id, name, trigger, content FROM skills WHERE user_id = $1 AND status = 'enabled' ORDER BY updated_at DESC LIMIT 50",
          [userId],
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
      async findByIds(userId: string, skillIds: string[]): Promise<SkillContext[]> {
        if (skillIds.length === 0) return [];
        const result = await pool.query<{ id: string; name: string; trigger: string; content: string }>(
          "SELECT id, name, trigger, content FROM skills WHERE user_id = $1 AND id = ANY($2::uuid[]) AND status = 'enabled'",
          [userId, skillIds],
        );
        return result.rows;
      },
      async findEnabledByName(userId: string, name: string): Promise<{ id: string; name: string } | null> {
        const result = await pool.query<{ id: string; name: string }>(
          "SELECT id, name FROM skills WHERE user_id = $1 AND lower(name) = lower($2) AND status = 'enabled' LIMIT 1",
          [userId, name],
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
        userId: string,
        skillIds: string[],
        conversationId: string | null,
        triggeredBy: "auto" | "explicit" = "auto",
      ): Promise<void> {
        if (skillIds.length === 0) return;
        await pool.query(
          "UPDATE skills SET usage_count = usage_count + 1, last_used_at = now() WHERE user_id = $1 AND id = ANY($2::uuid[])",
          [userId, skillIds],
        );
        for (const skillId of skillIds) {
          await pool.query(
            "INSERT INTO skill_usage_logs (user_id, skill_id, conversation_id, triggered_by) VALUES ($1, $2, $3, $4)",
            [userId, skillId, conversationId, triggeredBy],
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
      async countSince(skillId: string, since: Date | null): Promise<number> {
        const result = since
          ? await pool.query<{ count: string }>(
              "SELECT count(*) AS count FROM skill_usage_logs WHERE skill_id = $1 AND created_at > $2",
              [skillId, since],
            )
          : await pool.query<{ count: string }>("SELECT count(*) AS count FROM skill_usage_logs WHERE skill_id = $1", [skillId]);
        return Number(result.rows[0]?.count ?? 0);
      },
      async recentConversationIds(skillId: string, limit: number): Promise<string[]> {
        const result = await pool.query<{ conversation_id: string }>(
          `SELECT DISTINCT ON (conversation_id) conversation_id
           FROM skill_usage_logs
           WHERE skill_id = $1 AND conversation_id IS NOT NULL
           ORDER BY conversation_id, created_at DESC
           LIMIT $2`,
          [skillId, limit],
        );
        return result.rows.map((row) => row.conversation_id);
      },
    },
    taskRuns: {
      async list(userId: string) {
        const result = await pool.query("SELECT * FROM task_runs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100", [userId]);
        return result.rows;
      },
      async create(input: {
        userId: string;
        conversationId?: string | null;
        kind: "sandbox" | "spreadsheet" | "presentation";
        inputSummary: string;
        metadata?: unknown;
      }): Promise<string> {
        const result = await pool.query(
          `INSERT INTO task_runs (user_id, conversation_id, kind, input_summary, metadata)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [input.userId, input.conversationId ?? null, input.kind, input.inputSummary, JSON.stringify(input.metadata ?? {})],
        );
        return result.rows[0].id;
      },
      async complete(taskRunId: string, outputSummary: string): Promise<void> {
        await pool.query("UPDATE task_runs SET status = 'succeeded', output_summary = $2, updated_at = now() WHERE id = $1", [
          taskRunId,
          outputSummary,
        ]);
      },
      async fail(taskRunId: string, error: string): Promise<void> {
        await pool.query("UPDATE task_runs SET status = 'failed', error = $2, updated_at = now() WHERE id = $1", [taskRunId, error]);
      },
    },
    taskArtifacts: {
      async create(input: {
        userId: string;
        taskRunId: string;
        fileName: string;
        mimeType: string;
        storagePath: string;
        metadata?: unknown;
      }): Promise<string> {
        const result = await pool.query(
          `INSERT INTO task_artifacts (user_id, task_run_id, file_name, mime_type, storage_path, metadata)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [
            input.userId,
            input.taskRunId,
            input.fileName,
            input.mimeType,
            input.storagePath,
            JSON.stringify(input.metadata ?? {}),
          ],
        );
        return result.rows[0].id;
      },
      async list(userId: string) {
        const result = await pool.query(
          "SELECT * FROM task_artifacts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200",
          [userId],
        );
        return result.rows;
      },
      async getForUser(userId: string, artifactId: string) {
        const result = await pool.query("SELECT * FROM task_artifacts WHERE user_id = $1 AND id = $2", [userId, artifactId]);
        return result.rows[0] ?? null;
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
      async listEnabled(userId: string): Promise<EnabledToolContext[]> {
        const result = await pool.query<{
          name: string;
          description: string;
          command: string;
          kind: "script" | "mcp";
          mcpToolName: string | null;
        }>(
          "SELECT name, description, command, kind, mcp_tool_name AS \"mcpToolName\" FROM tool_registrations WHERE user_id = $1 AND status = 'enabled' ORDER BY updated_at DESC LIMIT 20",
          [userId],
        );
        return result.rows;
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
      async get(userId: string) {
        await ensureSettings(pool, userId);
        const result = await pool.query("SELECT * FROM settings WHERE user_id = $1", [userId]);
        const row = result.rows[0];
        return {
          persona: row.persona ?? defaultSettings.persona,
          proactivity: row.proactivity ?? defaultSettings.proactivity,
          modelRouting: row.model_routing ?? defaultSettings.modelRouting,
          cadence: row.cadence ?? defaultSettings.cadence,
          search: row.search?.aggressiveness ? row.search : defaultSettings.search,
        };
      },
      async update(userId: string, settings: typeof defaultSettings): Promise<void> {
        await pool.query(
          `INSERT INTO settings (user_id, persona, proactivity, model_routing, cadence, search)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (user_id) DO UPDATE SET
             persona = EXCLUDED.persona,
             proactivity = EXCLUDED.proactivity,
             model_routing = EXCLUDED.model_routing,
             cadence = EXCLUDED.cadence,
             search = EXCLUDED.search,
             updated_at = now()`,
          [userId, settings.persona, settings.proactivity, settings.modelRouting, settings.cadence, settings.search],
        );
      },
    },
    personalData: {
      async export(userId: string) {
        const tables = [
          "projects",
          "conversations",
          "messages",
          "conversation_summaries",
          "memory_entries",
          "tool_call_logs",
          "proactive_tasks",
          "channel_identities",
          "channel_messages",
          "interjection_decisions",
          "reflections",
          "skills",
          "task_runs",
          "task_artifacts",
          "tool_registrations",
          "llm_usage_logs",
          "goals",
          "settings",
        ];
        const exported: Record<string, unknown[]> = {};
        for (const table of tables) {
          const result = await pool.query(`SELECT * FROM ${table} WHERE user_id = $1`, [userId]);
          exported[table] = result.rows;
        }
        return buildPersonalDataExport({ userId, exportedAt: new Date(), tables: exported });
      },
      async clear(userId: string): Promise<void> {
        const tables = [
          "goals",
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
          "messages",
          "conversations",
          "projects",
        ];
        for (const table of tables) {
          await pool.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
        }
        await ensureSettings(pool, userId);
        await pool.query(
          `UPDATE settings
           SET persona = $2, proactivity = $3, model_routing = $4, cadence = $5, search = $6, updated_at = now()
           WHERE user_id = $1`,
          [
            userId,
            defaultSettings.persona,
            defaultSettings.proactivity,
            defaultSettings.modelRouting,
            defaultSettings.cadence,
            defaultSettings.search,
          ],
        );
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
    name: String(row.name),
    description: String(row.description ?? ""),
    updatedAt: row.updated_at as Date,
  };
}

function mapMessage(row: Record<string, unknown>): DbMessage {
  return {
    id: String(row.id),
    userId: String(row.user_id),
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
    conversationId: String(row.conversation_id),
    kind: row.kind as DbProactiveTask["kind"],
    content: String(row.content),
    scheduledAt: row.scheduled_at as Date,
    status: String(row.status),
    metadata: isRecord(row.metadata) ? row.metadata : {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
