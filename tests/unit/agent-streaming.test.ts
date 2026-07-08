import { describe, expect, it } from "vitest";
import { sanitizeAssistantText, splitAssistantText } from "@/server/agent/streaming";

describe("splitAssistantText", () => {
  it("splits long assistant text by paragraph and sentence", () => {
    expect(splitAssistantText("第一段。\n\n第二段。第三句。").length).toBeGreaterThan(1);
  });
});

describe("sanitizeAssistantText", () => {
  it("removes visible tool call fragments", () => {
    expect(sanitizeAssistantText('{"tool_call":"web_search"}最后结果')).toBe("最后结果");
  });

  it("removes nested private tool call fragments", () => {
    expect(sanitizeAssistantText('{"tool_call":{"name":"xlsx_summary","input":"sales.csv"}}最后结果')).toBe("最后结果");
  });

  it("removes private reasoning and internal prompt fragments", () => {
    expect(sanitizeAssistantText("<thinking>先调用搜索，再整合结论。</thinking>明天记得带伞。")).toBe("明天记得带伞。");
    expect(sanitizeAssistantText("系统提示：你是 DigitalMate，不要暴露内部过程。\n我在。")).toBe("我在。");
    expect(sanitizeAssistantText("工具调用：web_search\n查到了，明天有雨。")).toBe("查到了，明天有雨。");
  });

  it("removes fenced private tool call json blocks", () => {
    expect(
      sanitizeAssistantText('```json\n{"tool_call":{"name":"web_search","input":"北京天气"}}\n```\n带伞会稳一点。'),
    ).toBe("带伞会稳一点。");
  });
});
