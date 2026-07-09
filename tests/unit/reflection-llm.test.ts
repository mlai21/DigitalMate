import { describe, expect, it } from "vitest";
import { generateReflectionWithLlm } from "@/server/evolution/reflection";
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

describe("generateReflectionWithLlm", () => {
  it("parses a structured reflection from the model output", async () => {
    const llm = completeLlm(
      '{"positives":["回应节奏自然"],"negatives":["有一次误解了用户意图"],"suggestions":["先复述再给结论"]}',
    );

    const reflection = await generateReflectionWithLlm({ llm, model: "light", digest: "用户：..." });

    expect(reflection).toEqual({
      positives: ["回应节奏自然"],
      negatives: ["有一次误解了用户意图"],
      suggestions: ["先复述再给结论"],
      skill: null,
    });
  });

  it("parses a recurring task pattern into a skill proposal", async () => {
    const llm = completeLlm(
      JSON.stringify({
        positives: ["帮用户整理了三次日报"],
        negatives: [],
        suggestions: [],
        skill: { name: "日报整理流程", trigger: "用户需要把当天更新整理成日报", steps: ["收集更新", "按项目分组", "输出日报"] },
      }),
    );

    const reflection = await generateReflectionWithLlm({ llm, model: "light", digest: "用户：..." });

    expect(reflection?.skill).toEqual({
      name: "日报整理流程",
      trigger: "用户需要把当天更新整理成日报",
      steps: ["收集更新", "按项目分组", "输出日报"],
    });
  });

  it("drops malformed skill proposals but keeps the reflection", async () => {
    const llm = completeLlm(
      JSON.stringify({ positives: ["ok"], negatives: [], suggestions: [], skill: { name: "太少步骤", trigger: "x", steps: ["只有一步"] } }),
    );

    const reflection = await generateReflectionWithLlm({ llm, model: "light", digest: "..." });

    expect(reflection?.positives).toEqual(["ok"]);
    expect(reflection?.skill).toBeNull();
  });

  it("returns null on unusable output so callers can fall back", async () => {
    expect(await generateReflectionWithLlm({ llm: completeLlm("我在。"), model: "light", digest: "..." })).toBeNull();
    expect(
      await generateReflectionWithLlm({ llm: completeLlm('{"positives":[],"negatives":[],"suggestions":[]}'), model: "light", digest: "..." }),
    ).toBeNull();
  });

  it("caps each dimension at three entries", async () => {
    const llm = completeLlm(
      JSON.stringify({ positives: ["a", "b", "c", "d", "e"], negatives: [], suggestions: [] }),
    );

    const reflection = await generateReflectionWithLlm({ llm, model: "light", digest: "..." });

    expect(reflection?.positives).toEqual(["a", "b", "c"]);
  });
});
