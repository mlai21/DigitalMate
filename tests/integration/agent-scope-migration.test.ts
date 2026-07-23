import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import EmbeddedPostgres from "embedded-postgres";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const AGENT_SCOPED_TABLES = [
  "projects",
  "conversations",
  "messages",
  "message_attachments",
  "conversation_summaries",
  "memory_entries",
  "tool_call_logs",
  "proactive_tasks",
  "channel_identities",
  "channel_messages",
  "interjection_decisions",
  "reflections",
  "skill_usage_logs",
  "task_runs",
  "task_artifacts",
  "llm_usage_logs",
  "memory_jobs",
  "goals",
  "goal_steps",
] as const;

const USER_A = "10000000-0000-4000-8000-000000000001";
const USER_B = "20000000-0000-4000-8000-000000000002";
const USER_C = "30000000-0000-4000-8000-000000000003";
const USER_D = "40000000-0000-4000-8000-000000000004";
const USER_E = "50000000-0000-4000-8000-000000000005";
const PROJECT_A = "10000000-0000-4000-8000-000000000011";
const PROJECT_B = "20000000-0000-4000-8000-000000000012";
const CONVERSATION_A = "10000000-0000-4000-8000-000000000021";
const CONVERSATION_B = "20000000-0000-4000-8000-000000000022";
const MESSAGE_A = "10000000-0000-4000-8000-000000000031";
const MESSAGE_B = "20000000-0000-4000-8000-000000000032";
const PROACTIVE_TASK_A = "10000000-0000-4000-8000-000000000041";
const PROACTIVE_TASK_B = "20000000-0000-4000-8000-000000000042";
const CHANNEL_MESSAGE_A = "10000000-0000-4000-8000-000000000051";
const CHANNEL_MESSAGE_B = "20000000-0000-4000-8000-000000000052";
const TASK_RUN_A = "10000000-0000-4000-8000-000000000061";
const TASK_RUN_B = "20000000-0000-4000-8000-000000000062";
const GOAL_A = "10000000-0000-4000-8000-000000000071";
const GOAL_B = "20000000-0000-4000-8000-000000000072";
const SKILL_A = "10000000-0000-4000-8000-000000000091";
const SKILL_B = "20000000-0000-4000-8000-000000000092";
const CLIENT_TURN_ID = "30000000-0000-4000-8000-000000000001";
const MIGRATION_MARKER = "-- BEGIN DEFAULT DIGITAL AGENT MIGRATION";

describe("default digital agent PostgreSQL migration", () => {
  const schemaName = `agent_scope_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let databasePool: Pool;
  let embeddedPostgres: EmbeddedPostgres | null = null;
  let embeddedDatabaseDirectory: string | null = null;
  let migrationFixtureDirectory: string;
  let migrationSchemaPath: string;
  let databaseUrl: string;
  let migratedSchema: string;

  beforeAll(async () => {
    databaseUrl = process.env.TEST_DATABASE_URL ?? "";
    if (!databaseUrl) {
      const port = await reservePort();
      embeddedDatabaseDirectory = await mkdtemp(path.join(os.tmpdir(), "digitalmate-agent-scope-"));
      embeddedPostgres = new EmbeddedPostgres({
        databaseDir: embeddedDatabaseDirectory,
        port,
        user: "postgres",
        password: "digitalmate-test",
        persistent: false,
        onLog: () => undefined,
        onError: () => undefined,
      });
      await embeddedPostgres.initialise();
      await embeddedPostgres.start();
      databaseUrl = `postgresql://postgres:digitalmate-test@127.0.0.1:${port}/postgres`;
    }

    adminPool = new Pool({ connectionString: databaseUrl });
    const sourceSchema = await readFile(path.join(process.cwd(), "src/server/db/schema.sql"), "utf8");
    migratedSchema = adaptSchemaForEmbeddedPostgres(sourceSchema);
    migrationFixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "digitalmate-migration-fixture-"));
    migrationSchemaPath = path.join(migrationFixtureDirectory, "schema.sql");
    await writeFile(migrationSchemaPath, migratedSchema);
  }, 60_000);

  beforeEach(async () => {
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    databasePool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName} -c statement_timeout=15000 -c lock_timeout=5000`,
    });
    await installVectorCompatibility(databasePool);
    const migrationOffset = migratedSchema.indexOf(MIGRATION_MARKER);
    const legacySchema = migrationOffset === -1 ? migratedSchema : migratedSchema.slice(0, migrationOffset);
    await databasePool.query(legacySchema);
    await databasePool.query(`
      CREATE UNIQUE INDEX idx_messages_client_turn_role
        ON messages(user_id, client_turn_id, role)
        WHERE client_turn_id IS NOT NULL;
      CREATE UNIQUE INDEX idx_messages_source_task
        ON messages(source_task_id)
        WHERE source_task_id IS NOT NULL;
    `);
    await seedLegacyRows(databasePool);
  });

  afterEach(async () => {
    await databasePool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  });

  afterAll(async () => {
    await adminPool?.end();
    await embeddedPostgres?.stop();
    if (embeddedDatabaseDirectory) {
      await rm(embeddedDatabaseDirectory, { recursive: true, force: true });
    }
    if (migrationFixtureDirectory) {
      await rm(migrationFixtureDirectory, { recursive: true, force: true });
    }
  });

  it("serializes two real seed processes from a completely empty PostgreSQL schema", async () => {
    for (let round = 0; round < 3; round += 1) {
      const freshSchemaName = `${schemaName}_fresh_${round}`;
      await adminPool.query(`CREATE SCHEMA "${freshSchemaName}"`);
      const freshPool = new Pool({
        connectionString: adminPool.options.connectionString,
        options: `-c search_path=${freshSchemaName} -c statement_timeout=15000 -c lock_timeout=5000`,
      });
      try {
        await installVectorCompatibility(freshPool);
        await freshPool.query(migratedSchema);
        await freshPool.query(migratedSchema);
        const columns = await readAgentColumns(freshPool);
        expect([...columns.keys()].sort()).toEqual([...AGENT_SCOPED_TABLES].sort());
        await Promise.all([runSeed(databaseUrl, freshSchemaName), runSeed(databaseUrl, freshSchemaName)]);
        await runSeed(databaseUrl, freshSchemaName);
        await runSeed(databaseUrl, freshSchemaName);
        const seedCounts = await freshPool.query<{
          users: string;
          settings: string;
          agents: string;
          agent_settings: string;
          defaults: string;
          conversations: string;
        }>(
          `SELECT
             (SELECT count(*) FROM users) AS users,
             (SELECT count(*) FROM settings) AS settings,
             (SELECT count(*) FROM digital_agents) AS agents,
             (SELECT count(*) FROM agent_settings) AS agent_settings,
             (SELECT count(*) FROM digital_agents WHERE is_default = true) AS defaults,
             (SELECT count(*) FROM conversations WHERE channel = 'web') AS conversations`,
        );
        expect(seedCounts.rows[0], `round:${round}`).toEqual({
          users: "1",
          settings: "1",
          agents: "1",
          agent_settings: "1",
          defaults: "1",
          conversations: "1",
        });
      } finally {
        await freshPool.end();
        await adminPool.query(`DROP SCHEMA IF EXISTS "${freshSchemaName}" CASCADE`);
      }
    }
  });

  it("serializes two real migration processes against one empty PostgreSQL schema", async () => {
    const freshSchemaName = `${schemaName}_migration`;
    await adminPool.query(`CREATE SCHEMA "${freshSchemaName}"`);
    const freshPool = new Pool({
      connectionString: adminPool.options.connectionString,
      options: `-c search_path=${freshSchemaName} -c statement_timeout=15000 -c lock_timeout=5000`,
    });
    try {
      await installVectorCompatibility(freshPool);
      await Promise.all([
        runMigration(databaseUrl, freshSchemaName, migrationSchemaPath),
        runMigration(databaseUrl, freshSchemaName, migrationSchemaPath),
      ]);
      const columns = await readAgentColumns(freshPool);
      expect([...columns.keys()].sort()).toEqual([...AGENT_SCOPED_TABLES].sort());
    } finally {
      await freshPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS "${freshSchemaName}" CASCADE`);
    }
  });

  it("migrates all legacy rows into one default agent per user and stays idempotent", async () => {
    await databasePool.query(migratedSchema);
    const firstAgents = await readDefaultAgents(databasePool);
    expect(firstAgents).toHaveLength(2);
    expect(firstAgents.map((row) => row.user_id).sort()).toEqual([USER_A, USER_B].sort());
    expect(firstAgents.map((row) => row.persona_name).sort()).toEqual(["Agent A", "Agent B"]);

    await databasePool.query(migratedSchema);
    const secondAgents = await readDefaultAgents(databasePool);
    expect(secondAgents).toEqual(firstAgents);
    const agentCount = await databasePool.query<{ count: string }>("SELECT count(*) AS count FROM digital_agents");
    expect(agentCount.rows[0].count).toBe("2");
    const migratedSettings = await databasePool.query<{
      user_id: string;
      agent_id: string;
      persona_name: string | null;
      revision: number;
    }>(
      `SELECT user_id, agent_id, persona->>'name' AS persona_name, revision
       FROM agent_settings
       ORDER BY user_id`,
    );
    expect(migratedSettings.rows).toEqual(firstAgents.map((agent) => ({
      user_id: agent.user_id,
      agent_id: agent.id,
      persona_name: agent.persona_name,
      revision: 1,
    })));
    const replacedIndexes = await databasePool.query<{
      old_client_turn: string | null;
      old_source_task: string | null;
    }>(
      `SELECT
         to_regclass('idx_messages_client_turn_role')::text AS old_client_turn,
         to_regclass('idx_messages_source_task')::text AS old_source_task`,
    );
    expect(replacedIndexes.rows[0]).toEqual({
      old_client_turn: null,
      old_source_task: null,
    });

    const columns = await readAgentColumns(databasePool);
    for (const table of AGENT_SCOPED_TABLES) {
      expect(columns.get(table), table).toEqual({
        isNullable: "NO",
        referencesDigitalAgents: true,
      });
    }

    for (const table of AGENT_SCOPED_TABLES.filter((table) => table !== "goal_steps")) {
      const result = await databasePool.query<{ mismatches: string }>(
        `SELECT count(*) AS mismatches
         FROM ${table} AS scoped_row
         JOIN digital_agents AS agent ON agent.id = scoped_row.agent_id
         WHERE scoped_row.user_id <> agent.user_id`,
      );
      expect(result.rows[0].mismatches, table).toBe("0");
    }

    const goalStepResult = await databasePool.query<{ mismatches: string }>(
      `SELECT count(*) AS mismatches
       FROM goal_steps AS step
       JOIN goals AS goal ON goal.id = step.goal_id
       WHERE step.agent_id <> goal.agent_id`,
    );
    expect(goalStepResult.rows[0].mismatches).toBe("0");

    for (const userId of [USER_A, USER_B]) {
      const expectedAgent = secondAgents.find((row) => row.user_id === userId)?.id;
      expect(expectedAgent).toBeDefined();
      for (const table of AGENT_SCOPED_TABLES.filter((table) => table !== "goal_steps")) {
        const result = await databasePool.query<{ agent_ids: string[] }>(
          `SELECT array_agg(DISTINCT agent_id::text ORDER BY agent_id::text) AS agent_ids
           FROM ${table}
           WHERE user_id = $1`,
          [userId],
        );
        expect(result.rows[0].agent_ids, `${table}:${userId}`).toEqual([expectedAgent]);
      }
    }
  });

  it("preserves an existing custom default and only promotes DigitalMate when no default exists", async () => {
    await databasePool.query(migratedSchema);
    await databasePool.query(
      "INSERT INTO users (id, display_name) VALUES ($1, 'User C'), ($2, 'User D'), ($3, 'User E')",
      [USER_C, USER_D, USER_E],
    );
    await databasePool.query(
      `INSERT INTO settings (user_id, persona)
       VALUES
         ($1, '{"name":"Agent C"}'::jsonb),
         ($2, '{"name":"Agent D"}'::jsonb),
         ($3, '{"name":"Agent E"}'::jsonb)`,
      [USER_C, USER_D, USER_E],
    );
    await databasePool.query(
      `INSERT INTO digital_agents (user_id, slug, display_name, is_default)
       VALUES
         ($1, 'digitalmate', 'DigitalMate', false),
         ($2, 'digitalmate', 'DigitalMate', false),
         ($2, 'custom', 'Custom D', true)`,
      [USER_C, USER_D],
    );

    await databasePool.query(migratedSchema);
    await databasePool.query(migratedSchema);

    const defaults = await databasePool.query<{ user_id: string; slug: string }>(
      `SELECT user_id, slug
       FROM digital_agents
       WHERE user_id = ANY($1::uuid[])
         AND is_default = true
       ORDER BY user_id`,
      [[USER_C, USER_D, USER_E]],
    );
    expect(defaults.rows).toEqual([
      { user_id: USER_C, slug: "digitalmate" },
      { user_id: USER_D, slug: "custom" },
      { user_id: USER_E, slug: "digitalmate" },
    ]);
    const settingsOwners = await databasePool.query<{ user_id: string; slug: string }>(
      `SELECT agent_settings.user_id, digital_agents.slug
       FROM agent_settings
       JOIN digital_agents
         ON digital_agents.user_id = agent_settings.user_id
        AND digital_agents.id = agent_settings.agent_id
       WHERE agent_settings.user_id = ANY($1::uuid[])
       ORDER BY agent_settings.user_id`,
      [[USER_C, USER_D, USER_E]],
    );
    expect(settingsOwners.rows).toEqual(defaults.rows);
  });

  it("rejects cross-user ownership and parent rows from another agent", async () => {
    await databasePool.query(migratedSchema);
    const agents = await readDefaultAgents(databasePool);
    const agentA = agents.find((row) => row.user_id === USER_A)!.id;
    const agentB = agents.find((row) => row.user_id === USER_B)!.id;

    await expect(
      databasePool.query(
        "INSERT INTO projects (user_id, agent_id, name) VALUES ($1, $2, 'wrong owner')",
        [USER_A, agentB],
      ),
    ).rejects.toMatchObject({ code: "23503" });

    await expect(
      databasePool.query(
        "INSERT INTO agent_resource_grants (user_id, agent_id, resource_type, resource_id) VALUES ($1, $2, 'model', 'wrong')",
        [USER_A, agentB],
      ),
    ).rejects.toMatchObject({ code: "23503" });

    await expect(
      databasePool.query(
        `INSERT INTO messages (user_id, agent_id, conversation_id, role, content)
         VALUES ($1, $2, $3, 'user', 'wrong parent')`,
        [USER_A, agentA, CONVERSATION_B],
      ),
    ).rejects.toMatchObject({ code: "23503" });

    await expect(
      databasePool.query(
        `INSERT INTO goal_steps (goal_id, agent_id, round, phase)
         VALUES ($1, $2, 99, 'collecting')`,
        [GOAL_A, agentB],
      ),
    ).rejects.toMatchObject({ code: "23503" });

    const crossUserSkillReferences = await Promise.allSettled([
      databasePool.query(
        `INSERT INTO skill_revisions (user_id, skill_id, proposed_content, reason)
         VALUES ($1, $2, 'wrong revision', 'wrong owner')`,
        [USER_A, SKILL_B],
      ),
      databasePool.query(
        `INSERT INTO skill_usage_logs (user_id, agent_id, skill_id, conversation_id)
         VALUES ($1, $2, $3, $4)`,
        [USER_A, agentA, SKILL_B, CONVERSATION_A],
      ),
    ]);
    for (const result of crossUserSkillReferences) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({ code: "23503" });
      }
    }

    await expect(
      databasePool.query(
        `INSERT INTO skill_revisions (user_id, skill_id, proposed_content, reason)
         VALUES ($1, $2, 'legal revision', 'same owner')`,
        [USER_A, SKILL_A],
      ),
    ).resolves.toBeDefined();
    await expect(
      databasePool.query(
        `INSERT INTO skill_usage_logs (user_id, agent_id, skill_id, conversation_id)
         VALUES ($1, $2, $3, $4)`,
        [USER_A, agentA, SKILL_A, CONVERSATION_A],
      ),
    ).resolves.toBeDefined();
  });

  it("scopes legacy business uniqueness by agent after the replacement index exists", async () => {
    await databasePool.query(migratedSchema);
    const agents = await readDefaultAgents(databasePool);
    const agentA = agents.find((row) => row.user_id === USER_A)!.id;
    const secondAgent = (
      await databasePool.query<{ id: string }>(
        `INSERT INTO digital_agents (user_id, slug, display_name)
         VALUES ($1, 'second', 'Second')
         RETURNING id`,
        [USER_A],
      )
    ).rows[0].id;
    const secondConversation = (
      await databasePool.query<{ id: string }>(
        `INSERT INTO conversations (user_id, agent_id, title)
         VALUES ($1, $2, 'Second conversation')
         RETURNING id`,
        [USER_A, secondAgent],
      )
    ).rows[0].id;

    await expect(
      databasePool.query(
        `INSERT INTO messages (user_id, agent_id, conversation_id, role, content)
         VALUES ($1, $2, $3, 'user', 'same user, wrong agent parent')`,
        [USER_A, agentA, secondConversation],
      ),
    ).rejects.toMatchObject({ code: "23503" });

    await expect(
      databasePool.query(
        `INSERT INTO goals (user_id, agent_id, title, conversation_id)
         VALUES ($1, $2, 'same user, wrong nullable parent', $3)`,
        [USER_A, agentA, secondConversation],
      ),
    ).rejects.toMatchObject({ code: "23503" });

    await databasePool.query(
      `INSERT INTO messages (user_id, agent_id, conversation_id, role, content, client_turn_id)
       VALUES
         ($1, $2, $3, 'user', 'default agent turn', $6),
         ($1, $4, $5, 'user', 'second agent turn', $6)`,
      [USER_A, agentA, CONVERSATION_A, secondAgent, secondConversation, CLIENT_TURN_ID],
    );
    await databasePool.query(
      `INSERT INTO channel_identities (user_id, agent_id, channel, external_user_id)
       VALUES
         ($1, $2, 'telegram', 'shared-external-user'),
         ($1, $3, 'telegram', 'shared-external-user')`,
      [USER_A, agentA, secondAgent],
    );
    await databasePool.query(
      `INSERT INTO channel_messages (
         user_id, agent_id, channel, external_conversation_id, external_message_id,
         sender_id, chat_type, text, occurred_at
       )
       VALUES
         ($1, $2, 'telegram', 'chat-a', 'shared-external-message', 'sender', 'direct', 'A', now()),
         ($1, $3, 'telegram', 'chat-b', 'shared-external-message', 'sender', 'direct', 'B', now())`,
      [USER_A, agentA, secondAgent],
    );

    await expect(
      databasePool.query(
        `INSERT INTO messages (user_id, agent_id, conversation_id, role, content, client_turn_id)
         VALUES ($1, $2, $3, 'user', 'duplicate', $4)`,
        [USER_A, agentA, CONVERSATION_A, CLIENT_TURN_ID],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    await expect(
      databasePool.query("UPDATE digital_agents SET is_default = true WHERE id = $1", [secondAgent]),
    ).rejects.toMatchObject({ code: "23505" });

    const defaultSwitchClient = await databasePool.connect();
    try {
      await defaultSwitchClient.query("BEGIN");
      await defaultSwitchClient.query("UPDATE digital_agents SET is_default = false WHERE id = $1", [agentA]);
      await defaultSwitchClient.query("UPDATE digital_agents SET is_default = true WHERE id = $1", [secondAgent]);
      await defaultSwitchClient.query("COMMIT");
    } catch (error) {
      await defaultSwitchClient.query("ROLLBACK");
      throw error;
    } finally {
      defaultSwitchClient.release();
    }
    await databasePool.query(migratedSchema);
    await databasePool.query(migratedSchema);
    await runSeed(databaseUrl, schemaName);
    await runSeed(databaseUrl, schemaName);
    const agentCounts = await databasePool.query<{ total: string; defaults: string }>(
      `SELECT
         count(*) AS total,
         count(*) FILTER (WHERE is_default = true) AS defaults
       FROM digital_agents
       WHERE user_id = $1`,
      [USER_A],
    );
    expect(agentCounts.rows[0]).toEqual({ total: "2", defaults: "1" });
    const selectedDefault = await databasePool.query<{ id: string }>(
      "SELECT id FROM digital_agents WHERE user_id = $1 AND is_default = true",
      [USER_A],
    );
    expect(selectedDefault.rows).toEqual([{ id: secondAgent }]);
  });
});

async function readDefaultAgents(pool: Pool) {
  const result = await pool.query<{
    id: string;
    user_id: string;
    persona_name: string | null;
  }>(
    `SELECT id, user_id, persona->>'name' AS persona_name
     FROM digital_agents
     WHERE is_default = true
     ORDER BY user_id`,
  );
  return result.rows;
}

async function readAgentColumns(pool: Pool) {
  const result = await pool.query<{
    table_name: (typeof AGENT_SCOPED_TABLES)[number];
    is_nullable: "YES" | "NO";
    references_digital_agents: boolean;
  }>(
    `SELECT
       columns.table_name,
       columns.is_nullable,
       EXISTS (
         SELECT 1
         FROM pg_constraint AS constraint_row
         JOIN pg_class AS source_table ON source_table.oid = constraint_row.conrelid
         JOIN pg_class AS target_table ON target_table.oid = constraint_row.confrelid
         JOIN pg_attribute AS source_column
           ON source_column.attrelid = source_table.oid
          AND source_column.attnum = ANY(constraint_row.conkey)
         WHERE constraint_row.contype = 'f'
           AND source_table.relname = columns.table_name
           AND target_table.relname = 'digital_agents'
           AND source_column.attname = 'agent_id'
       ) AS references_digital_agents
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND column_name = 'agent_id'
       AND table_name = ANY($1::text[])
     ORDER BY table_name`,
    [AGENT_SCOPED_TABLES],
  );
  return new Map(
    result.rows.map((row) => [
      row.table_name,
      {
        isNullable: row.is_nullable,
        referencesDigitalAgents: row.references_digital_agents,
      },
    ]),
  );
}

async function seedLegacyRows(pool: Pool): Promise<void> {
  const ids = [
    USER_A,
    USER_B,
    PROJECT_A,
    PROJECT_B,
    CONVERSATION_A,
    CONVERSATION_B,
    MESSAGE_A,
    MESSAGE_B,
    PROACTIVE_TASK_A,
    PROACTIVE_TASK_B,
    CHANNEL_MESSAGE_A,
    CHANNEL_MESSAGE_B,
    TASK_RUN_A,
    TASK_RUN_B,
    GOAL_A,
    GOAL_B,
  ];
  const statement = `
      INSERT INTO users (id, display_name)
      VALUES ($1, 'User A'), ($2, 'User B');

      INSERT INTO settings (user_id, persona)
      VALUES
        ($1, '{"name":"Agent A"}'::jsonb),
        ($2, '{"name":"Agent B"}'::jsonb);

      INSERT INTO projects (id, user_id, name)
      VALUES ($3, $1, 'Project A'), ($4, $2, 'Project B');

      INSERT INTO conversations (id, user_id, project_id, title)
      VALUES
        ($5, $1, $3, 'Conversation A'),
        ($6, $2, $4, 'Conversation B');

      INSERT INTO proactive_tasks (id, user_id, conversation_id, kind, content, scheduled_at)
      VALUES
        ($9, $1, $5, 'reminder', 'Reminder A', now()),
        ($10, $2, $6, 'reminder', 'Reminder B', now());

      INSERT INTO messages (id, user_id, conversation_id, role, content, source_task_id)
      VALUES
        ($7, $1, $5, 'user', 'Message A', $9),
        ($8, $2, $6, 'user', 'Message B', $10);

      INSERT INTO message_attachments (
        id, user_id, message_id, kind, file_name, mime_type, size_bytes, storage_key, status
      )
      VALUES
        ('10000000-0000-4000-8000-000000000081', $1, $7, 'document', 'a.md', 'text/markdown', 1, 'a.md', 'bound'),
        ('20000000-0000-4000-8000-000000000082', $2, $8, 'document', 'b.md', 'text/markdown', 1, 'b.md', 'bound');

      INSERT INTO conversation_summaries (user_id, conversation_id, summary, message_count)
      VALUES ($1, $5, 'Summary A', 1), ($2, $6, 'Summary B', 1);

      INSERT INTO memory_entries (user_id, kind, content, source_message_id)
      VALUES ($1, 'profile', 'Memory A', $7), ($2, 'profile', 'Memory B', $8);

      INSERT INTO channel_identities (user_id, channel, external_user_id)
      VALUES ($1, 'telegram', 'external-a'), ($2, 'telegram', 'external-b');

      INSERT INTO channel_messages (
        id, user_id, conversation_id, channel, external_conversation_id,
        external_message_id, sender_id, chat_type, text, occurred_at
      )
      VALUES
        ($11, $1, $5, 'telegram', 'chat-a', 'message-a', 'sender-a', 'direct', 'Channel A', now()),
        ($12, $2, $6, 'telegram', 'chat-b', 'message-b', 'sender-b', 'direct', 'Channel B', now());

      INSERT INTO interjection_decisions (
        user_id, conversation_id, channel_message_id, channel,
        external_conversation_id, should_interject, reason
      )
      VALUES
        ($1, $5, $11, 'telegram', 'chat-a', false, 'No A'),
        ($2, $6, $12, 'telegram', 'chat-b', false, 'No B');

      INSERT INTO reflections (user_id, positives)
      VALUES ($1, ARRAY['A']), ($2, ARRAY['B']);

      INSERT INTO skills (id, user_id, name, trigger, content)
      VALUES
        ('10000000-0000-4000-8000-000000000091', $1, 'Skill A', 'A', 'A'),
        ('20000000-0000-4000-8000-000000000092', $2, 'Skill B', 'B', 'B');

      INSERT INTO skill_usage_logs (user_id, skill_id, conversation_id)
      VALUES
        ($1, '10000000-0000-4000-8000-000000000091', $5),
        ($2, '20000000-0000-4000-8000-000000000092', $6);

      INSERT INTO task_runs (id, user_id, conversation_id, kind, input_summary)
      VALUES
        ($13, $1, $5, 'sandbox', 'Task A'),
        ($14, $2, $6, 'sandbox', 'Task B');

      INSERT INTO task_artifacts (user_id, task_run_id, file_name, mime_type, storage_path)
      VALUES
        ($1, $13, 'a.txt', 'text/plain', '/private/a'),
        ($2, $14, 'b.txt', 'text/plain', '/private/b');

      INSERT INTO llm_usage_logs (
        user_id, conversation_id, purpose, model, input_tokens, output_tokens, total_tokens
      )
      VALUES
        ($1, $5, 'main', 'model-a', 1, 1, 2),
        ($2, $6, 'main', 'model-b', 1, 1, 2);

      INSERT INTO memory_jobs (user_id, conversation_id, message_ids)
      VALUES ($1, $5, ARRAY[$7]::uuid[]), ($2, $6, ARRAY[$8]::uuid[]);

      INSERT INTO goals (id, user_id, title, conversation_id)
      VALUES ($15, $1, 'Goal A', $5), ($16, $2, 'Goal B', $6);

      INSERT INTO goal_steps (goal_id, round, phase)
      VALUES ($15, 1, 'collecting'), ($16, 1, 'collecting');

      INSERT INTO tool_call_logs (
        user_id, conversation_id, message_id, goal_id, tool_name,
        input_summary, output_summary, status
      )
      VALUES
        ($1, $5, $7, $15, 'tool-a', 'input', 'output', 'success'),
        ($2, $6, $8, $16, 'tool-b', 'input', 'output', 'success');
    `;
  const simpleQuery = statement.replace(
    /\$(\d+)/g,
    (_match, position: string) => `'${ids[Number(position) - 1]}'::uuid`,
  );
  await pool.query(simpleQuery);
}

function adaptSchemaForEmbeddedPostgres(schema: string): string {
  return schema
    .replace("CREATE EXTENSION IF NOT EXISTS vector;", "")
    .replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", "")
    .replaceAll("vector(1536)", "vector")
    .replace(/^CREATE INDEX IF NOT EXISTS idx_memory_entries_embedding.*$/m, "");
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
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("postgres_test_port_unavailable"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function runSeed(databaseUrl: string, schemaName: string): Promise<void> {
  const scopedUrl = new URL(databaseUrl);
  scopedUrl.searchParams.set("options", `-c search_path=${schemaName}`);
  const child = spawn(
    process.execPath,
    [path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), "src/server/db/seed.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: scopedUrl.toString(),
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const [exitCode, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  if (exitCode !== 0) {
    throw new Error(`seed_failed:${exitCode ?? signal ?? "unknown"}:${stderr}`);
  }
}

async function runMigration(databaseUrl: string, schemaName: string, schemaPath: string): Promise<void> {
  const scopedUrl = new URL(databaseUrl);
  scopedUrl.searchParams.set("options", `-c search_path=${schemaName}`);
  const child = spawn(
    process.execPath,
    [
      path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
      "tests/fixtures/run-schema-migration.ts",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: scopedUrl.toString(),
        DIGITALMATE_TEST_SCHEMA_PATH: schemaPath,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const [exitCode, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  if (exitCode !== 0) {
    throw new Error(`migration_failed:${exitCode ?? signal ?? "unknown"}:${stderr}`);
  }
}
