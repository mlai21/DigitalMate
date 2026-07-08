import { describe, expect, it } from "vitest";
import {
  buildLocalMemoryEmbedding,
  extractRuleBasedMemories,
  formatPgVector,
  rankMemories,
  redactSensitiveMemory,
} from "@/server/agent/memory";

describe("memory rules", () => {
  it("extracts user preference and redacts sensitive ids", () => {
    expect(extractRuleBasedMemories("我喜欢周末爬山")).toEqual([
      { kind: "profile", content: "用户喜欢周末爬山", confidence: 0.72 },
    ]);
    expect(redactSensitiveMemory("我的身份证号是 110101199003070011")).toBeNull();
  });

  it("redacts contact details and credentials from long-term memory", () => {
    expect(redactSensitiveMemory("我的手机号是 13800138000")).toBeNull();
    expect(redactSensitiveMemory("我的邮箱是 tang@example.com")).toBeNull();
    expect(redactSensitiveMemory("我的 token 是 sk-secret-value")).toBeNull();
    expect(extractRuleBasedMemories("我喜欢电话 13800138000 联系我")).toEqual([]);
  });

  it("redacts separated id and payment numbers from long-term memory", () => {
    expect(redactSensitiveMemory("我的身份证号是 110101 19900307 0011")).toBeNull();
    expect(redactSensitiveMemory("我的银行卡是 6222-0204-1234-5678")).toBeNull();
    expect(extractRuleBasedMemories("我喜欢用银行卡 6222 0204 1234 5678 付款")).toEqual([]);
  });

  it("extracts future events and relationship facts", () => {
    expect(extractRuleBasedMemories("我下周五要交报销")).toEqual([
      { kind: "episodic", content: "用户下周五要交报销", confidence: 0.68 },
    ]);

    expect(extractRuleBasedMemories("我朋友小王喜欢咖啡")).toEqual([
      { kind: "profile", content: "用户的朋友小王喜欢咖啡", confidence: 0.7 },
    ]);
  });

  it("ranks memories by keyword relevance and recency", () => {
    const ranked = rankMemories("周末去哪爬山", [
      { id: "old", content: "用户喜欢咖啡", createdAt: new Date("2026-06-01T00:00:00Z") },
      { id: "hit", content: "用户喜欢周末爬山", createdAt: new Date("2026-06-02T00:00:00Z") },
    ]);

    expect(ranked[0]?.id).toBe("hit");
  });

  it("builds deterministic pgvector-compatible embeddings for memory entries", () => {
    const embedding = buildLocalMemoryEmbedding("用户喜欢周末爬山");

    expect(embedding).toHaveLength(1536);
    expect(buildLocalMemoryEmbedding("用户喜欢周末爬山")).toEqual(embedding);
    expect(formatPgVector(embedding)).toMatch(/^\[-?\d+\.\d{6}(,-?\d+\.\d{6}){1535}\]$/);
  });
});
