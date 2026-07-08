import { describe, expect, it, vi } from "vitest";
import {
  consolidateMemoryKind,
  MEMORY_CAPACITY_LIMITS,
  pickPruneCandidates,
} from "@/server/evolution/memory-consolidation";
import type { LlmClient } from "@/server/llm/types";

function completeLlm(reply: string): LlmClient {
  return {
    async *stream() {
      yield { type: "text", text: reply };
    },
    async completeText() {
      return reply;
    },
  };
}

function buildEntries(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `memory-${index}`,
    content: `用户偏好 ${index}`,
    confidence: 0.5 + (index % 5) * 0.1,
    createdAt: new Date(Date.UTC(2026, 0, 1 + index)),
  }));
}

function buildRepositories(entries: ReturnType<typeof buildEntries>) {
  return {
    memories: {
      listActiveByKind: vi.fn().mockResolvedValue(entries),
      softDeleteMany: vi.fn().mockResolvedValue(undefined),
      createMany: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe("consolidateMemoryKind", () => {
  it("does nothing while the layer is under its cap", async () => {
    const repositories = buildRepositories(buildEntries(3));

    const outcome = await consolidateMemoryKind({
      repositories,
      llm: completeLlm("[]"),
      model: "light",
      userId: "u1",
      kind: "profile",
      cap: 5,
    });

    expect(outcome).toBeNull();
    expect(repositories.memories.softDeleteMany).not.toHaveBeenCalled();
  });

  it("merges over-cap entries with the light model and rewrites the layer", async () => {
    const entries = buildEntries(6);
    const repositories = buildRepositories(entries);
    const llm = completeLlm('[{"content":"用户偏好合并后 A","confidence":0.9},{"content":"用户偏好合并后 B","confidence":0.8}]');

    const outcome = await consolidateMemoryKind({ repositories, llm, model: "light", userId: "u1", kind: "profile", cap: 4 });

    expect(outcome).toEqual({ kind: "profile", removedCount: 6, mergedCount: 2, strategy: "llm_merge" });
    expect(repositories.memories.softDeleteMany).toHaveBeenCalledWith(
      "u1",
      entries.map((entry) => entry.id),
    );
    expect(repositories.memories.createMany).toHaveBeenCalledWith("u1", null, [
      { content: "用户偏好合并后 A", confidence: 0.9, kind: "profile" },
      { content: "用户偏好合并后 B", confidence: 0.8, kind: "profile" },
    ]);
  });

  it("prunes the oldest low-confidence entries when the model output is unusable", async () => {
    const entries = buildEntries(6);
    const repositories = buildRepositories(entries);

    const outcome = await consolidateMemoryKind({
      repositories,
      llm: completeLlm("抱歉，我不明白。"),
      model: "light",
      userId: "u1",
      kind: "profile",
      cap: 4,
    });

    expect(outcome?.strategy).toBe("prune_oldest");
    expect(outcome?.removedCount).toBe(2);
    expect(repositories.memories.createMany).not.toHaveBeenCalled();
  });

  it("defines caps only for resident layers", () => {
    expect(MEMORY_CAPACITY_LIMITS.profile).toBeGreaterThan(0);
    expect(MEMORY_CAPACITY_LIMITS.agent_self).toBeGreaterThan(0);
    expect(MEMORY_CAPACITY_LIMITS.episodic).toBeUndefined();
  });
});

describe("pickPruneCandidates", () => {
  it("prefers dropping low-confidence, older entries", () => {
    const entries = [
      { id: "a", content: "a", confidence: 0.9, createdAt: new Date("2026-01-01") },
      { id: "b", content: "b", confidence: 0.5, createdAt: new Date("2026-02-01") },
      { id: "c", content: "c", confidence: 0.5, createdAt: new Date("2026-01-01") },
    ];

    const pruned = pickPruneCandidates(entries, 2);

    expect(pruned.map((entry) => entry.id)).toEqual(["c", "b"]);
  });
});
