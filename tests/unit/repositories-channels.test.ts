import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createRepositories } from "@/server/db/repositories";

describe("channel repository", () => {
  it("counts recent messages in one external conversation", async () => {
    const query = vi.fn(async (sql: unknown, params?: unknown[]) => {
      expect(String(sql)).toContain("FROM channel_messages");
      expect(String(sql)).toContain("occurred_at >= $3");
      expect(params).toEqual(["telegram", "group-1", new Date("2026-07-05T10:00:00+08:00")]);
      return { rows: [{ count: 6 }] };
    });
    const repositories = createRepositories({ query } as unknown as Pool);

    await expect(
      repositories.channels.recentMessageCount("telegram", "group-1", new Date("2026-07-05T10:00:00+08:00")),
    ).resolves.toBe(6);
  });
});
