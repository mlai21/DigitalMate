import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  AGENT_FEATURES,
  assertMultiAgentMutationAllowed,
} from "@/server/agents/features";
import {
  createAgentRepository,
  type AgentRepository,
} from "@/server/agents/repository";
import {
  createAgentService,
  resolveDefaultAgentScope,
} from "@/server/agents/service";
import type { AgentResourceGrant, AgentScope } from "@/server/agents/types";
import { createRepositories } from "@/server/db/repositories";

const scopeA = { userId: "user-1", agentId: "agent-a" } satisfies AgentScope;
const scopeB = { userId: "user-1", agentId: "agent-b" } satisfies AgentScope;

describe("AgentScope", () => {
  it("allows only the controlled Alvin creation mutation", () => {
    expect(AGENT_FEATURES.multiAgent).toBe(true);
    expect(() => assertMultiAgentMutationAllowed("create")).not.toThrow();
    for (const action of ["clone", "import", "delete"] as const) {
      expect(() => assertMultiAgentMutationAllowed(action)).toThrow(
        expect.objectContaining({
          status: 501,
          code: "capability_disabled",
          details: { capability: `multi_agent_${action}` },
        }),
      );
    }
  });

  it("resolves the default agent and lists active agents without process-global state", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{
          id: "agent-a",
          user_id: "user-1",
          slug: "digitalmate",
          display_name: "DigitalMate",
          persona: {},
          status: "active",
          is_default: true,
          inherits_user_resources: true,
          created_at: new Date("2026-07-21T00:00:00Z"),
          updated_at: new Date("2026-07-21T00:00:00Z"),
        }],
      })
      .mockResolvedValueOnce({ rows: [] });
    const repository = createAgentRepository({ query } as unknown as Pool);
    const service = createAgentService(repository);

    await expect(service.getDefaultScope("user-1")).resolves.toEqual(scopeA);
    await expect(service.listActiveScopes()).resolves.toEqual([]);
    expect(String(query.mock.calls[0]?.[0])).toContain("user_id = $1");
    expect(String(query.mock.calls[0]?.[0])).toContain("is_default = true");
    expect(String(query.mock.calls[1]?.[0])).toContain("status = 'active'");
  });

  it("creates Alvin with six isolated MVP presales skills", async () => {
    const query = vi.fn(async (sql: unknown, params?: unknown) => {
      void sql;
      void params;
      return { rows: [{
        id: "agent-b",
        user_id: "user-1",
        slug: "alvin",
        display_name: "Alvin",
        persona: {},
        status: "active",
        is_default: false,
        inherits_user_resources: false,
        created_at: new Date(),
        updated_at: new Date(),
      }] };
    });
    const repository = createAgentRepository(
      { query } as unknown as Pool,
    );

    await repository.createAlvin("user-1");

    const sql = String(query.mock.calls[0]?.[0]);
    const skills = JSON.parse(
      String((query.mock.calls[0]?.[1] as unknown[])[5]),
    ) as Array<{ name: string }>;
    expect(sql).toContain("jsonb_to_recordset");
    expect(sql).toContain("origin_agent_id");
    expect(skills.map((skill) => skill.name)).toEqual([
      "客户需求发现与商机资格判断",
      "模型 API、RAG 与 Agent 方案架构",
      "容量、性能、成本与 TCO 估算",
      "POC 设计、指标与退出标准",
      "安全治理、风险与异议处理",
      "方案结构与分层表达",
    ]);
  });

  it("rejects a disabled or archived default agent consistently in both resolvers", async () => {
    for (const status of ["disabled", "archived"] as const) {
      const inactiveAgent = {
        id: "agent-a",
        userId: "user-1",
        slug: "digitalmate",
        displayName: "DigitalMate",
        persona: {},
        status,
        isDefault: true,
        inheritsUserResources: true,
        createdAt: new Date("2026-07-21T00:00:00Z"),
        updatedAt: new Date("2026-07-21T00:00:00Z"),
      };
      const repository = {
        ensureDefault: vi.fn(async () => inactiveAgent),
        getDefault: vi.fn(async () => inactiveAgent),
      } as unknown as AgentRepository;

      await expect(createAgentService(repository).getDefaultScope("user-1"))
        .rejects.toThrow("default_agent_not_found");
      await expect(resolveDefaultAgentScope("user-1", repository))
        .rejects.toThrow("default_agent_not_found");
    }
  });

  it("same user's agents cannot read each other's memories", async () => {
    const query = vi.fn(async (sql: unknown, params?: unknown[]) => {
      const text = String(sql);
      if (text.includes("INSERT INTO memory_entries")) return { rows: [] };
      const agentId = params?.[1];
      return {
        rows: [{
          id: agentId === "agent-a" ? "memory-a" : "memory-b",
          user_id: "user-1",
          agent_id: agentId,
          content: agentId === "agent-a" ? "A" : "B",
          kind: "profile",
          confidence: 0.9,
          created_at: new Date("2026-07-21T00:00:00Z"),
          similarity: 1,
        }],
      };
    });
    const repositories = createRepositories({ query } as unknown as Pool);

    await repositories.memories.createMany(scopeA, null, [
      { kind: "profile", content: "A", confidence: 0.9 },
    ]);
    await repositories.memories.createMany(scopeB, null, [
      { kind: "profile", content: "B", confidence: 0.9 },
    ]);
    const memories = await repositories.memories.list(scopeA);

    expect(memories).toEqual([
      expect.objectContaining({ content: "A", agentId: "agent-a" }),
    ]);
    for (const [sql, params] of query.mock.calls as unknown as Array<[unknown, unknown[] | undefined]>) {
      expect(String(sql)).toMatch(/user_id\s*=\s*\$1[\s\S]*agent_id\s*=\s*\$2/);
      expect(params?.slice(0, 2)).toEqual(
        expect.arrayContaining(["user-1", expect.stringMatching(/^agent-/)]),
      );
    }
  });

  it("parent-id lookups still verify both scope fields", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const repositories = createRepositories({ query } as unknown as Pool);

    await repositories.messages.list(scopeA, "conversation-from-agent-b");
    await repositories.goals.get(scopeA, "goal-from-agent-b");

    for (const [sql, params] of query.mock.calls as unknown as Array<[unknown, unknown[] | undefined]>) {
      expect(String(sql)).toMatch(/user_id\s*=\s*\$1[\s\S]*agent_id\s*=\s*\$2/);
      expect(params?.slice(0, 2)).toEqual(["user-1", "agent-a"]);
    }
  });

  it("batches resource authorization and lets explicit grants override each agent's inheritance policy", async () => {
    const baseAgent = {
      userId: "user-1",
      slug: "digitalmate",
      displayName: "DigitalMate",
      persona: {},
      status: "active" as const,
      inheritsUserResources: true,
      createdAt: new Date("2026-07-21T00:00:00Z"),
      updatedAt: new Date("2026-07-21T00:00:00Z"),
    };
    const listResourceGrants = vi.fn<(...args: unknown[]) => Promise<AgentResourceGrant[]>>(
      async (_userId, agentId) => agentId === "agent-b"
        ? [{
            userId: "user-1",
            agentId: "agent-b",
            resourceType: "skill",
            resourceId: "skill-allowed",
            enabled: true,
          }, {
            userId: "user-1",
            agentId: "agent-b",
            resourceType: "skill",
            resourceId: "skill-denied",
            enabled: false,
          }]
        : [{
            userId: "user-1",
            agentId: "agent-a",
            resourceType: "skill",
            resourceId: "skill-denied",
            enabled: false,
          }],
    );
    const repository = {
      getActive: vi.fn(async (scope: AgentScope) => scope.agentId === "agent-a"
        ? { ...baseAgent, id: "agent-a", isDefault: true }
        : {
            ...baseAgent,
            id: "agent-b",
            isDefault: false,
            inheritsUserResources: false,
          }),
      listResourceGrants,
    } as unknown as AgentRepository;
    const service = createAgentService(repository);

    await expect(
      service.listAuthorizedResourceIds(
        scopeA,
        "skill",
        ["skill-inherited", "skill-denied"],
      ),
    ).resolves.toEqual(["skill-inherited"]);
    await expect(
      service.listAuthorizedResourceIds(
        scopeB,
        "skill",
        ["skill-allowed", "skill-denied", "skill-unlisted"],
      ),
    ).resolves.toEqual(["skill-allowed"]);

    expect(repository.getActive).toHaveBeenCalledTimes(2);
    expect(listResourceGrants).toHaveBeenCalledTimes(2);
  });

  it("keeps agent-originated skills inside their owning agent", async () => {
    const query = vi.fn(async (sql: unknown, params?: unknown) => {
      void params;
      return { rows: String(sql).includes("RETURNING id")
        ? [{ id: "skill-alvin" }]
        : [] };
    });
    const repositories = createRepositories({ query } as unknown as Pool);

    await repositories.skills.create(scopeB, {
      name: "Alvin 专属 Skill",
      trigger: "售前方案",
      content: "只属于 Alvin",
      status: "enabled",
      source: "manual",
    });
    await repositories.skills.findByIds(scopeA, ["skill-alvin"]);

    const createSql = String(query.mock.calls[0]?.[0]);
    expect(createSql).toContain("origin_agent_id");
    expect(createSql).toContain("agent_resource_grants");
    expect(query.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(["user-1", "agent-b"]),
    );

    const lookupSql = String(query.mock.calls[1]?.[0]);
    expect(lookupSql).toMatch(
      /skill\.origin_agent_id = agent\.id[\s\S]*skill\.origin_agent_id IS NULL[\s\S]*agent\.is_default/,
    );
  });

  it("uses the shared AgentScope type throughout the run-agent execution contracts", async () => {
    const [runAgentSource, usageSource] = await Promise.all([
      readFile(path.join(process.cwd(), "src/server/agent/run-agent.ts"), "utf8"),
      readFile(path.join(process.cwd(), "src/server/llm/usage.ts"), "utf8"),
    ]);

    expect(runAgentSource).toContain('import type { AgentScope } from "@/server/agents/types"');
    expect(runAgentSource).not.toMatch(/scope:\s*\{\s*userId:\s*string;\s*agentId:\s*string\s*\}/);
    expect(runAgentSource).toMatch(/export type RunAgentInput = AgentScope & \{/);
    expect(runAgentSource).toMatch(/export type ToolLogInput = AgentScope & \{/);
    expect(usageSource).toContain('import type { AgentScope } from "@/server/agents/types"');
    expect(usageSource).toMatch(/export type LlmUsageLogInput = AgentScope & \{/);
  });
});
