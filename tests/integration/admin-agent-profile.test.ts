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
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { createAdminAgentProfileService } from "@/server/admin/agent-profile";
import {
  trackEmbeddedPostgresPool,
  type EmbeddedPostgresLifecycle,
} from "./embedded-postgres-lifecycle";

const USER_A = "10000000-0000-4000-8000-000000000001";
const USER_B = "20000000-0000-4000-8000-000000000002";
const AGENT_A = "10000000-0000-4000-8000-000000000011";
const AGENT_A2 = "10000000-0000-4000-8000-000000000012";
const AGENT_B = "20000000-0000-4000-8000-000000000011";

describe("admin default-agent profile transaction", () => {
  let embeddedPostgres: EmbeddedPostgres;
  let databaseDirectory: string;
  let primaryPool: Pool;
  let secondaryPool: Pool;
  let databaseLifecycle: EmbeddedPostgresLifecycle;

  beforeAll(async () => {
    const port = await reservePort();
    databaseDirectory = await mkdtemp(
      path.join(os.tmpdir(), "digitalmate-admin-agent-profile-"),
    );
    embeddedPostgres = new EmbeddedPostgres({
      databaseDir: databaseDirectory,
      port,
      user: "postgres",
      password: "digitalmate-test",
      persistent: false,
      onLog: () => undefined,
      onError: () => undefined,
    });
    await embeddedPostgres.initialise();
    await embeddedPostgres.start();
    const connectionString =
      `postgresql://postgres:digitalmate-test@127.0.0.1:${port}/postgres`;
    const poolOptions = {
      connectionString,
      options: "-c statement_timeout=15000 -c lock_timeout=5000",
    };
    primaryPool = new Pool(poolOptions);
    secondaryPool = new Pool(poolOptions);
    databaseLifecycle = trackEmbeddedPostgresPool(primaryPool);
    await installVectorCompatibility(primaryPool);
    await primaryPool.query(
      adaptSchemaForEmbeddedPostgres(
        await readFile(
          path.join(process.cwd(), "src/server/db/schema.sql"),
          "utf8",
        ),
      ),
    );
  }, 60_000);

  beforeEach(async () => {
    await primaryPool.query(`
      DROP TRIGGER IF EXISTS fail_agent_audit_insert ON admin_audit_logs;
      DROP FUNCTION IF EXISTS fail_agent_audit_insert();
      TRUNCATE admin_audit_logs, agent_settings, digital_agents,
        settings, users CASCADE;
    `);
    await primaryPool.query(
      `INSERT INTO users (id, display_name)
       VALUES ($1, 'User A'), ($2, 'User B')`,
      [USER_A, USER_B],
    );
    await primaryPool.query(
      `INSERT INTO settings (
         user_id, persona, proactivity, model_routing, cadence, search
       )
       VALUES
         ($1, '{}', '{}', '{}', '{}', '{}'),
         ($2, '{}', '{}', '{}', '{}', '{}')`,
      [USER_A, USER_B],
    );
    await primaryPool.query(
      `INSERT INTO digital_agents (
         id, user_id, slug, display_name, persona, is_default
       )
       VALUES
         ($1, $2, 'default-a', 'Agent A',
          '{"name":"Agent A","style":"old-style","emojiHabit":"rare"}', true),
         ($3, $2, 'second-a', 'Agent A2', '{}', false),
         ($4, $5, 'default-b', 'Agent B', '{}', true)`,
      [AGENT_A, USER_A, AGENT_A2, AGENT_B, USER_B],
    );
    await primaryPool.query(
      `INSERT INTO agent_settings (
         user_id, agent_id, persona, proactivity, cadence, search
       )
       VALUES
         ($1, $2,
          '{"name":"Agent A","style":"old-style","emojiHabit":"rare"}',
          '{"quietStart":"23:00","quietEnd":"08:00","minIntervalMinutes":30,"maxPerHour":2,"maxPerDay":3}',
          '{"responseDelayMs":480,"segmentDelayMs":240,"maxSegments":5}',
          '{"aggressiveness":"conservative"}'),
         ($1, $3, '{}', '{}', '{}', '{}'),
         ($4, $5, '{}', '{}', '{}', '{}')`,
      [USER_A, AGENT_A, AGENT_A2, USER_B, AGENT_B],
    );
  });

  afterAll(async () => {
    await secondaryPool?.end();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await databaseLifecycle?.stop(embeddedPostgres);
    if (databaseDirectory) {
      await rm(databaseDirectory, { recursive: true, force: true });
    }
  });

  it("updates display name, persona, agent settings and safe audit atomically", async () => {
    const result = await createAdminAgentProfileService(
      primaryPool,
    ).update(updateInput());

    expect(result.revision).toBe(2);
    const stored = await primaryPool.query<{
      display_name: string;
      digital_persona: Record<string, unknown>;
      settings_persona: Record<string, unknown>;
      proactivity: Record<string, unknown>;
      cadence: Record<string, unknown>;
      search: Record<string, unknown>;
      revision: number;
    }>(
      `SELECT digital_agents.display_name,
              digital_agents.persona AS digital_persona,
              agent_settings.persona AS settings_persona,
              agent_settings.proactivity,
              agent_settings.cadence,
              agent_settings.search,
              agent_settings.revision
       FROM digital_agents
       JOIN agent_settings
         ON agent_settings.user_id = digital_agents.user_id
        AND agent_settings.agent_id = digital_agents.id
       WHERE digital_agents.user_id = $1
         AND digital_agents.id = $2`,
      [USER_A, AGENT_A],
    );
    expect(stored.rows[0]).toMatchObject({
      display_name: "Mate",
      digital_persona: {
        name: "Mate",
        style: "自然温暖",
        emojiHabit: "少量",
      },
      settings_persona: {
        name: "Mate",
        style: "自然温暖",
        emojiHabit: "少量",
      },
      proactivity: {
        quietStart: "22:30",
        quietEnd: "08:30",
        minIntervalMinutes: 60,
        maxPerHour: 1,
        maxPerDay: 2,
      },
      cadence: {
        responseDelayMs: 600,
        segmentDelayMs: 300,
        maxSegments: 4,
      },
      search: { aggressiveness: "off" },
      revision: 2,
    });
    const audit = await primaryPool.query<{
      action: string;
      before_summary: Record<string, unknown>;
      after_summary: Record<string, unknown>;
    }>(
      `SELECT action, before_summary, after_summary
       FROM admin_audit_logs
       WHERE user_id = $1 AND agent_id = $2`,
      [USER_A, AGENT_A],
    );
    expect(audit.rows).toEqual([
      {
        action: "agent_profile.update",
        before_summary: {
          display_name: "Agent A",
          revision: 1,
        },
        after_summary: {
          display_name: "Mate",
          revision: 2,
          changed_fields: [
            "display_name",
            "persona",
            "proactivity",
            "cadence",
            "search",
          ],
        },
      },
    ]);
    expect(JSON.stringify(audit.rows)).not.toContain("自然温暖");
  });

  it("allows only one writer for the same revision across pools", async () => {
    const first = createAdminAgentProfileService(primaryPool);
    const second = createAdminAgentProfileService(secondaryPool);
    const outcomes = await Promise.allSettled([
      first.update(updateInput({ displayName: "First" })),
      second.update(updateInput({ displayName: "Second" })),
    ]);

    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = outcomes.find(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected",
    );
    expect(rejected?.reason).toMatchObject({
      status: 409,
      code: "revision_conflict",
    });
    const stored = await primaryPool.query<{
      display_name: string;
      revision: number;
    }>(
      `SELECT digital_agents.display_name, agent_settings.revision
       FROM digital_agents
       JOIN agent_settings
         ON agent_settings.user_id = digital_agents.user_id
        AND agent_settings.agent_id = digital_agents.id
       WHERE digital_agents.id = $1`,
      [AGENT_A],
    );
    expect(["First", "Second"]).toContain(
      stored.rows[0].display_name,
    );
    expect(stored.rows[0].revision).toBe(2);
  });

  it("rolls back profile rows when the success audit cannot be inserted", async () => {
    await primaryPool.query(`
      CREATE FUNCTION fail_agent_audit_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'agent_profile.update' THEN
          RAISE EXCEPTION 'forced audit failure';
        END IF;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER fail_agent_audit_insert
      BEFORE INSERT ON admin_audit_logs
      FOR EACH ROW EXECUTE FUNCTION fail_agent_audit_insert();
    `);

    await expect(
      createAdminAgentProfileService(primaryPool).update(updateInput()),
    ).rejects.toThrow();
    const stored = await primaryPool.query<{
      display_name: string;
      style: string;
      revision: number;
    }>(
      `SELECT digital_agents.display_name,
              agent_settings.persona->>'style' AS style,
              agent_settings.revision
       FROM digital_agents
       JOIN agent_settings
         ON agent_settings.user_id = digital_agents.user_id
        AND agent_settings.agent_id = digital_agents.id
       WHERE digital_agents.id = $1`,
      [AGENT_A],
    );
    expect(stored.rows[0]).toEqual({
      display_name: "Agent A",
      style: "old-style",
      revision: 1,
    });
  });

  it("aborts a held row lock with a stable error and leaves the pool reusable", async () => {
    const blocker = await secondaryPool.connect();
    const controller = new AbortController();
    let captured: unknown;
    let elapsedMs = 0;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        `SELECT digital_agents.id
         FROM digital_agents
         JOIN agent_settings
           ON agent_settings.user_id = digital_agents.user_id
          AND agent_settings.agent_id = digital_agents.id
         WHERE digital_agents.id = $1
         FOR UPDATE OF digital_agents, agent_settings`,
        [AGENT_A],
      );
      const startedAt = Date.now();
      const abortTimer = setTimeout(() => {
        controller.abort(new Error("sensitive abort reason"));
      }, 25);
      try {
        await createAdminAgentProfileService(primaryPool).update(
          updateInput(),
          controller.signal,
        );
      } catch (error) {
        captured = error;
      } finally {
        clearTimeout(abortTimer);
        elapsedMs = Date.now() - startedAt;
      }
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }

    expect(captured).toMatchObject({
      status: 500,
      code: "agent_profile_update_failed",
      message: "agent_profile_update_failed",
    });
    expect(String(captured)).not.toContain("sensitive abort reason");
    expect(elapsedMs).toBeLessThan(1_000);
    await expect(primaryPool.query("SELECT 1 AS ok")).resolves.toMatchObject({
      rows: [{ ok: 1 }],
    });
  });
});

function updateInput(
  overrides: {
    displayName?: string;
  } = {},
) {
  return {
    scope: { userId: USER_A, agentId: AGENT_A },
    expectedRevision: 1,
    displayName: overrides.displayName ?? "Mate",
    persona: {
      name: "Mate",
      style: "自然温暖",
      emojiHabit: "少量",
    },
    settings: {
      proactivity: {
        quietStart: "22:30",
        quietEnd: "08:30",
        minIntervalMinutes: 60,
        maxPerHour: 1,
        maxPerDay: 2,
      },
      cadence: {
        responseDelayMs: 600,
        segmentDelayMs: 300,
        maxSegments: 4,
      },
      search: { aggressiveness: "off" as const },
    },
  };
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

async function installVectorCompatibility(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE DOMAIN vector AS text;
    CREATE FUNCTION vector_cosine_distance(vector, vector)
      RETURNS double precision LANGUAGE sql IMMUTABLE AS $$ SELECT 1.0 $$;
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
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}
