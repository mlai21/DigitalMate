import { describe, expect, it, vi } from "vitest";
import { recordTurnReview, reviewTurnWithLlm } from "@/server/evolution/turn-review";
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

describe("reviewTurnWithLlm", () => {
  it("returns behavior corrections and a skill draft when the turn is worth recording", async () => {
    const llm = completeLlm(
      JSON.stringify({
        worthRecording: true,
        positives: [],
        negatives: ["先给了冗长解释，用户要的是结论"],
        suggestions: ["先给结论再解释"],
        skill: {
          name: "周报整理流程",
          trigger: "用户需要把零散更新整理成周报",
          steps: ["收集本周更新", "按项目分组", "输出三段式周报"],
        },
      }),
    );

    const result = await reviewTurnWithLlm({ llm, model: "light", userText: "帮我整理周报", assistantText: "好的……" });

    expect(result?.reflection?.suggestions).toEqual(["先给结论再解释"]);
    expect(result?.skillDraft?.name).toBe("周报整理流程");
    expect(result?.skillDraft?.status).toBe("pending");
    expect(result?.skillDraft?.content).toContain("按项目分组");
  });

  it("returns null for ordinary chit-chat turns", async () => {
    const llm = completeLlm('{"worthRecording":false,"positives":[],"negatives":[],"suggestions":[],"skill":null}');

    const result = await reviewTurnWithLlm({ llm, model: "light", userText: "今天天气不错", assistantText: "是啊" });

    expect(result).toBeNull();
  });

  it("returns null on unusable model output", async () => {
    const llm = completeLlm("我在。你刚说的我记下了。");

    const result = await reviewTurnWithLlm({ llm, model: "light", userText: "你好", assistantText: "你好呀" });

    expect(result).toBeNull();
  });
});

describe("recordTurnReview", () => {
  it("persists the reflection and skill draft with pending status", async () => {
    const reflections = { create: vi.fn() };
    const skills = { create: vi.fn() };
    const llm = completeLlm(
      JSON.stringify({
        worthRecording: true,
        positives: [],
        negatives: [],
        suggestions: ["确认输入格式再执行"],
        skill: { name: "CSV 清洗流程", trigger: "用户上传脏数据", steps: ["检查编码", "清洗空值"] },
      }),
    );

    await recordTurnReview(
      { reflections, skills },
      { userId: "u1", conversationId: "c1", llm, model: "light", userText: "清洗数据", assistantText: "完成了" },
    );

    expect(reflections.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        sourceWindow: { event: "turn_review", conversationId: "c1" },
      }),
    );
    expect(skills.create).toHaveBeenCalledWith("u1", expect.objectContaining({ status: "pending" }));
  });

  it("writes nothing when the review is not worth recording", async () => {
    const reflections = { create: vi.fn() };
    const skills = { create: vi.fn() };
    const llm = completeLlm('{"worthRecording":false,"positives":[],"negatives":[],"suggestions":[],"skill":null}');

    const result = await recordTurnReview(
      { reflections, skills },
      { userId: "u1", conversationId: "c1", llm, model: "light", userText: "哈哈", assistantText: "哈哈" },
    );

    expect(result).toBeNull();
    expect(reflections.create).not.toHaveBeenCalled();
    expect(skills.create).not.toHaveBeenCalled();
  });
});
