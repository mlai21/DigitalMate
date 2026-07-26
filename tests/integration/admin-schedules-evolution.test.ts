import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import EmbeddedPostgres from "embedded-postgres";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

import {
  createPostgresAdminEvolutionService,
} from "@/server/admin/views/evolution";
import {
  createPostgresAdminAgentResourcesService,
} from "@/server/admin/views/agent-resources";
import {
  createPostgresAdminSchedulesService,
  processDueScheduledJobs,
} from "@/server/admin/views/schedules";
import {
  serializeAgentVirtualFile,
} from "@/server/admin/workspace/files";
import {
  createPostgresAdminWorkspaceService,
} from "@/server/admin/workspace/service";
import {
  trackEmbeddedPostgresPool,
  type EmbeddedPostgresLifecycle,
} from "./embedded-postgres-lifecycle";

const scope = {
  userId: "10000000-0000-4000-8000-000000000001",
  agentId: "10000000-0000-4000-8000-000000000011",
};
const conversationId =
  "10000000-0000-4000-8000-000000000201";
const goalId =
  "10000000-0000-4000-8000-000000000301";
const skillId =
  "10000000-0000-4000-8000-000000000401";
const mcpToolId =
  "10000000-0000-4000-8000-000000000402";
const memoryId =
  "10000000-0000-4000-8000-000000000403";
const reflectionId =
  "10000000-0000-4000-8000-000000000404";

describe("admin schedules and evolution PostgreSQL mapping", () => {
  let database: EmbeddedPostgres;
  let databaseDirectory: string;
  let pool: Pool;
  let lifecycle: EmbeddedPostgresLifecycle;

  beforeAll(async () => {
    const port = await reservePort();
    databaseDirectory = await mkdtemp(
      path.join(os.tmpdir(), "digitalmate-admin-schedules-"),
    );
    database = new EmbeddedPostgres({
      databaseDir: databaseDirectory,
      port,
      user: "postgres",
      password: "digitalmate-test",
      persistent: false,
      onLog: () => undefined,
      onError: () => undefined,
    });
    await database.initialise();
    await database.start();
    pool = new Pool({
      connectionString:
        `postgresql://postgres:digitalmate-test@127.0.0.1:${port}/postgres`,
      options:
        "-c statement_timeout=15000 -c lock_timeout=5000",
    });
    lifecycle = trackEmbeddedPostgresPool(pool);
    await installVectorCompatibility(pool);
    await pool.query(
      adaptSchemaForEmbeddedPostgres(
        await readFile(
          path.join(process.cwd(), "src/server/db/schema.sql"),
          "utf8",
        ),
      ),
    );
    await seedScope(pool);
  }, 60_000);

  afterAll(async () => {
    await lifecycle.stop(database);
    await rm(databaseDirectory, {
      recursive: true,
      force: true,
    });
  });

  it("persists and dispatches one scheduled source exactly once", async () => {
    const schedules =
      createPostgresAdminSchedulesService(pool);
    const runAt = new Date("2026-07-28T01:00:00Z");
    const created = (await schedules.createJob(scope, {
      name: "喝水提醒",
      enabled: true,
      schedule: {
        type: "once",
        run_at: runAt.toISOString(),
        timezone: "UTC",
      },
      task_type: "text",
      text: "喝水",
      dispatch: {
        type: "channel",
        channel: "web",
        target: {
          user_id: scope.userId,
          session_id: conversationId,
        },
      },
      meta: { digitalmate_kind: "reminder" },
    })) as { id: string };

    const first = await processDueScheduledJobs({
      pool,
      scope,
      now: new Date("2026-07-28T01:00:01Z"),
    });
    const second = await processDueScheduledJobs({
      pool,
      scope,
      now: new Date("2026-07-28T01:00:02Z"),
    });
    const counts = await pool.query<{
      tasks: string;
      runs: string;
      enabled: boolean;
    }>(
      `SELECT
         (SELECT count(*) FROM proactive_tasks
          WHERE metadata->>'scheduledJobId' = $1::text) AS tasks,
         (SELECT count(*) FROM scheduled_job_runs
          WHERE job_id = $1::uuid) AS runs,
         (SELECT enabled FROM scheduled_jobs
          WHERE id = $1::uuid) AS enabled`,
      [created.id],
    );

    expect(first).toEqual({ dispatched: 1, failed: 0 });
    expect(second).toEqual({ dispatched: 0, failed: 0 });
    expect(counts.rows[0]).toEqual({
      tasks: "1",
      runs: "1",
      enabled: false,
    });
  });

  it("keeps Heartbeat off by default", async () => {
    const schedules =
      createPostgresAdminSchedulesService(pool);
    await expect(
      schedules.getHeartbeat(scope),
    ).resolves.toMatchObject({
      enabled: false,
      target: "inbox",
      authorization: null,
    });
  });

  it("confirms a goal atomically with its source-bound authorization and audit", async () => {
    const evolution =
      createPostgresAdminEvolutionService(pool);
    const operationId =
      "10000000-0000-4000-8000-000000000399";
    const first = await evolution.actOnGoal(
      scope,
      goalId,
      "confirm",
      { expectedRevision: 1, operationId },
    );
    const replay = await evolution.actOnGoal(
      scope,
      goalId,
      "confirm",
      { expectedRevision: 1, operationId },
    );
    const stored = await pool.query<{
      source_id: string;
      network_enabled: string;
      audits: string;
    }>(
      `SELECT
         contract->'authorization'->>'sourceId' AS source_id,
         contract->'authorization'->>'networkEnabled'
           AS network_enabled,
         (SELECT count(*) FROM admin_audit_logs
          WHERE resource_type = 'goal'
            AND resource_id = goals.id::text) AS audits
       FROM goals
       WHERE id = $1`,
      [goalId],
    );

    expect(first).toMatchObject({
      status: "confirmed",
      revision: 2,
      network_authorized: true,
    });
    expect(replay).toEqual(first);
    expect(stored.rows[0]).toEqual({
      source_id: goalId,
      network_enabled: "true",
      audits: "1",
    });
  });

  it("projects four virtual files and writes AGENT.md with revision control", async () => {
    const workspace =
      createPostgresAdminWorkspaceService(pool);
    const files = await workspace.list(scope);
    expect(files.map((file) => file.path)).toEqual([
      "/AGENT.md",
      "/PROACTIVITY.md",
      "/CHANNELS.md",
      "/RUNTIME.json",
    ]);
    const channels = await workspace.read(
      scope,
      "/CHANNELS.md",
    );
    expect(channels.content).toContain("telegram");
    expect(channels.content).not.toContain("APP_SECRET");
    expect(channels.content).not.toContain("storage_key");

    const operationId =
      "10000000-0000-4000-8000-000000000491";
    const content = serializeAgentVirtualFile({
      revision: 1,
      displayName: "小数",
      persona: {
        name: "小数",
        style: "温暖、克制",
        emojiHabit: "少量使用",
      },
    });
    const updated = await workspace.write(
      scope,
      "/AGENT.md",
      {
        content,
        expectedRevision: 1,
        operationId,
      },
    );
    expect(updated).toMatchObject({
      path: "/AGENT.md",
      revision: 2,
    });
    const replay = await workspace.write(
      scope,
      "/AGENT.md",
      {
        content,
        expectedRevision: 1,
        operationId,
      },
    );
    expect(replay).toEqual(updated);
    const workspaceAudit = await pool.query<{
      count: string;
    }>(
      `SELECT count(*) AS count
       FROM admin_audit_logs
       WHERE user_id = $1
         AND agent_id = $2
         AND action = 'agent_profile.update'
         AND confirmation_source->>'requestId' = $3`,
      [scope.userId, scope.agentId, operationId],
    );
    expect(workspaceAudit.rows[0]?.count).toBe("1");
    await expect(
      workspace.write(scope, "/AGENT.md", {
        content: serializeAgentVirtualFile({
          revision: 1,
          displayName: "过期写入",
          persona: {
            name: "过期写入",
            style: "stale",
            emojiHabit: "",
          },
        }),
        expectedRevision: 1,
        operationId:
          "10000000-0000-4000-8000-000000000492",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "revision_conflict",
    });
  });

  it("reads real Skills, Tools and MCP registrations without leaking commands", async () => {
    const resources =
      createPostgresAdminAgentResourcesService(pool);
    const createInput = {
      name: "会议纪要",
      content:
        "---\nname: 会议纪要\ndescription: 整理会议行动项\n---\n# 会议纪要",
      enabled: false,
    };
    const createMutation = {
      operationId:
        "10000000-0000-4000-8000-000000000496",
      confirmed: false,
    };
    const created = await resources.createSkill(
      scope,
      createInput,
      createMutation,
    );
    const createReplay = await resources.createSkill(
      scope,
      createInput,
      createMutation,
    );
    expect(created).toMatchObject({
      created: true,
      name: "会议纪要",
      enabled: false,
      approval_status: "pending",
    });
    expect(createReplay).toEqual(created);
    const proposalInput = {
      content:
        "# 会议纪要\n\n新增风险与负责人核对步骤。",
      expectedRevision: 1,
      operationId:
        "10000000-0000-4000-8000-000000000497",
      confirmed: true,
    };
    const proposed =
      await resources.proposeSkillRevision(
        scope,
        "会议纪要",
        proposalInput,
      );
    const proposalReplay =
      await resources.proposeSkillRevision(
        scope,
        "会议纪要",
        proposalInput,
      );
    expect(proposed).toMatchObject({
      success: true,
      mode: "edit",
      approval_status: "pending",
    });
    expect(proposalReplay).toEqual(proposed);
    const pendingRevision = await pool.query<{
      current_content: string;
      proposed_content: string;
      revision_count: string;
    }>(
      `SELECT skill.content AS current_content,
              revision.proposed_content,
              (SELECT count(*) FROM skill_revisions
               WHERE skill_id = skill.id) AS revision_count
       FROM skills AS skill
       JOIN skill_revisions AS revision
         ON revision.skill_id = skill.id
        AND revision.status = 'pending'
       WHERE skill.user_id = $1
         AND skill.name = '会议纪要'`,
      [scope.userId],
    );
    expect(pendingRevision.rows[0]).toEqual({
      current_content:
        "---\nname: 会议纪要\ndescription: 整理会议行动项\n---\n# 会议纪要",
      proposed_content:
        "# 会议纪要\n\n新增风险与负责人核对步骤。",
      revision_count: "1",
    });
    const skills = await resources.listSkills(scope);
    expect(skills).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: skillId,
        enabled: false,
        revision: 1,
      }),
      expect.objectContaining({
        name: "会议纪要",
        enabled: false,
      }),
    ]));
    const enabled = await resources.setSkillEnabled(
      scope,
      "周报",
      true,
      {
        expectedRevision: 1,
        operationId:
          "10000000-0000-4000-8000-000000000493",
        confirmed: true,
      },
    );
    expect(enabled).toMatchObject({
      enabled: true,
      revision: 2,
    });

    const tools = await resources.listTools(scope);
    const mcp = await resources.listMcpClients(scope);
    expect(mcp).toEqual([
      expect.objectContaining({
        key: mcpToolId,
        enabled: false,
        tools: ["search"],
      }),
    ]);
    expect(JSON.stringify({ tools, mcp })).not.toContain(
      "APP_SECRET",
    );
    expect(JSON.stringify({ tools, mcp })).not.toContain(
      "secret-runner",
    );
  });

  it("updates memory and applies only selected reflection suggestions with audit", async () => {
    const evolution =
      createPostgresAdminEvolutionService(pool);
    const memories = await evolution.listMemories(
      scope,
      { kind: "profile", limit: 100 },
    );
    expect(memories).toMatchObject({
      items: [
        expect.objectContaining({
          id: memoryId,
          kind: "profile",
        }),
      ],
    });
    expect(JSON.stringify(memories)).not.toContain("embedding");

    await evolution.updateMemory(
      scope,
      memoryId,
      {
        kind: "profile",
        content: "用户喜欢简洁、具体的周报",
        confidence: 0.95,
      },
      {
        operationId:
          "10000000-0000-4000-8000-000000000494",
        confirmed: true,
      },
    );
    const reflections =
      await evolution.listReflections(
        scope,
        { status: "recorded", limit: 100 },
      ) as {
        profile_revision: number;
        items: unknown[];
      };
    expect(reflections.items).toEqual([
      expect.objectContaining({
        id: reflectionId,
        suggestions: ["回复更紧凑", "多用感叹号"],
      }),
    ]);
    const applied = await evolution.actOnReflection(
      scope,
      reflectionId,
      "apply",
      {
        expectedRevision: reflections.profile_revision,
        operationId:
          "10000000-0000-4000-8000-000000000495",
        confirmed: true,
        suggestionIndexes: [0],
      },
    );
    expect(applied).toMatchObject({
      status: "applied",
      profile_revision:
        reflections.profile_revision + 1,
    });
    const stored = await pool.query<{
      style: string;
      reflection_status: string;
      audits: string;
    }>(
      `SELECT
         agent_settings.persona->>'style' AS style,
         (SELECT status FROM reflections WHERE id = $3)
           AS reflection_status,
         (SELECT count(*) FROM admin_audit_logs
          WHERE resource_id IN ($4, $5)) AS audits
       FROM agent_settings
       WHERE user_id = $1 AND agent_id = $2`,
      [
        scope.userId,
        scope.agentId,
        reflectionId,
        memoryId,
        reflectionId,
      ],
    );
    expect(stored.rows[0]).toEqual({
      style: expect.stringContaining("回复更紧凑"),
      reflection_status: "applied",
      audits: "2",
    });
    expect(stored.rows[0].style).not.toContain("多用感叹号");

    const deleteMutation = {
      operationId:
        "10000000-0000-4000-8000-000000000498",
      confirmed: true,
    };
    const deleted = await evolution.deleteMemory(
      scope,
      memoryId,
      deleteMutation,
    );
    const deleteReplay = await evolution.deleteMemory(
      scope,
      memoryId,
      deleteMutation,
    );
    expect(deleteReplay).toEqual(deleted);
    const deletion = await pool.query<{
      deleted: boolean;
      audits: string;
    }>(
      `SELECT deleted_at IS NOT NULL AS deleted,
              (SELECT count(*) FROM admin_audit_logs
               WHERE resource_type = 'memory'
                 AND resource_id = $1::text) AS audits
       FROM memory_entries
       WHERE id = $1::uuid`,
      [memoryId],
    );
    expect(deletion.rows[0]).toEqual({
      deleted: true,
      audits: "2",
    });
  });
});

async function seedScope(databasePool: Pool): Promise<void> {
  await databasePool.query(
    `INSERT INTO users (id, display_name)
     VALUES ($1, 'User A')`,
    [scope.userId],
  );
  await databasePool.query(
    `INSERT INTO settings (
       user_id, persona, proactivity, model_routing, cadence, search
     )
     VALUES ($1, '{}', '{}', '{}', '{}', '{}')`,
    [scope.userId],
  );
  await databasePool.query(
    `INSERT INTO digital_agents (
       id, user_id, slug, display_name, persona, is_default
     )
     VALUES ($1, $2, 'default-a', 'Agent A', '{}', true)`,
    [scope.agentId, scope.userId],
  );
  await databasePool.query(
    `INSERT INTO agent_settings (
       user_id, agent_id, persona, proactivity, cadence, search
     )
     VALUES (
       $1, $2, '{}',
       '{"quietStart":"23:00","quietEnd":"08:00","minIntervalMinutes":30,"maxPerHour":2,"maxPerDay":3}',
       '{}', '{}'
     )`,
    [scope.userId, scope.agentId],
  );
  const projectId =
    "10000000-0000-4000-8000-000000000101";
  await databasePool.query(
    `INSERT INTO projects (id, user_id, agent_id, name)
     VALUES ($1, $2, $3, 'Default')`,
    [projectId, scope.userId, scope.agentId],
  );
  await databasePool.query(
    `INSERT INTO conversations (
       id, user_id, agent_id, project_id, channel, title
     )
     VALUES ($1, $2, $3, $4, 'web', 'Default')`,
    [
      conversationId,
      scope.userId,
      scope.agentId,
      projectId,
    ],
  );
  await databasePool.query(
    `INSERT INTO goals (
       id, user_id, agent_id, title, contract
     )
     VALUES ($1, $2, $3, 'Goal A', $4::jsonb)`,
    [
      goalId,
      scope.userId,
      scope.agentId,
      JSON.stringify({
        objective: "持续整理资料",
        successCriteria: [
          {
            id: "sources",
            description: "至少 5 个来源",
            verification: "逐项核对",
          },
        ],
        cadence: { mode: "interval", intervalMinutes: 60 },
        scope: {
          allowedTools: ["web_search", "memory_search"],
          forbidden: [],
        },
        budget: { maxRounds: 10, maxTokens: 20_000 },
        stopConditions: {
          maxNoProgressRounds: 3,
          escalation: [],
        },
        deliverable: { format: "report" },
      }),
    ],
  );
  await databasePool.query(
    `INSERT INTO channel_connections (
       user_id, agent_id, channel_type, display_name,
       enabled, config, health_status
     )
     VALUES (
       $1, $2, 'telegram', 'Telegram',
       true, '{"token":"APP_SECRET","storage_key":"/private/file"}',
       'connected'
     )`,
    [scope.userId, scope.agentId],
  );
  await databasePool.query(
    `INSERT INTO skills (
       id, user_id, name, trigger, content, status, source
     )
     VALUES (
       $1, $2, '周报', '整理一周进展',
       '# Weekly', 'pending', 'manual'
     )`,
    [skillId, scope.userId],
  );
  await databasePool.query(
    `INSERT INTO tool_registrations (
       id, user_id, name, description, command,
       kind, mcp_tool_name, status, requires_confirmation
     )
     VALUES (
       $1, $2, 'notion_search', '查询笔记',
       'secret-runner --token APP_SECRET',
       'mcp', 'search', 'disabled', true
     )`,
    [mcpToolId, scope.userId],
  );
  const messageId =
    "10000000-0000-4000-8000-000000000405";
  await databasePool.query(
    `INSERT INTO messages (
       id, user_id, agent_id, conversation_id, role, content
     )
     VALUES ($1, $2, $3, $4, 'user', '偏好简洁周报')`,
    [
      messageId,
      scope.userId,
      scope.agentId,
      conversationId,
    ],
  );
  await databasePool.query(
    `INSERT INTO memory_entries (
       id, user_id, agent_id, kind, content,
       confidence, source_message_id
     )
     VALUES (
       $1, $2, $3, 'profile', '用户喜欢简洁的周报',
       0.9, $4
     )`,
    [memoryId, scope.userId, scope.agentId, messageId],
  );
  await databasePool.query(
    `INSERT INTO reflections (
       id, user_id, agent_id, positives, negatives,
       suggestions, source_window
     )
     VALUES (
       $1, $2, $3, ARRAY['解释清晰'], ARRAY['有时偏长'],
       ARRAY['回复更紧凑', '多用感叹号'],
       '{"raw_prompt":"must-not-leak"}'
     )`,
    [reflectionId, scope.userId, scope.agentId],
  );
}

function adaptSchemaForEmbeddedPostgres(source: string): string {
  return source
    .replace("CREATE EXTENSION IF NOT EXISTS vector;", "")
    .replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", "")
    .replaceAll("vector(1536)", "vector")
    .replace(
      /^CREATE INDEX IF NOT EXISTS idx_memory_entries_embedding.*$/m,
      "",
    );
}

async function installVectorCompatibility(
  databasePool: Pool,
): Promise<void> {
  await databasePool.query(`
    CREATE DOMAIN vector AS text;
    CREATE FUNCTION vector_cosine_distance(vector, vector)
      RETURNS double precision LANGUAGE sql IMMUTABLE
      AS $$ SELECT 1.0 $$;
    CREATE OPERATOR <=> (
      LEFTARG = vector,
      RIGHTARG = vector,
      PROCEDURE = vector_cosine_distance
    );
  `);
}

async function reservePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed_to_reserve_port");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) =>
      error ? reject(error) : resolve(),
    );
  });
  return port;
}
