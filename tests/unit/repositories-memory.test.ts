import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createRepositories } from "@/server/db/repositories";

describe("memory repository", () => {
  it("queues only user-authored messages for memory extraction", async () => {
    const query = vi.fn(async (sql: unknown, params?: unknown) => {
      void sql;
      void params;
      return { rows: [] };
    });
    const repositories = createRepositories({ query } as unknown as Pool);

    await repositories.messages.unprocessedForMemory(10);

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("role = 'user'");
    expect(sql).not.toContain("role IN ('user', 'assistant')");
  });

  it("stores generated embeddings with new memories", async () => {
    const query = vi.fn(async (sql: unknown, params?: unknown) => {
      void sql;
      void params;
      return { rows: [] };
    });
    const repositories = createRepositories({ query } as unknown as Pool);

    await repositories.memories.createMany("user-1", "message-1", [
      { kind: "profile", content: "用户喜欢周末爬山", confidence: 0.72 },
    ]);

    const [sql, params] = query.mock.calls[0] ?? [];
    expect(String(sql)).toContain("embedding");
    expect(String(sql)).toContain("$6::vector");
    expect(String(sql)).toContain("expires_at");
    expect(params).toHaveLength(7);
    expect((params as unknown[])[5]).toMatch(/^\[/);
    expect((params as unknown[])[6]).toBeNull();
  });

  it("uses pgvector retrieval before lexical fallback", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ id: "semantic", content: "用户喜欢户外徒步", created_at: new Date("2026-06-01T00:00:00Z") }],
      })
      .mockResolvedValueOnce({
        rows: [
          { id: "keyword", content: "用户喜欢周末爬山", created_at: new Date("2026-06-02T00:00:00Z") },
          { id: "semantic", content: "用户喜欢户外徒步", created_at: new Date("2026-06-01T00:00:00Z") },
        ],
      });
    const repositories = createRepositories({ query } as unknown as Pool);

    const memories = await repositories.memories.findRelevant("user-1", "周末去哪爬山");

    expect(String(query.mock.calls[0]?.[0])).toContain("embedding <=> $2::vector");
    expect(String(query.mock.calls[1]?.[0])).toContain("ORDER BY created_at DESC LIMIT 80");
    expect(memories.map((memory) => memory.id)).toEqual(["keyword", "semantic"]);
  });

  it("filters expired memories from recall and admin lists", async () => {
    const query = vi.fn(async (sql: unknown, params?: unknown) => {
      void sql;
      void params;
      return { rows: [] };
    });
    const repositories = createRepositories({ query } as unknown as Pool);

    await repositories.memories.findRelevant("user-1", "周末去哪爬山");
    await repositories.memories.list("user-1");

    expect(String(query.mock.calls[0]?.[0])).toContain("(expires_at IS NULL OR expires_at > now())");
    expect(String(query.mock.calls[1]?.[0])).toContain("(expires_at IS NULL OR expires_at > now())");
    expect(String(query.mock.calls[2]?.[0])).toContain("(expires_at IS NULL OR expires_at > now())");
  });

  it("stores default expiry only for episodic memories", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T00:00:00Z"));
    const query = vi.fn(async (sql: unknown, params?: unknown) => {
      void sql;
      void params;
      return { rows: [] };
    });
    const repositories = createRepositories({ query } as unknown as Pool);

    try {
      await repositories.memories.createMany("user-1", "message-1", [
        { kind: "episodic", content: "用户下周五要交报销", confidence: 0.68 },
        { kind: "profile", content: "用户喜欢周末爬山", confidence: 0.72 },
      ]);

      const episodicParams = query.mock.calls[0]?.[1] as unknown[];
      const profileParams = query.mock.calls[1]?.[1] as unknown[];
      expect(episodicParams[6]).toEqual(new Date("2027-01-01T00:00:00Z"));
      expect(profileParams[6]).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("updates edited memories with refreshed embeddings", async () => {
    const query = vi.fn(async (sql: unknown, params?: unknown) => {
      void sql;
      void params;
      return { rows: [] };
    });
    const repositories = createRepositories({ query } as unknown as Pool);

    await repositories.memories.update("user-1", "memory-1", {
      kind: "profile",
      content: "用户喜欢露营",
      confidence: 0.8,
    });

    const [sql, params] = query.mock.calls[0] ?? [];
    expect(String(sql)).toContain("embedding = $6::vector");
    expect(params).toHaveLength(6);
    expect((params as unknown[])[5]).toMatch(/^\[/);
  });
});
