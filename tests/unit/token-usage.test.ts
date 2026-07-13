import { describe, expect, it } from "vitest";
import { estimateMessagesTokenUsage, estimateTokenCount, summarizeUsageLogs } from "@/server/llm/usage";

describe("LLM usage helpers", () => {
  it("estimates mixed Chinese and ASCII text tokens", () => {
    expect(estimateTokenCount("你好 DigitalMate")).toBeGreaterThanOrEqual(4);
    expect(estimateTokenCount("")).toBe(0);
  });

  it("summarizes usage logs for the admin dashboard", () => {
    expect(
      summarizeUsageLogs([
        { model: "claude-opus-4-8", inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        { model: "gemini-3-5-flash-openai", inputTokens: 4, outputTokens: 6, totalTokens: 10 },
      ]),
    ).toEqual({
      requestCount: 2,
      inputTokens: 14,
      outputTokens: 11,
      totalTokens: 25,
      byModel: [
        { model: "claude-opus-4-8", requestCount: 1, totalTokens: 15 },
        { model: "gemini-3-5-flash-openai", requestCount: 1, totalTokens: 10 },
      ],
    });
  });

  it("estimates prompt tokens from message arrays", () => {
    expect(
      estimateMessagesTokenUsage([
        { role: "system", content: "你是 DigitalMate" },
        { role: "user", content: "帮我查天气" },
      ]),
    ).toBeGreaterThan(0);
  });

  it("includes document text and image payloads in prompt estimates", () => {
    const plain = estimateMessagesTokenUsage([{ role: "user", content: "看附件" }]);
    const withDocument = estimateMessagesTokenUsage([{
      role: "user",
      content: "看附件",
      attachments: [{
        kind: "document",
        fileName: "notes.md",
        mimeType: "text/markdown",
        text: "正文".repeat(200),
        truncated: false,
      }],
    }]);
    const withImage = estimateMessagesTokenUsage([{
      role: "user",
      content: "看附件",
      attachments: [{
        kind: "image",
        fileName: "cat.png",
        mimeType: "image/png",
        base64: Buffer.alloc(3_000).toString("base64"),
      }],
    }]);

    expect(withDocument).toBeGreaterThan(plain + 200);
    expect(withImage).toBeGreaterThan(plain + 500);
  });
});
