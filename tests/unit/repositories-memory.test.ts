import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createRepositories } from "@/server/db/repositories";

describe("memory repository", () => {
  const scope = { userId: "user-1", agentId: "agent-1" };
  it("queues only user-authored messages for memory extraction", async () => {
    const query = vi.fn(async (sql: unknown, params?: unknown) => {
      void sql;
      void params;
      return { rows: [] };
    });
    const repositories = createRepositories({ query } as unknown as Pool);

    await repositories.messages.unprocessedForMemory(scope, 10);

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

    await repositories.memories.createMany(scope, "message-1", [
      { kind: "profile", content: "用户喜欢周末爬山", confidence: 0.72 },
    ]);

    const [sql, params] = query.mock.calls[0] ?? [];
    expect(String(sql)).toContain("embedding");
    expect(String(sql)).toContain("$7::vector");
    expect(String(sql)).toContain("expires_at");
    expect(params).toHaveLength(8);
    expect((params as unknown[])[6]).toMatch(/^\[/);
    expect((params as unknown[])[7]).toBeNull();
  });

  it("aborts a half-open embedding before creating any memory row", async () => {
    vi.stubEnv("EMBEDDING_BASE_URL", "https://api.example.com/v1");
    vi.stubEnv("EMBEDDING_MODEL", "text-embedding-3-small");
    let fetchSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      fetchSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        if (fetchSignal) {
          fetchSignal.addEventListener("abort", () => reject(fetchSignal?.reason), { once: true });
        } else {
          reject(new Error("missing_embedding_signal"));
        }
      });
    }));
    const query = vi.fn(async (sql: unknown, params?: unknown) => {
      void sql;
      void params;
      return { rows: [] };
    });
    const repositories = createRepositories({ query } as unknown as Pool);
    const abortController = new AbortController();

    try {
      const operation = repositories.memories.createMany(scope, "message-1", [
        { kind: "profile", content: "用户喜欢周末爬山", confidence: 0.72 },
      ], abortController.signal);
      abortController.abort(new Error("memory_embedding_timeout"));

      await expect(operation).rejects.toThrow("memory_embedding_timeout");
      expect(fetchSignal).toBe(abortController.signal);
      expect(query).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("fuses vector similarity with lexical relevance for recall", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ id: "semantic", content: "用户喜欢户外徒步", created_at: new Date("2026-06-01T00:00:00Z"), similarity: 0.9 }],
      })
      .mockResolvedValueOnce({
        rows: [
          { id: "keyword", content: "用户喜欢周末爬山", created_at: new Date("2026-06-02T00:00:00Z") },
          { id: "semantic", content: "用户喜欢户外徒步", created_at: new Date("2026-06-01T00:00:00Z") },
          { id: "irrelevant", content: "用户喜欢咖啡", created_at: new Date("2026-06-03T00:00:00Z") },
        ],
      });
    const repositories = createRepositories({ query } as unknown as Pool);

    const memories = await repositories.memories.findRelevant(scope, "周末去哪爬山");

    expect(String(query.mock.calls[0]?.[0])).toContain("embedding <=> $3::vector");
    expect(String(query.mock.calls[0]?.[0])).toContain("AS similarity");
    expect(String(query.mock.calls[1]?.[0])).toContain("ORDER BY created_at DESC LIMIT 80");
    // High vector similarity outranks a weak lexical hit; zero-score memories are dropped.
    expect(memories.map((memory) => memory.id)).toEqual(["semantic", "keyword"]);
  });

  it("scopes direct-message recall to one channel participant", async () => {
    const query = vi.fn(async (sql: unknown, params?: unknown) => {
      void sql;
      void params;
      return { rows: [] };
    });
    const repositories = createRepositories({ query } as unknown as Pool);

    await repositories.memories.findRelevantInContext(
      scope,
      "direct:connection-1:sales-1",
      "客户预算",
    );

    expect(String(query.mock.calls[0]?.[0])).toContain("context_key = $3");
    expect(String(query.mock.calls[0]?.[0])).toContain(
      "embedding <=> $4::vector",
    );
    expect(query.mock.calls[0]?.[1]).toEqual([
      scope.userId,
      scope.agentId,
      "direct:connection-1:sales-1",
      expect.stringMatching(/^\[/),
    ]);
    expect(String(query.mock.calls[1]?.[0])).toContain("context_key = $3");
  });

  it("persists the source conversation context on extracted memories", async () => {
    const query = vi.fn(async (sql: unknown, params?: unknown) => {
      void sql;
      void params;
      return { rows: [] };
    });
    const repositories = createRepositories({ query } as unknown as Pool);

    await repositories.memories.createMany(scope, "message-1", [
      { kind: "profile", content: "销售偏好先讨论预算", confidence: 0.8 },
    ]);

    expect(String(query.mock.calls[0]?.[0])).toContain("context_key");
    expect(String(query.mock.calls[0]?.[0])).toContain(
      "JOIN conversations AS source_conversation",
    );
    expect(String(query.mock.calls[0]?.[0])).toContain(
      "IS NOT DISTINCT FROM",
    );
  });

  it("uses the stable channel context key to reopen a conversation", async () => {
    const existing = {
      id: "conversation-1",
      user_id: scope.userId,
      agent_id: scope.agentId,
      channel: "dingtalk",
      title: "旧标题",
      project_id: null,
      pinned: false,
      archived_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const query = vi.fn(async (sql: unknown, params?: unknown) => {
      void sql;
      void params;
      return { rows: [existing] };
    });
    const repositories = createRepositories({ query } as unknown as Pool);

    await repositories.channels.ensureConversation(scope, {
      channel: "dingtalk",
      externalConversationId: "cid-direct-1",
      externalMessageId: "message-1",
      senderId: "sales-1",
      chatType: "direct",
      contextKey: "direct:connection-1:sales-1",
      text: "你好",
      occurredAt: new Date(),
    });

    expect(String(query.mock.calls[0]?.[0])).toContain("context_key = $3");
    expect(query.mock.calls[0]?.[1]).toEqual([
      scope.userId,
      scope.agentId,
      "direct:connection-1:sales-1",
    ]);
  });

  it("filters expired memories from recall and admin lists", async () => {
    const query = vi.fn(async (sql: unknown, params?: unknown) => {
      void sql;
      void params;
      return { rows: [] };
    });
    const repositories = createRepositories({ query } as unknown as Pool);

    await repositories.memories.findRelevant(scope, "周末去哪爬山");
    await repositories.memories.list(scope);

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
      await repositories.memories.createMany(scope, "message-1", [
        { kind: "episodic", content: "用户下周五要交报销", confidence: 0.68 },
        { kind: "profile", content: "用户喜欢周末爬山", confidence: 0.72 },
      ]);

      const episodicParams = query.mock.calls[0]?.[1] as unknown[];
      const profileParams = query.mock.calls[1]?.[1] as unknown[];
      expect(episodicParams[7]).toEqual(new Date("2027-01-01T00:00:00Z"));
      expect(profileParams[7]).toBeNull();
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

    await repositories.memories.update(scope, "memory-1", {
      kind: "profile",
      content: "用户喜欢露营",
      confidence: 0.8,
    });

    const [sql, params] = query.mock.calls[0] ?? [];
    expect(String(sql)).toContain("embedding = $7::vector");
    expect(params).toHaveLength(7);
    expect((params as unknown[])[6]).toMatch(/^\[/);
  });
});
