import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createRepositories } from "@/server/db/repositories";

describe("reflection repository", () => {
  it("can find the latest reflection by source event", async () => {
    const latest = new Date("2026-07-05T10:00:00Z");
    const query = vi.fn(async (sql: unknown, params?: unknown[]) => {
      expect(sql).toBeDefined();
      expect(params).toBeDefined();
      return { rows: [{ created_at: latest }] };
    });
    const repositories = createRepositories({ query } as unknown as Pool);

    await expect(repositories.reflections.latestBySourceEvent("user-1", "proactive_ignored")).resolves.toBe(latest);

    const [sql, params] = query.mock.calls[0] ?? [];
    expect(String(sql)).toContain("source_window->>'event' = $2");
    expect(params).toEqual(["user-1", "proactive_ignored"]);
  });
});
