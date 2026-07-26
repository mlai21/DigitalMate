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
  createPostgresAdminSchedulesService,
  processDueScheduledJobs,
} from "@/server/admin/views/schedules";
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
