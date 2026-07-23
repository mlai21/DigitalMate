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
  it("keeps multi-agent mutations disabled behind one stable capability error", () => {
    expect(AGENT_FEATURES.multiAgent).toBe(false);
    for (const action of ["create", "clone", "import", "delete"] as const) {
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

  it("inherits user resources only for the default agent unless an explicit grant overrides it", async () => {
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
      async () => [],
    );
    const repository = {
      listActive: vi.fn(async () => [
        { ...baseAgent, id: "agent-a", isDefault: true },
        { ...baseAgent, id: "agent-b", isDefault: false },
      ]),
      listResourceGrants,
    } as unknown as AgentRepository;
    const service = createAgentService(repository);

    await expect(service.canUseUserResource(scopeA, "skill", "skill-1")).resolves.toBe(true);
    await expect(service.canUseUserResource(scopeB, "skill", "skill-1")).resolves.toBe(false);

    listResourceGrants.mockResolvedValueOnce([{
      userId: "user-1",
      agentId: "agent-b",
      resourceType: "skill",
      resourceId: "skill-1",
      enabled: true,
    }]);
    await expect(service.canUseUserResource(scopeB, "skill", "skill-1")).resolves.toBe(true);

    listResourceGrants.mockResolvedValueOnce([{
      userId: "user-1",
      agentId: "agent-a",
      resourceType: "skill",
      resourceId: "skill-1",
      enabled: false,
    }]);
    await expect(service.canUseUserResource(scopeA, "skill", "skill-1")).resolves.toBe(false);
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
