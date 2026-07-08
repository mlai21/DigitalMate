import { describe, expect, it } from "vitest";
import { extractMemoriesWithLlm } from "@/server/agent/memory-extraction";
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

describe("extractMemoriesWithLlm", () => {
  it("parses structured memories from the light model output", async () => {
    const llm = completeLlm(
      '这是结果：[{"kind":"profile","content":"用户喜欢周末爬山","confidence":0.85},{"kind":"episodic","content":"用户下周五要交报销","confidence":0.7}]',
    );

    const memories = await extractMemoriesWithLlm({ llm, model: "light", text: "我喜欢周末爬山，下周五要交报销" });

    expect(memories).toEqual([
      { kind: "profile", content: "用户喜欢周末爬山", confidence: 0.85 },
      { kind: "episodic", content: "用户下周五要交报销", confidence: 0.7 },
    ]);
  });

  it("drops sensitive facts even if the model extracts them", async () => {
    const llm = completeLlm('[{"kind":"profile","content":"用户的手机号是 13800138000","confidence":0.9}]');

    const memories = await extractMemoriesWithLlm({ llm, model: "light", text: "我的手机号是 13800138000" });

    expect(memories).toEqual([]);
  });

  it("falls back to rule-based extraction on unusable model output", async () => {
    const llm = completeLlm("我在。你刚说的我记下了。");

    const memories = await extractMemoriesWithLlm({ llm, model: "light", text: "我喜欢周末爬山" });

    expect(memories).toEqual([{ kind: "profile", content: "用户喜欢周末爬山", confidence: 0.72 }]);
  });

  it("falls back when the model call throws", async () => {
    const llm: LlmClient = {
      async *stream() {
        yield { type: "text", text: "" };
      },
      async completeText() {
        throw new Error("provider down");
      },
    };

    const memories = await extractMemoriesWithLlm({ llm, model: "light", text: "我不喜欢加班" });

    expect(memories).toEqual([{ kind: "profile", content: "用户不喜欢加班", confidence: 0.72 }]);
  });
});
