import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAgent } from "@/server/agent/run-agent";
import {
  assertAuthorizedModelRoutes,
  createAgentService,
} from "@/server/agents/service";
import type { AgentScope } from "@/server/agents/types";
import { createRepositories } from "@/server/db/repositories";
import type { LlmStreamInput } from "@/server/llm/types";
import { defaultSettings } from "@/server/settings/defaults";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_A = "10000000-0000-4000-8000-00000000000a";
const AGENT_B = "10000000-0000-4000-8000-00000000000b";
const scopeA = { userId: USER_ID, agentId: AGENT_A } satisfies AgentScope;
const scopeB = { userId: USER_ID, agentId: AGENT_B } satisfies AgentScope;

describe("agent-scoped repositories on PostgreSQL", () => {
  let embeddedPostgres: EmbeddedPostgres;
  let databaseDirectory: string;
  let pool: Pool;

  beforeAll(async () => {
    const port = await reservePort();
    databaseDirectory = await mkdtemp(path.join(os.tmpdir(), "digitalmate-agent-repositories-"));
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
    pool = new Pool({
      connectionString: `postgresql://postgres:digitalmate-test@127.0.0.1:${port}/postgres`,
      options: "-c statement_timeout=15000 -c lock_timeout=5000",
    });
    await installSchema(pool);
    await seedAgents(pool);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await embeddedPostgres?.stop();
    if (databaseDirectory) {
      await rm(databaseDirectory, { recursive: true, force: true });
    }
  });

  it("enforces inherited and explicit resource grants in the real execution path", async () => {
    const repositories = createRepositories(pool);
    const skills = await pool.query<{ id: string; name: string }>(
      `INSERT INTO skills (user_id, name, trigger, content, status)
       VALUES
         ($1, 'allowed-skill', 'resource matrix', 'A_ONLY_SKILL_CONTENT', 'enabled'),
         ($1, 'inherited-skill', 'resource matrix', 'B_ONLY_SKILL_CONTENT', 'enabled')
       RETURNING id, name`,
      [USER_ID],
    );
    const tools = await pool.query<{ id: string; name: string }>(
      `INSERT INTO tool_registrations (
         user_id, name, description, command, status
       )
       VALUES
         ($1, 'allowed_tool', 'A only tool', 'echo A', 'enabled'),
         ($1, 'inherited_tool', 'B inherited tool', 'echo B', 'enabled')
       RETURNING id, name`,
      [USER_ID],
    );
    const skillA = skills.rows.find((row) => row.name === "allowed-skill")!;
    const skillB = skills.rows.find((row) => row.name === "inherited-skill")!;
    const toolA = tools.rows.find((row) => row.name === "allowed_tool")!;

    await pool.query(
      `INSERT INTO agent_resource_grants (
         user_id, agent_id, resource_type, resource_id, enabled
       )
       VALUES
         ($1, $2, 'skill', $4, true),
         ($1, $2, 'tool', $5, true),
         ($1, $2, 'model', 'model-main', true),
         ($1, $3, 'skill', $4, false),
         ($1, $3, 'tool', $5, false),
         ($1, $3, 'model', 'model-main', false)`,
      [USER_ID, AGENT_A, AGENT_B, skillA.id, toolA.id],
    );

    await expect(
      repositories.skills.findByIds(scopeA, [skillA.id, skillB.id]),
    ).resolves.toEqual([
      expect.objectContaining({ id: skillA.id }),
    ]);
    await expect(
      repositories.skills.findByIds(scopeB, [skillA.id, skillB.id]),
    ).resolves.toEqual([
      expect.objectContaining({ id: skillB.id }),
    ]);
    await expect(repositories.toolRegistrations.listEnabled(scopeA))
      .resolves.toEqual([
        expect.objectContaining({ name: "allowed_tool" }),
      ]);
    await expect(repositories.toolRegistrations.listEnabled(scopeB))
      .resolves.toEqual([
        expect.objectContaining({ name: "inherited_tool" }),
      ]);

    const requestsA: LlmStreamInput[] = [];
    const requestsB: LlmStreamInput[] = [];
    await collectAgentOutput(scopeA, requestsA, repositories);
    await collectAgentOutput(scopeB, requestsB, repositories);
    const promptA = requestsA[0]?.messages.map((message) => message.content).join("\n") ?? "";
    const promptB = requestsB[0]?.messages.map((message) => message.content).join("\n") ?? "";
    expect(promptA).toContain("A_ONLY_SKILL_CONTENT");
    expect(promptA).not.toContain("B_ONLY_SKILL_CONTENT");
    expect(requestsA[0]?.tools?.map((tool) => tool.name)).toContain("allowed_tool");
    expect(requestsA[0]?.tools?.map((tool) => tool.name)).not.toContain("inherited_tool");
    expect(promptB).toContain("B_ONLY_SKILL_CONTENT");
    expect(promptB).not.toContain("A_ONLY_SKILL_CONTENT");
    expect(requestsB[0]?.tools?.map((tool) => tool.name)).toContain("inherited_tool");
    expect(requestsB[0]?.tools?.map((tool) => tool.name)).not.toContain("allowed_tool");

    const routing = { main: "model-main", light: "model-light" };
    await expect(
      assertAuthorizedModelRoutes(scopeA, ["main"], routing, repositories.agents),
    ).resolves.toBeUndefined();
    await expect(
      assertAuthorizedModelRoutes(scopeA, ["light"], routing, repositories.agents),
    ).rejects.toThrow("model_resource_unauthorized");
    await expect(
      assertAuthorizedModelRoutes(scopeB, ["main"], routing, repositories.agents),
    ).rejects.toThrow("model_resource_unauthorized");
    await expect(
      assertAuthorizedModelRoutes(scopeB, ["light"], routing, repositories.agents),
    ).resolves.toBeUndefined();

    const deniedLlm = { calls: 0 };
    await expect((async () => {
      await assertAuthorizedModelRoutes(scopeB, ["main"], routing, repositories.agents);
      deniedLlm.calls += 1;
    })()).rejects.toThrow("model_resource_unauthorized");
    expect(deniedLlm.calls).toBe(0);

    const agentService = createAgentService(repositories.agents);
    await expect(
      agentService.listAuthorizedResourceIds(
        scopeB,
        "skill",
        [skillA.id, skillB.id],
      ),
    ).resolves.toEqual([skillB.id]);
  }, 30_000);

  it("isolates two agents across domain APIs and converges clear to one canonical default", async () => {
    const repositories = createRepositories(pool);
    const conversationA = await repositories.conversations.create(scopeA, { title: "A conversation" });
    const conversationB = await repositories.conversations.create(scopeB, { title: "B conversation" });
    const messageA = await repositories.messages.create(scopeA, {
      conversationId: conversationA.id,
      role: "user",
      content: "A message",
    });
    const messageB = await repositories.messages.create(scopeB, {
      conversationId: conversationB.id,
      role: "user",
      content: "B message",
    });

    await expect(repositories.messages.list(scopeA, conversationB.id)).resolves.toEqual([]);
    await expect(repositories.messages.create(scopeA, {
      conversationId: conversationB.id,
      role: "user",
      content: "cross-agent write",
    })).rejects.toThrow("conversation_not_found");
    await expect(repositories.conversations.update(scopeA, conversationB.id, {
      title: "cross-agent update",
    })).resolves.toBeNull();
    await repositories.conversations.delete(scopeA, conversationB.id);
    await expect(repositories.conversations.get(scopeB, conversationB.id))
      .resolves.toMatchObject({ title: "B conversation", agentId: AGENT_B });

    await repositories.memories.createMany(scopeA, messageA.id, [{
      kind: "profile",
      content: "A memory",
      confidence: 0.9,
    }]);
    await repositories.memories.createMany(scopeB, messageB.id, [{
      kind: "profile",
      content: "B memory",
      confidence: 0.9,
    }]);
    await repositories.memories.createMany(scopeA, messageB.id, [{
      kind: "profile",
      content: "cross-agent memory",
      confidence: 0.9,
    }]);
    await expect(repositories.memories.list(scopeA)).resolves.toEqual([
      expect.objectContaining({ content: "A memory", agentId: AGENT_A }),
    ]);
    await expect(repositories.memories.list(scopeB)).resolves.toEqual([
      expect.objectContaining({ content: "B memory", agentId: AGENT_B }),
    ]);

    await repositories.reflections.create(scopeA, {
      reflection: { positives: ["A"], negatives: [], suggestions: ["A suggestion"] },
    });
    await repositories.reflections.create(scopeB, {
      reflection: { positives: ["B"], negatives: [], suggestions: ["B suggestion"] },
    });
    const reflectionB = (await repositories.reflections.list(scopeB))[0];
    await repositories.reflections.setStatus(scopeA, reflectionB.id, "applied");
    await expect(repositories.reflections.findAppliedSuggestions(scopeA)).resolves.toEqual([]);
    await expect(repositories.reflections.findAppliedSuggestions(scopeB)).resolves.toEqual([]);
    expect(await repositories.reflections.list(scopeA)).toHaveLength(1);
    expect(await repositories.reflections.list(scopeB)).toHaveLength(1);

    const goalA = await repositories.goals.create(scopeA, {
      title: "A goal",
      contract: goalContract("A"),
      conversationId: conversationA.id,
    });
    const goalB = await repositories.goals.create(scopeB, {
      title: "B goal",
      contract: goalContract("B"),
      conversationId: conversationB.id,
    });
    await expect(repositories.goals.get(scopeA, goalB.id)).resolves.toBeNull();
    await repositories.goals.setStatus(scopeA, goalB.id, "cancelled");
    await expect(repositories.goals.get(scopeB, goalB.id))
      .resolves.toMatchObject({ status: "draft" });
    await repositories.goals.updateProgress(scopeA, goalA.id, { progressSummary: "A progress" });
    await expect(repositories.goals.get(scopeA, goalA.id))
      .resolves.toMatchObject({ progressSummary: "A progress" });

    const taskA = await repositories.taskRuns.create(scopeA, {
      conversationId: conversationA.id,
      kind: "presentation",
      inputSummary: "A task",
    });
    const taskB = await repositories.taskRuns.create(scopeB, {
      conversationId: conversationB.id,
      kind: "presentation",
      inputSummary: "B task",
    });
    const artifactA = await repositories.taskArtifacts.create(scopeA, {
      taskRunId: taskA,
      fileName: "a.txt",
      mimeType: "text/plain",
      storagePath: `${USER_ID}/${taskA}/a.txt`,
    });
    const artifactB = await repositories.taskArtifacts.create(scopeB, {
      taskRunId: taskB,
      fileName: "b.txt",
      mimeType: "text/plain",
      storagePath: `${USER_ID}/${taskB}/b.txt`,
    });
    await expect(repositories.taskArtifacts.get(scopeA, artifactB)).resolves.toBeNull();
    await expect(repositories.taskArtifacts.create(scopeA, {
      taskRunId: taskB,
      fileName: "cross.txt",
      mimeType: "text/plain",
      storagePath: "cross.txt",
    })).rejects.toThrow("task_run_not_found");
    await repositories.taskRuns.complete(scopeA, taskB, "cross-agent completion");
    await repositories.taskRuns.complete(scopeB, taskB, "B complete");
    await expect(repositories.taskArtifacts.get(scopeA, artifactA))
      .resolves.toMatchObject({ agent_id: AGENT_A });
    await expect(repositories.taskRuns.list(scopeB))
      .resolves.toEqual([expect.objectContaining({ output_summary: "B complete" })]);

    const pendingArtifact = await repositories.taskArtifacts.createPending(scopeA, {
      taskRunId: taskA,
      fileName: "pending.txt",
      mimeType: "text/plain",
      storagePath: `${USER_ID}/${taskA}/pending.txt`,
      temporaryStoragePath: `${USER_ID}/${taskA}/.pending.txt.test.tmp`,
    });
    await expect(repositories.taskArtifacts.get(scopeA, pendingArtifact)).resolves.toBeNull();
    await expect(repositories.taskArtifacts.list(scopeA))
      .resolves.not.toEqual(expect.arrayContaining([expect.objectContaining({ id: pendingArtifact })]));
    await expect(repositories.taskArtifacts.markReady(scopeA, pendingArtifact)).resolves.toBe(true);
    await expect(repositories.taskArtifacts.get(scopeA, pendingArtifact))
      .resolves.toMatchObject({ id: pendingArtifact, status: "ready" });
    await expect(repositories.taskArtifacts.markPendingForCleanup(scopeA, pendingArtifact))
      .resolves.toBe(true);
    await expect(repositories.taskArtifacts.get(scopeA, pendingArtifact)).resolves.toBeNull();
    await expect(repositories.taskArtifacts.delete(scopeA, pendingArtifact)).resolves.toBe(true);
    await expect(repositories.taskArtifacts.get(scopeA, pendingArtifact)).resolves.toBeNull();
    const expiredPending = await repositories.taskArtifacts.createPending(scopeA, {
      taskRunId: taskA,
      fileName: "expired.txt",
      mimeType: "text/plain",
      storagePath: `${USER_ID}/${taskA}/expired.txt`,
      temporaryStoragePath: `${USER_ID}/${taskA}/.expired.txt.test.tmp`,
    });
    await pool.query(
      "UPDATE task_artifacts SET updated_at = now() - interval '25 hours' WHERE id = $1",
      [expiredPending],
    );
    await expect(repositories.taskArtifacts.listExpiredPending(scopeA, 24, 100))
      .resolves.toEqual([expect.objectContaining({ id: expiredPending, status: "pending" })]);

    await repositories.toolLogs.create({
      ...scopeA,
      conversationId: conversationA.id,
      toolName: "tool-a",
      inputSummary: "A input",
      outputSummary: "A output",
      status: "success",
      durationMs: 1,
    });
    await repositories.toolLogs.create({
      ...scopeA,
      conversationId: conversationB.id,
      toolName: "cross-tool",
      inputSummary: "cross",
      outputSummary: "cross",
      status: "success",
      durationMs: 1,
    });
    await repositories.llmUsage.create({
      ...scopeA,
      conversationId: conversationA.id,
      purpose: "main",
      model: "model-a",
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
    });
    await repositories.llmUsage.create({
      ...scopeA,
      conversationId: conversationB.id,
      purpose: "main",
      model: "cross-model",
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
    });
    await expect(repositories.toolLogs.list(scopeA))
      .resolves.toEqual([expect.objectContaining({ tool_name: "tool-a" })]);
    await expect(repositories.toolLogs.list(scopeB)).resolves.toEqual([]);
    await expect(repositories.llmUsage.list(scopeA))
      .resolves.toEqual([expect.objectContaining({ model: "model-a" })]);
    await expect(repositories.llmUsage.list(scopeB)).resolves.toEqual([]);

    await pool.query(
      "UPDATE digital_agents SET status = 'archived' WHERE user_id = $1 AND id = $2",
      [USER_ID, AGENT_A],
    );
    await repositories.personalData.clear(USER_ID);

    const agents = await pool.query(
      `SELECT id, slug, display_name, status, is_default, inherits_user_resources
       FROM digital_agents
       WHERE user_id = $1`,
      [USER_ID],
    );
    expect(agents.rows).toEqual([{
      id: AGENT_A,
      slug: "digitalmate",
      display_name: "DigitalMate",
      status: "active",
      is_default: true,
      inherits_user_resources: true,
    }]);
    await expect(repositories.agents.getDefault(USER_ID)).resolves.toMatchObject({
      id: AGENT_A,
      status: "active",
      slug: "digitalmate",
      displayName: "DigitalMate",
    });
    await expect(repositories.agentSettings.get(scopeA)).resolves.toMatchObject({
      persona: defaultSettings.persona,
      modelRouting: defaultSettings.modelRouting,
      modelRoutingOverride: {},
    });
    await expect(repositories.conversations.list(scopeA)).resolves.toEqual([]);
    await expect(repositories.memories.list(scopeA)).resolves.toEqual([]);
    await expect(repositories.taskArtifacts.list(scopeA)).resolves.toEqual([]);
  }, 30_000);
});

async function collectAgentOutput(
  scope: AgentScope,
  requests: LlmStreamInput[],
  repositories: ReturnType<typeof createRepositories>,
) {
  for await (const chunk of runAgent({
    ...scope,
    conversationId: "20000000-0000-4000-8000-000000000001",
    message: "resource matrix",
    history: [],
    persona: defaultSettings.persona,
    llm: {
      async *stream(request) {
        requests.push(request);
        yield { type: "text" as const, text: "ok" };
      },
      async completeText() {
        return "ok";
      },
    },
    model: "model-main",
    repositories: {
      memories: { findRelevant: async () => [] },
      skills: repositories.skills,
      toolRegistrations: repositories.toolRegistrations,
      toolLogs: { create: async () => undefined },
    },
    search: {
      run: async () => ({ summary: "", results: [] }),
    },
  })) {
    // Exhaust the generator so the captured request covers prompt and tools.
    void chunk;
  }
}

function goalContract(label: string) {
  return {
    objective: `${label} objective`,
    successCriteria: [{ id: "done", description: "done", verification: "manual" }],
    cadence: { mode: "continuous" as const },
    scope: { allowedTools: [], forbidden: [] },
    budget: { maxRounds: 2, maxTokens: 1_000 },
    stopConditions: { maxNoProgressRounds: 1, escalation: [] },
    deliverable: { format: "report" as const },
  };
}

async function installSchema(databasePool: Pool) {
  let schema = await readFile(path.join(process.cwd(), "src/server/db/schema.sql"), "utf8");
  schema = schema
    .replace("CREATE EXTENSION IF NOT EXISTS vector;", "")
    .replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", "")
    .replaceAll("vector(1536)", "vector")
    .replace(/^CREATE INDEX IF NOT EXISTS idx_memory_entries_embedding.*$/m, "");
  await databasePool.query(`
    CREATE DOMAIN vector AS text;
    CREATE FUNCTION vector_cosine_distance(vector, vector)
      RETURNS double precision LANGUAGE sql IMMUTABLE AS $$ SELECT 1.0 $$;
    CREATE OPERATOR <=> (
      LEFTARG = vector,
      RIGHTARG = vector,
      PROCEDURE = vector_cosine_distance
    );
  `);
  await databasePool.query(schema);
}

async function seedAgents(databasePool: Pool) {
  await databasePool.query(
    "INSERT INTO users (id, display_name) VALUES ($1, 'Scope User')",
    [USER_ID],
  );
  await databasePool.query(
    `INSERT INTO settings (user_id, persona, proactivity, model_routing, cadence, search)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      USER_ID,
      defaultSettings.persona,
      defaultSettings.proactivity,
      defaultSettings.modelRouting,
      defaultSettings.cadence,
      defaultSettings.search,
    ],
  );
  await databasePool.query(
    `INSERT INTO digital_agents (
       id, user_id, slug, display_name, status, is_default, inherits_user_resources
     )
     VALUES
       ($1, $3, 'legacy-default', 'Legacy Default', 'active', true, false),
       ($2, $3, 'digitalmate', 'Second Agent', 'active', false, true)`,
    [AGENT_A, AGENT_B, USER_ID],
  );
  for (const agentId of [AGENT_A, AGENT_B]) {
    await databasePool.query(
      `INSERT INTO agent_settings (
         user_id, agent_id, persona, proactivity, cadence, search
       )
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        USER_ID,
        agentId,
        defaultSettings.persona,
        defaultSettings.proactivity,
        defaultSettings.cadence,
        defaultSettings.search,
      ],
    );
  }
}

async function reservePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("database_port_unavailable");
  server.close();
  await once(server, "close");
  return address.port;
}
