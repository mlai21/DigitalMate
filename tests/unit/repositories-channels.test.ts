import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createRepositories } from "@/server/db/repositories";

describe("channel repository", () => {
  it("counts recent messages in one external conversation", async () => {
    const query = vi.fn(async (sql: unknown, params?: unknown[]) => {
      expect(String(sql)).toContain("FROM channel_messages");
      expect(String(sql)).toContain("occurred_at >= $5");
      expect(params).toEqual(["user-1", "agent-1", "telegram", "group-1", new Date("2026-07-05T10:00:00+08:00")]);
      return { rows: [{ count: 6 }] };
    });
    const repositories = createRepositories({ query } as unknown as Pool);

    await expect(
      repositories.channels.recentMessageCount(
        { userId: "user-1", agentId: "agent-1" },
        "telegram",
        "group-1",
        new Date("2026-07-05T10:00:00+08:00"),
      ),
    ).resolves.toBe(6);
  });
});
