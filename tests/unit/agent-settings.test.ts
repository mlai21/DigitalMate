import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { AgentScope } from "@/server/agents/types";
import { createAgentSettingsRepository } from "@/server/settings/agent-settings";

const scope = { userId: "user-1", agentId: "agent-1" } satisfies AgentScope;

describe("agent settings", () => {
  it("merges only explicit per-agent model routing override keys", async () => {
    const query = vi.fn(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes("INSERT INTO agent_settings")) return { rows: [] };
      return {
        rows: [{
          persona: { name: "Mate", style: "warm", emojiHabit: "rare" },
          proactivity: { maxPerDay: 1 },
          cadence: { maxSegments: 3 },
          search: { aggressiveness: "conservative" },
          model_routing_override: { light: "agent-light" },
          revision: 4,
          model_routing: { main: "user-main", light: "user-light" },
        }],
      };
    });
    const repository = createAgentSettingsRepository({ query } as unknown as Pool);

    await expect(repository.get(scope)).resolves.toMatchObject({
      proactivity: { quietStart: "23:00", maxPerDay: 1 },
      modelRouting: { main: "user-main", light: "agent-light" },
      revision: 4,
    });
    expect(String(query.mock.calls[0]?.[0])).not.toContain("LEFT JOIN settings");
    const select = String(query.mock.calls.at(-1)?.[0]);
    expect(select).toMatch(/agent_settings\.user_id\s*=\s*\$1[\s\S]*agent_settings\.agent_id\s*=\s*\$2/);
  });

  it("updates with an optimistic revision inside the same scope", async () => {
    const query = vi.fn(async () => ({ rows: [{ revision: 5 }] }));
    const repository = createAgentSettingsRepository({ query } as unknown as Pool);

    await expect(repository.update(scope, {
      persona: { name: "Mate", style: "warm", emojiHabit: "rare" },
      proactivity: { quietStart: "23:00", quietEnd: "08:00", minIntervalMinutes: 30, maxPerHour: 2, maxPerDay: 3 },
      cadence: { responseDelayMs: 480, segmentDelayMs: 240, maxSegments: 5 },
      search: { aggressiveness: "conservative" },
      modelRoutingOverride: { main: "agent-main" },
      expectedRevision: 4,
    })).resolves.toBe(5);

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/WHERE user_id = \$1[\s\S]*AND agent_id = \$2[\s\S]*AND revision = \$8/);
    expect(params.slice(0, 2)).toEqual(["user-1", "agent-1"]);
    expect(params[7]).toBe(4);
  });
});
