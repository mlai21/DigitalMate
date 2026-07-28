import { describe, expect, it } from "vitest";

import { chooseReactionIntent } from "@/server/agent/reaction-intent";
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

describe("chooseReactionIntent", () => {
  it("reads the reaction out of the model answer", async () => {
    const reaction = await chooseReactionIntent({
      llm: completeLlm('{"reaction":"good_question"}'),
      model: "light",
      text: "为什么 pgvector 的 HNSW 索引比 IVFFlat 快？",
    });

    expect(reaction).toBe("good_question");
  });

  it("tolerates prose around the JSON answer", async () => {
    const reaction = await chooseReactionIntent({
      llm: completeLlm('好的，我的判断是：{"reaction":"acknowledged"} 。'),
      model: "light",
      text: "明天帮我把周报整理一下",
    });

    expect(reaction).toBe("acknowledged");
  });

  it("leaves no reaction for small talk", async () => {
    const reaction = await chooseReactionIntent({
      llm: completeLlm('{"reaction":"none"}'),
      model: "light",
      text: "早上好",
    });

    expect(reaction).toBeNull();
  });

  it("never picks the runtime's own busy marker", async () => {
    const reaction = await chooseReactionIntent({
      llm: completeLlm('{"reaction":"pending"}'),
      model: "light",
      text: "帮我看看这个报错",
    });

    expect(reaction).toBeNull();
  });

  it("leaves no reaction when the model is unusable", async () => {
    const llm: LlmClient = {
      async *stream() {
        yield { type: "text", text: "" };
      },
      async completeText() {
        throw new Error("provider down");
      },
    };

    await expect(chooseReactionIntent({
      llm,
      model: "light",
      text: "帮我看看这个报错",
    })).resolves.toBeNull();
  });

  it("skips the model call for an empty message", async () => {
    let calls = 0;
    const llm: LlmClient = {
      async *stream() {
        yield { type: "text", text: "" };
      },
      async completeText() {
        calls += 1;
        return '{"reaction":"acknowledged"}';
      },
    };

    await expect(chooseReactionIntent({
      llm,
      model: "light",
      text: "   ",
    })).resolves.toBeNull();
    expect(calls).toBe(0);
  });
});
