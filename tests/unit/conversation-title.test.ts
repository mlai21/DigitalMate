import { describe, expect, it } from "vitest";
import { fallbackConversationTitle, generateConversationTitle } from "@/server/agent/conversation-title";
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

describe("generateConversationTitle", () => {
  it("uses the light model output as the title", async () => {
    const title = await generateConversationTitle({
      llm: completeLlm("北京周末天气"),
      model: "light",
      userText: "帮我查一下北京周末的天气",
      assistantText: "周末北京晴……",
    });

    expect(title).toBe("北京周末天气");
  });

  it("falls back to a truncated user message when the model fails", async () => {
    const llm: LlmClient = {
      async *stream() {
        yield { type: "text", text: "" };
      },
      async completeText() {
        throw new Error("provider down");
      },
    };

    const title = await generateConversationTitle({
      llm,
      model: "light",
      userText: "这是一条特别长的用户消息，用来验证降级截断行为是否正确工作",
      assistantText: "……",
    });

    expect(title).toBe("这是一条特别长的用户消息，用来验证降级截…");
  });
});

describe("fallbackConversationTitle", () => {
  it("keeps short messages intact", () => {
    expect(fallbackConversationTitle("你好呀")).toBe("你好呀");
  });

  it("returns the default for empty input", () => {
    expect(fallbackConversationTitle("   ")).toBe("新的对话");
  });
});
