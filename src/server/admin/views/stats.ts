import packageJson from "../../../../package.json";
import type { Pool } from "pg";

import type { AgentScope } from "@/server/agents/types";

export type AdminDateRange = Readonly<{
  startDate: string;
  endDate: string;
}>;

export type AdminTokenUsageFilters = AdminDateRange &
  Readonly<{
    model?: string;
    provider?: string;
  }>;

export type AdminOperationsService = Readonly<{
  getAgentStats(
    scope: AgentScope,
    range: AdminDateRange,
    signal?: AbortSignal,
  ): Promise<unknown>;
  getTokenUsage(
    scope: AgentScope,
    filters: AdminTokenUsageFilters,
    signal?: AbortSignal,
  ): Promise<unknown>;
  getTokenUsageDetails(
    scope: AgentScope,
    filters: AdminTokenUsageFilters,
    signal?: AbortSignal,
  ): Promise<unknown[]>;
  getEnvironment(
    scope: AgentScope,
    signal?: AbortSignal,
  ): Promise<unknown[]>;
  getAgentHealth(
    scope: AgentScope,
    signal?: AbortSignal,
  ): Promise<unknown>;
  getDebugLogs(
    scope: AgentScope,
    lines: number,
    signal?: AbortSignal,
  ): Promise<unknown>;
  getVoiceOverview(
    scope: AgentScope,
    signal?: AbortSignal,
  ): Promise<unknown>;
}>;

type MessageDailyRow = Readonly<{
  date: string;
  chats: string;
  user_messages: string;
  assistant_messages: string;
  total_messages: string;
}>;

type UsageDailyRow = Readonly<{
  date: string;
  purpose: string;
  model: string;
  prompt_tokens: string;
  completion_tokens: string;
  call_count: string;
}>;

type ToolDailyRow = Readonly<{
  date: string;
  tool_calls: string;
}>;

type DebugEvent = Readonly<{
  kind: string;
  status: string;
  code: string | null;
  action?: string;
  resource_type?: string;
  created_at: string;
}>;

export function createPostgresAdminOperationsService(
  pool: Pool,
): AdminOperationsService {
  return {
    async getAgentStats(scope, range, signal) {
      signal?.throwIfAborted();
      const timezone = await readTimezone(pool, scope.userId);
      const [
        messageDaily,
        usageDaily,
        toolDaily,
        totals,
        channels,
        extra,
      ] = await Promise.all([
        pool.query<MessageDailyRow>(
          `SELECT
             to_char(
               messages.created_at AT TIME ZONE $5,
               'YYYY-MM-DD'
             ) AS date,
             count(DISTINCT messages.conversation_id)::text
               AS chats,
             count(*) FILTER (
               WHERE messages.role = 'user'
             )::text AS user_messages,
             count(*) FILTER (
               WHERE messages.role = 'assistant'
             )::text AS assistant_messages,
             count(*)::text AS total_messages
           FROM messages
           WHERE messages.user_id = $1
             AND messages.agent_id = $2
             AND messages.visible_to_user = true
             AND messages.role IN ('user', 'assistant')
             AND messages.created_at >=
               ($3::date::timestamp AT TIME ZONE $5)
             AND messages.created_at <
               (
                 ($4::date + interval '1 day')
                   AT TIME ZONE $5
               )
           GROUP BY 1
           ORDER BY 1`,
          [
            scope.userId,
            scope.agentId,
            range.startDate,
            range.endDate,
            timezone,
          ],
        ),
        queryUsageDaily(
          pool,
          scope,
          range,
          timezone,
          false,
        ),
        pool.query<ToolDailyRow>(
          `SELECT
             to_char(
               created_at AT TIME ZONE $5,
               'YYYY-MM-DD'
             ) AS date,
             count(*)::text AS tool_calls
           FROM tool_call_logs
           WHERE user_id = $1
             AND agent_id = $2
             AND created_at >=
               ($3::date::timestamp AT TIME ZONE $5)
             AND created_at <
               (
                 ($4::date + interval '1 day')
                   AT TIME ZONE $5
               )
           GROUP BY 1
           ORDER BY 1`,
          [
            scope.userId,
            scope.agentId,
            range.startDate,
            range.endDate,
            timezone,
          ],
        ),
        pool.query<{
          sessions: string;
          user_messages: string;
          assistant_messages: string;
          total_messages: string;
        }>(
          `SELECT
             count(DISTINCT conversation_id)::text AS sessions,
             count(*) FILTER (
               WHERE role = 'user'
             )::text AS user_messages,
             count(*) FILTER (
               WHERE role = 'assistant'
             )::text AS assistant_messages,
             count(*)::text AS total_messages
           FROM messages
           WHERE user_id = $1
             AND agent_id = $2
             AND visible_to_user = true
             AND role IN ('user', 'assistant')
             AND created_at >=
               ($3::date::timestamp AT TIME ZONE $5)
             AND created_at <
               (
                 ($4::date + interval '1 day')
                   AT TIME ZONE $5
               )`,
          [
            scope.userId,
            scope.agentId,
            range.startDate,
            range.endDate,
            timezone,
          ],
        ),
        pool.query<{
          channel: string;
          session_count: string;
          user_messages: string;
          assistant_messages: string;
          total_messages: string;
        }>(
          `SELECT conversations.channel,
                  count(DISTINCT messages.conversation_id)::text
                    AS session_count,
                  count(*) FILTER (
                    WHERE messages.role = 'user'
                  )::text AS user_messages,
                  count(*) FILTER (
                    WHERE messages.role = 'assistant'
                  )::text AS assistant_messages,
                  count(*)::text AS total_messages
           FROM messages
           JOIN conversations
             ON conversations.user_id = messages.user_id
            AND conversations.agent_id = messages.agent_id
            AND conversations.id = messages.conversation_id
           WHERE messages.user_id = $1
             AND messages.agent_id = $2
             AND messages.visible_to_user = true
             AND messages.role IN ('user', 'assistant')
             AND messages.created_at >=
               ($3::date::timestamp AT TIME ZONE $5)
             AND messages.created_at <
               (
                 ($4::date + interval '1 day')
                   AT TIME ZONE $5
               )
           GROUP BY conversations.channel
           ORDER BY conversations.channel`,
          [
            scope.userId,
            scope.agentId,
            range.startDate,
            range.endDate,
            timezone,
          ],
        ),
        pool.query<{
          memories: string;
          tasks: string;
          channels: string;
          errors: string;
        }>(
          `SELECT
             (SELECT count(*) FROM memory_entries
              WHERE user_id = $1 AND agent_id = $2
                AND deleted_at IS NULL
                AND (expires_at IS NULL OR expires_at > now())
             )::text AS memories,
             (SELECT count(*) FROM task_runs
              WHERE user_id = $1 AND agent_id = $2
                AND created_at >=
                  ($3::date::timestamp AT TIME ZONE $5)
                AND created_at <
                  (
                    ($4::date + interval '1 day')
                      AT TIME ZONE $5
                  )
             )::text AS tasks,
             (SELECT count(*) FROM channel_connections
              WHERE user_id = $1 AND agent_id = $2
                AND deleted_at IS NULL
             )::text AS channels,
             (
               (SELECT count(*) FROM tool_call_logs
                WHERE user_id = $1 AND agent_id = $2
                  AND status = 'error'
                  AND created_at >=
                    ($3::date::timestamp AT TIME ZONE $5)
                  AND created_at <
                    (
                      ($4::date + interval '1 day')
                        AT TIME ZONE $5
                    ))
               +
               (SELECT count(*) FROM channel_inbound_events
                WHERE user_id = $1 AND agent_id = $2
                  AND status = 'failed'
                  AND created_at >=
                    ($3::date::timestamp AT TIME ZONE $5)
                  AND created_at <
                    (
                      ($4::date + interval '1 day')
                        AT TIME ZONE $5
                    ))
               +
               (SELECT count(*) FROM channel_deliveries
                WHERE user_id = $1 AND agent_id = $2
                  AND status = 'dead_letter'
                  AND created_at >=
                    ($3::date::timestamp AT TIME ZONE $5)
                  AND created_at <
                    (
                      ($4::date + interval '1 day')
                        AT TIME ZONE $5
                    ))
             )::text AS errors`,
          [
            scope.userId,
            scope.agentId,
            range.startDate,
            range.endDate,
            timezone,
          ],
        ),
      ]);
      signal?.throwIfAborted();

      const usageRows = usageDaily.rows;
      const daily = new Map<
        string,
        {
          date: string;
          chats: number;
          active_sessions: number;
          user_messages: number;
          assistant_messages: number;
          total_messages: number;
          prompt_tokens: number;
          completion_tokens: number;
          llm_calls: number;
          tool_calls: number;
        }
      >();
      const ensureDay = (date: string) => {
        const existing = daily.get(date);
        if (existing) return existing;
        const value = {
          date,
          chats: 0,
          active_sessions: 0,
          user_messages: 0,
          assistant_messages: 0,
          total_messages: 0,
          prompt_tokens: 0,
          completion_tokens: 0,
          llm_calls: 0,
          tool_calls: 0,
        };
        daily.set(date, value);
        return value;
      };
      for (const row of messageDaily.rows) {
        const day = ensureDay(row.date);
        day.chats = integer(row.chats);
        day.active_sessions = integer(row.chats);
        day.user_messages = integer(row.user_messages);
        day.assistant_messages = integer(
          row.assistant_messages,
        );
        day.total_messages = integer(row.total_messages);
      }
      for (const row of usageRows) {
        const day = ensureDay(row.date);
        day.prompt_tokens += integer(row.prompt_tokens);
        day.completion_tokens += integer(
          row.completion_tokens,
        );
        day.llm_calls += integer(row.call_count);
      }
      for (const row of toolDaily.rows) {
        ensureDay(row.date).tool_calls =
          integer(row.tool_calls);
      }
      const totalUsage = summarizeUsageRows(usageRows);
      const totalTools = toolDaily.rows.reduce(
        (sum, row) => sum + integer(row.tool_calls),
        0,
      );
      const totalRow = totals.rows[0];
      const extraRow = extra.rows[0];
      return {
        total_active_sessions: integer(
          totalRow?.sessions,
        ),
        total_messages: integer(totalRow?.total_messages),
        total_user_messages: integer(
          totalRow?.user_messages,
        ),
        total_assistant_messages: integer(
          totalRow?.assistant_messages,
        ),
        total_prompt_tokens: totalUsage.promptTokens,
        total_completion_tokens:
          totalUsage.completionTokens,
        total_llm_calls: totalUsage.calls,
        total_tool_calls: totalTools,
        by_date: [...daily.values()].sort((left, right) =>
          left.date.localeCompare(right.date),
        ),
        channel_stats: channels.rows.map((row) => ({
          channel: row.channel,
          session_count: integer(row.session_count),
          user_messages: integer(row.user_messages),
          assistant_messages: integer(
            row.assistant_messages,
          ),
          total_messages: integer(row.total_messages),
        })),
        start_date: range.startDate,
        end_date: range.endDate,
        digitalmate: {
          memories: integer(extraRow?.memories),
          tasks: integer(extraRow?.tasks),
          channels: integer(extraRow?.channels),
          errors: integer(extraRow?.errors),
        },
      };
    },

    async getTokenUsage(scope, filters, signal) {
      signal?.throwIfAborted();
      const timezone = await readTimezone(pool, scope.userId);
      const [agentRows, userRows] = await Promise.all([
        queryUsageDaily(
          pool,
          scope,
          filters,
          timezone,
          false,
        ),
        queryUsageDaily(
          pool,
          scope,
          filters,
          timezone,
          true,
        ),
      ]);
      signal?.throwIfAborted();
      const rows = filterUsageRows(agentRows.rows, filters);
      return {
        ...usageSummary(rows),
        scope: "agent",
        purpose_breakdown: purposeBreakdown(rows),
        user_total: usageSummary(
          filterUsageRows(userRows.rows, filters),
        ),
      };
    },

    async getTokenUsageDetails(
      scope,
      filters,
      signal,
    ) {
      signal?.throwIfAborted();
      const timezone = await readTimezone(pool, scope.userId);
      const result = await queryUsageDaily(
        pool,
        scope,
        filters,
        timezone,
        false,
      );
      signal?.throwIfAborted();
      return filterUsageRows(result.rows, filters).map(
        (row) => ({
          date: row.date,
          provider_id: providerForModel(row.model),
          model: row.model,
          purpose: row.purpose,
          prompt_tokens: integer(row.prompt_tokens),
          completion_tokens: integer(
            row.completion_tokens,
          ),
          call_count: integer(row.call_count),
        }),
      );
    },

    async getEnvironment(scope, signal) {
      signal?.throwIfAborted();
      const nodes = await pool.query<{
        display_name: string;
        status: string;
        client_version: string | null;
      }>(
        `SELECT display_name, status, client_version
         FROM channel_runtime_nodes
         WHERE user_id = $1 AND agent_id = $2
         ORDER BY display_name, id`,
        [scope.userId, scope.agentId],
      );
      signal?.throwIfAborted();
      return [
        {
          key: "web",
          value: `healthy · ${packageJson.version}`,
          readonly: true,
        },
        {
          key: "agent",
          value: `healthy · ${packageJson.version}`,
          readonly: true,
        },
        ...nodes.rows.map((node, index) => ({
          key: `channel-node-${index + 1}`,
          value: `${node.status} · ${
            node.client_version ?? "version unavailable"
          }`,
          label: node.display_name,
          readonly: true,
        })),
      ];
    },

    async getAgentHealth(scope, signal) {
      signal?.throwIfAborted();
      const result = await pool.query<{
        active: boolean;
        connected_nodes: string;
        degraded_channels: string;
      }>(
        `SELECT
           EXISTS (
             SELECT 1 FROM digital_agents
             WHERE user_id = $1 AND id = $2
               AND status = 'active'
           ) AS active,
           (SELECT count(*) FROM channel_runtime_nodes
            WHERE user_id = $1 AND agent_id = $2
              AND status = 'connected'
           )::text AS connected_nodes,
           (SELECT count(*) FROM channel_connections
            WHERE user_id = $1 AND agent_id = $2
              AND deleted_at IS NULL
              AND health_status IN ('blocked', 'degraded')
           )::text AS degraded_channels`,
        [scope.userId, scope.agentId],
      );
      const row = result.rows[0];
      if (!row?.active) {
        return {
          status: "unavailable",
          version: packageJson.version,
          services: {
            web: "healthy",
            agent: "inactive",
            channel_nodes: "unknown",
          },
        };
      }
      const degraded = integer(row.degraded_channels);
      return {
        status: degraded > 0 ? "degraded" : "healthy",
        version: packageJson.version,
        services: {
          web: "healthy",
          agent: "healthy",
          channel_nodes:
            integer(row.connected_nodes) > 0
              ? "connected"
              : "not_connected",
        },
        degraded_channels: degraded,
      };
    },

    async getDebugLogs(scope, lines, signal) {
      signal?.throwIfAborted();
      const perSource = Math.max(
        10,
        Math.min(250, Math.ceil(lines / 4)),
      );
      const [audits, tools, events, deliveries] =
        await Promise.all([
          pool.query(
            `SELECT action, resource_type, status,
                    error_code AS code, created_at
             FROM admin_audit_logs
             WHERE user_id = $1
               AND agent_id = $2
               AND created_at >=
                 now() - interval '30 days'
             ORDER BY created_at DESC
             LIMIT $3`,
            [scope.userId, scope.agentId, perSource],
          ),
          pool.query(
            `SELECT status,
                    CASE
                      WHEN error IS NULL THEN NULL
                      ELSE 'tool_error'
                    END AS code,
                    created_at
             FROM tool_call_logs
             WHERE user_id = $1
               AND agent_id = $2
               AND created_at >=
                 now() - interval '30 days'
             ORDER BY created_at DESC
             LIMIT $3`,
            [scope.userId, scope.agentId, perSource],
          ),
          pool.query(
            `SELECT status, failure_code AS code,
                    created_at
             FROM channel_inbound_events
             WHERE user_id = $1
               AND agent_id = $2
               AND created_at >=
                 now() - interval '30 days'
             ORDER BY created_at DESC
             LIMIT $3`,
            [scope.userId, scope.agentId, perSource],
          ),
          pool.query(
            `SELECT status, last_error_code AS code,
                    created_at
             FROM channel_deliveries
             WHERE user_id = $1
               AND agent_id = $2
               AND created_at >=
                 now() - interval '30 days'
             ORDER BY created_at DESC
             LIMIT $3`,
            [scope.userId, scope.agentId, perSource],
          ),
        ]);
      signal?.throwIfAborted();
      const projected: DebugEvent[] = [
        ...audits.rows.map((row) =>
          debugEvent("audit", row),
        ),
        ...tools.rows.map((row) =>
          debugEvent("tool", row),
        ),
        ...events.rows.map((row) =>
          debugEvent("inbound", row),
        ),
        ...deliveries.rows.map((row) =>
          debugEvent("delivery", row),
        ),
      ]
        .sort((left, right) =>
          right.created_at.localeCompare(left.created_at),
        )
        .slice(0, lines);
      const content = projected
        .map((event) => JSON.stringify(event))
        .join("\n");
      const updatedAt = projected[0]
        ? Math.floor(
            new Date(projected[0].created_at).getTime() /
              1_000,
          )
        : null;
      return {
        path: "database://diagnostics",
        exists: projected.length > 0,
        lines: projected.length,
        updated_at: updatedAt,
        size: Buffer.byteLength(content, "utf8"),
        content,
        next_cursor:
          projected.at(-1)?.created_at ?? null,
        retention_days: 30,
      };
    },

    async getVoiceOverview(scope, signal) {
      signal?.throwIfAborted();
      const [connections, secrets] = await Promise.all([
        pool.query<{
          id: string;
          channel_type: "voice" | "sip";
          enabled: boolean;
          revision: number;
          health_status: string;
          config: Record<string, unknown>;
        }>(
          `SELECT id, channel_type, enabled, revision,
                  health_status, config
           FROM channel_connections
           WHERE user_id = $1
             AND agent_id = $2
             AND channel_type IN ('voice', 'sip')
             AND deleted_at IS NULL
           ORDER BY channel_type, id`,
          [scope.userId, scope.agentId],
        ),
        pool.query<{
          connection_id: string;
          field_name: string;
        }>(
          `SELECT secret.connection_id,
                  secret.field_name
           FROM channel_secrets AS secret
           JOIN channel_connections AS connection
             ON connection.id = secret.connection_id
           WHERE connection.user_id = $1
             AND connection.agent_id = $2
             AND connection.channel_type IN (
               'voice', 'sip'
             )
             AND connection.deleted_at IS NULL
           ORDER BY secret.connection_id,
                    secret.field_name`,
          [scope.userId, scope.agentId],
        ),
      ]);
      const secretsByConnection = new Map<
        string,
        Record<string, { configured: true }>
      >();
      for (const secret of secrets.rows) {
        const current =
          secretsByConnection.get(secret.connection_id) ??
          {};
        current[secret.field_name] = { configured: true };
        secretsByConnection.set(
          secret.connection_id,
          current,
        );
      }
      signal?.throwIfAborted();
      return {
        connections: connections.rows.map((row) => ({
          id: row.id,
          type: row.channel_type,
          enabled: row.enabled,
          health: row.health_status,
          revision: Number(row.revision),
          ...safeVoiceConfig(row.config),
          secrets:
            secretsByConnection.get(row.id) ?? {},
          mutation_endpoint:
            `/channels/${row.channel_type}`,
        })),
        chat_audio_transcription: {
          enabled: false,
          reason: "audio_attachment_not_supported",
        },
      };
    },
  };
}

async function queryUsageDaily(
  pool: Pool,
  scope: AgentScope,
  range: AdminDateRange,
  timezone: string,
  userWide: boolean,
) {
  return pool.query<UsageDailyRow>(
    `SELECT
       to_char(
         created_at AT TIME ZONE $5,
         'YYYY-MM-DD'
       ) AS date,
       purpose,
       model,
       sum(input_tokens)::text AS prompt_tokens,
       sum(output_tokens)::text AS completion_tokens,
       count(*)::text AS call_count
     FROM llm_usage_logs
     WHERE user_id = $1
       AND ($6::boolean OR agent_id = $2)
       AND created_at >=
         ($3::date::timestamp AT TIME ZONE $5)
       AND created_at <
         (
           ($4::date + interval '1 day')
             AT TIME ZONE $5
         )
     GROUP BY 1, purpose, model
     ORDER BY 1, purpose, model`,
    [
      scope.userId,
      scope.agentId,
      range.startDate,
      range.endDate,
      timezone,
      userWide,
    ],
  );
}

function filterUsageRows(
  rows: readonly UsageDailyRow[],
  filters: AdminTokenUsageFilters,
): UsageDailyRow[] {
  return rows.filter(
    (row) =>
      (!filters.model || row.model === filters.model) &&
      (!filters.provider ||
        providerForModel(row.model) === filters.provider),
  );
}

function usageSummary(rows: readonly UsageDailyRow[]) {
  const totals = summarizeUsageRows(rows);
  const byModel: Record<string, unknown> = {};
  const byDate: Record<string, unknown> = {};
  for (const row of rows) {
    const provider = providerForModel(row.model);
    const modelKey =
      `${provider}/${row.model}:${row.purpose}`;
    const model = (byModel[modelKey] as {
      provider_id: string;
      model: string;
      purpose: string;
      prompt_tokens: number;
      completion_tokens: number;
      call_count: number;
    } | undefined) ?? {
      provider_id: provider,
      model: row.model,
      purpose: row.purpose,
      prompt_tokens: 0,
      completion_tokens: 0,
      call_count: 0,
    };
    model.prompt_tokens += integer(row.prompt_tokens);
    model.completion_tokens += integer(
      row.completion_tokens,
    );
    model.call_count += integer(row.call_count);
    byModel[modelKey] = model;

    const date = (byDate[row.date] as {
      prompt_tokens: number;
      completion_tokens: number;
      call_count: number;
    } | undefined) ?? {
      prompt_tokens: 0,
      completion_tokens: 0,
      call_count: 0,
    };
    date.prompt_tokens += integer(row.prompt_tokens);
    date.completion_tokens += integer(
      row.completion_tokens,
    );
    date.call_count += integer(row.call_count);
    byDate[row.date] = date;
  }
  return {
    total_prompt_tokens: totals.promptTokens,
    total_completion_tokens: totals.completionTokens,
    total_calls: totals.calls,
    by_model: byModel,
    by_date: byDate,
  };
}

function purposeBreakdown(
  rows: readonly UsageDailyRow[],
) {
  const result: Record<
    string,
    {
      prompt_tokens: number;
      completion_tokens: number;
      call_count: number;
    }
  > = {};
  for (const row of rows) {
    const current = result[row.purpose] ?? {
      prompt_tokens: 0,
      completion_tokens: 0,
      call_count: 0,
    };
    current.prompt_tokens += integer(row.prompt_tokens);
    current.completion_tokens += integer(
      row.completion_tokens,
    );
    current.call_count += integer(row.call_count);
    result[row.purpose] = current;
  }
  return result;
}

function summarizeUsageRows(
  rows: readonly UsageDailyRow[],
) {
  return rows.reduce(
    (summary, row) => ({
      promptTokens:
        summary.promptTokens + integer(row.prompt_tokens),
      completionTokens:
        summary.completionTokens +
        integer(row.completion_tokens),
      calls: summary.calls + integer(row.call_count),
    }),
    {
      promptTokens: 0,
      completionTokens: 0,
      calls: 0,
    },
  );
}

function providerForModel(model: string): string {
  if (/claude/iu.test(model)) return "anthropic";
  if (/gemini/iu.test(model)) return "google";
  return "openai";
}

async function readTimezone(
  pool: Pool,
  userId: string,
): Promise<string> {
  const result = await pool.query<{ timezone: string }>(
    `SELECT timezone FROM settings WHERE user_id = $1`,
    [userId],
  );
  return result.rows[0]?.timezone ?? "Asia/Shanghai";
}

function debugEvent(
  kind: string,
  row: Record<string, unknown>,
): DebugEvent {
  return {
    kind,
    status: String(row.status),
    code:
      typeof row.code === "string"
        ? safeCode(row.code)
        : null,
    ...(typeof row.action === "string"
      ? { action: safeCode(row.action) }
      : {}),
    ...(typeof row.resource_type === "string"
      ? {
          resource_type: safeCode(row.resource_type),
        }
      : {}),
    created_at: new Date(
      row.created_at as Date | string,
    ).toISOString(),
  };
}

function safeCode(value: string): string {
  return value
    .replace(/[^\p{L}\p{N}._:-]+/gu, "_")
    .slice(0, 160);
}

function safeVoiceConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of [
    "sip_mode",
    "sip_transport",
    "tts_provider",
    "tts_voice",
    "stt_provider",
    "language",
    "call_timeout",
    "max_concurrent_calls",
  ]) {
    const value = config[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      result[key] = value;
    }
  }
  return result;
}

function integer(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : 0;
}
