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
import { getPool } from "@/server/db/client";

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
  updatedAt: Date;
};

export type DbMessage = {
  id: string;
  userId: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: Date;
};

export type DbMemoryEntry = RankableMemory & {
  kind: string;
  confidence: number;
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

export function createRepositories(pool: Pool = getPool()) {
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
      async list(conversationId: string): Promise<DbMessage[]> {
        const result = await pool.query(
          "SELECT * FROM messages WHERE conversation_id = $1 AND visible_to_user = true ORDER BY created_at ASC",
          [conversationId],
        );
        return result.rows.map(mapMessage);
      },
      async recentHistory(conversationId: string, limit = 12) {
        const result = await pool.query(
          `SELECT role, content FROM messages
           WHERE conversation_id = $1 AND visible_to_user = true AND role IN ('user', 'assistant')
           ORDER BY created_at DESC LIMIT $2`,
          [conversationId, limit],
        );
        return result.rows
          .reverse()
          .map((row: { role: "user" | "assistant"; content: string }) => ({ role: row.role, content: row.content }));
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
        for (const memory of memories) {
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
           (user_id, conversation_id, tool_name, input_summary, output_summary, status, duration_ms, error)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            input.userId,
            input.conversationId,
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
      async create(userId: string, draft: SkillDraft): Promise<void> {
        await pool.query(
          `INSERT INTO skills (user_id, name, trigger, content, status)
           VALUES ($1, $2, $3, $4, $5)`,
          [userId, draft.name, draft.trigger, draft.content, draft.status],
        );
      },
      async list(userId: string) {
        const result = await pool.query("SELECT * FROM skills WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100", [userId]);
        return result.rows;
      },
      async findEnabled(userId: string, query: string): Promise<SkillContext[]> {
        const result = await pool.query<{ name: string; trigger: string; content: string }>(
          "SELECT name, trigger, content FROM skills WHERE user_id = $1 AND status = 'enabled' ORDER BY updated_at DESC LIMIT 50",
          [userId],
        );
        return result.rows
          .map((row) => ({ ...row, score: scoreSkill(query, row) }))
          .sort((left, right) => right.score - left.score)
          .slice(0, 6)
          .map(({ name, trigger, content }) => ({ name, trigger, content }));
      },
      async setStatus(userId: string, skillId: string, status: "enabled" | "disabled" | "rejected"): Promise<void> {
        await pool.query("UPDATE skills SET status = $3, updated_at = now() WHERE user_id = $1 AND id = $2", [
          userId,
          skillId,
          status,
        ]);
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
        };
      },
      async update(userId: string, settings: typeof defaultSettings): Promise<void> {
        await pool.query(
          `INSERT INTO settings (user_id, persona, proactivity, model_routing, cadence)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (user_id) DO UPDATE SET
             persona = EXCLUDED.persona,
             proactivity = EXCLUDED.proactivity,
             model_routing = EXCLUDED.model_routing,
             cadence = EXCLUDED.cadence,
             updated_at = now()`,
          [userId, settings.persona, settings.proactivity, settings.modelRouting, settings.cadence],
        );
      },
    },
    personalData: {
      async export(userId: string) {
        const tables = [
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
        ];
        for (const table of tables) {
          await pool.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
        }
        await ensureSettings(pool, userId);
        await pool.query(
          `UPDATE settings
           SET persona = $2, proactivity = $3, model_routing = $4, cadence = $5, updated_at = now()
           WHERE user_id = $1`,
          [
            userId,
            defaultSettings.persona,
            defaultSettings.proactivity,
            defaultSettings.modelRouting,
            defaultSettings.cadence,
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
    `INSERT INTO settings (user_id, persona, proactivity, model_routing, cadence)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, defaultSettings.persona, defaultSettings.proactivity, defaultSettings.modelRouting, defaultSettings.cadence],
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
