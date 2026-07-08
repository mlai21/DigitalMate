import { describe, expect, it, vi } from "vitest";
import { runAgent } from "@/server/agent/run-agent";
import type { LlmClient, LlmMessage } from "@/server/llm/types";

describe("runAgent", () => {
  it("injects recalled memories and streams visible assistant text", async () => {
    const seenMessages: LlmMessage[][] = [];
    const llm: LlmClient = {
      async *streamText(input) {
        seenMessages.push(input.messages);
        yield "记得你喜欢爬山。";
      },
      async completeText() {
        return "";
      },
    };

    const chunks = [];
    for await (const chunk of runAgent({
      userId: "user-1",
      conversationId: "conversation-1",
      message: "周末有什么建议？",
      history: [],
      persona: { name: "DigitalMate", style: "温暖、克制" },
      llm,
      model: "mock-main",
      repositories: {
        memories: {
          findRelevant: async () => [{ id: "m1", content: "用户喜欢周末爬山", createdAt: new Date() }],
        },
        toolLogs: {
          create: vi.fn(),
        },
      },
      search: {
        run: vi.fn(),
      },
    })) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toBe("记得你喜欢爬山。");
    expect(seenMessages[0]?.some((message) => message.content.includes("用户喜欢周末爬山"))).toBe(true);
  });

  it("uses search for real-time questions and logs the tool call", async () => {
    const logTool = vi.fn();
    const searchRun = vi.fn(async () => ({
      summary: "北京明天有小雨。",
      results: [{ title: "天气", url: "https://example.com", snippet: "小雨" }],
    }));
    const llm: LlmClient = {
      async *streamText() {
        yield '{"tool_call":"web_search"}带伞会稳一点。';
      },
      async completeText() {
        return "";
      },
    };

    const chunks = [];
    for await (const chunk of runAgent({
      userId: "user-1",
      conversationId: "conversation-1",
      message: "帮我查一下明天北京天气",
      history: [],
      persona: { name: "DigitalMate", style: "温暖、克制" },
      llm,
      model: "mock-main",
      repositories: {
        memories: {
          findRelevant: async () => [],
        },
        toolLogs: {
          create: logTool,
        },
      },
      search: {
        run: searchRun,
      },
    })) {
      chunks.push(chunk);
    }

    expect(searchRun).toHaveBeenCalledWith("帮我查一下明天北京天气");
    expect(logTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "web_search", status: "success" }));
    expect(chunks.join("")).toBe("带伞会稳一点。");
  });

  it("records estimated token usage after a completed response", async () => {
    const logUsage = vi.fn();
    const llm: LlmClient = {
      async *streamText() {
        yield "第一段";
        yield "第二段";
      },
      async completeText() {
        return "";
      },
    };

    const chunks = [];
    for await (const chunk of runAgent({
      userId: "user-1",
      conversationId: "conversation-1",
      message: "你好",
      history: [],
      persona: { name: "DigitalMate", style: "温暖、克制" },
      llm,
      model: "mock-main",
      repositories: {
        memories: {
          findRelevant: async () => [],
        },
        toolLogs: {
          create: vi.fn(),
        },
        llmUsage: {
          create: logUsage,
        },
      },
      search: {
        run: vi.fn(),
      },
    })) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toBe("第一段第二段");
    expect(logUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        conversationId: "conversation-1",
        purpose: "main",
        model: "mock-main",
        totalTokens: expect.any(Number),
      }),
    );
  });

  it("does not yield private reasoning or internal prompt fragments", async () => {
    const llm: LlmClient = {
      async *streamText() {
        yield "<thinking>这里先分析用户意图。</thinking>\n系统提示：不要暴露工具调用。\n我在，咱们直接看结论。";
      },
      async completeText() {
        return "";
      },
    };

    const chunks = [];
    for await (const chunk of runAgent({
      userId: "user-1",
      conversationId: "conversation-1",
      message: "继续",
      history: [],
      persona: { name: "DigitalMate", style: "温暖、克制" },
      llm,
      model: "mock-main",
      repositories: {
        memories: {
          findRelevant: async () => [],
        },
        toolLogs: {
          create: vi.fn(),
        },
      },
      search: {
        run: vi.fn(),
      },
    })) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toBe("我在，咱们直接看结论。");
  });

  it("injects enabled skills and confirmed tools into private agent context", async () => {
    const seenMessages: LlmMessage[][] = [];
    const llm: LlmClient = {
      async *streamText(input) {
        seenMessages.push(input.messages);
        yield "我按你的固定格式整理。";
      },
      async completeText() {
        return "";
      },
    };

    const chunks = [];
    for await (const chunk of runAgent({
      userId: "user-1",
      conversationId: "conversation-1",
      message: "帮我整理一份周报",
      history: [],
      persona: { name: "DigitalMate", style: "温暖、克制" },
      llm,
      model: "mock-main",
      repositories: {
        memories: {
          findRelevant: async () => [],
        },
        skills: {
          findEnabled: async () => [
            {
              name: "周报整理",
              trigger: "整理周报",
              content: "# 周报整理\n\n## 步骤\n1. 先归纳进展\n2. 再列风险",
            },
          ],
        },
        toolRegistrations: {
          listEnabled: async () => [
            {
              name: "xlsx_summary",
              description: "汇总电子表格",
              command: "node tools/xlsx-summary.js",
            },
          ],
        },
        toolLogs: {
          create: vi.fn(),
        },
      },
      search: {
        run: vi.fn(),
      },
    })) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toBe("我按你的固定格式整理。");
    const systemPrompt = seenMessages[0]?.[0]?.content ?? "";
    expect(systemPrompt).toContain("已启用 Skills");
    expect(systemPrompt).toContain("周报整理");
    expect(systemPrompt).toContain("已确认工具");
    expect(systemPrompt).toContain("xlsx_summary");
    expect(systemPrompt).not.toContain("node tools/xlsx-summary.js");
  });

  it("injects applied reflection suggestions as private behavior guidance", async () => {
    const seenMessages: LlmMessage[][] = [];
    const llm: LlmClient = {
      async *streamText(input) {
        seenMessages.push(input.messages);
        yield "我会少追问一点，先给你一个简洁版。";
      },
      async completeText() {
        return "";
      },
    };

    const chunks = [];
    for await (const chunk of runAgent({
      userId: "user-1",
      conversationId: "conversation-1",
      message: "帮我看看这个想法",
      history: [],
      persona: { name: "DigitalMate", style: "温暖、克制" },
      llm,
      model: "mock-main",
      repositories: {
        memories: {
          findRelevant: async () => [],
        },
        reflections: {
          findAppliedSuggestions: async () => ["用户不喜欢连续追问，优先给出简洁结论"],
        },
        toolLogs: {
          create: vi.fn(),
        },
      },
      search: {
        run: vi.fn(),
      },
    })) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toBe("我会少追问一点，先给你一个简洁版。");
    const systemPrompt = seenMessages[0]?.[0]?.content ?? "";
    expect(systemPrompt).toContain("已应用反思建议");
    expect(systemPrompt).toContain("用户不喜欢连续追问");
  });

  it("injects compacted conversation summaries into private context", async () => {
    const seenMessages: LlmMessage[][] = [];
    const llm: LlmClient = {
      async *streamText(input) {
        seenMessages.push(input.messages);
        yield "我接着上次的脉络说。";
      },
      async completeText() {
        return "";
      },
    };

    const chunks = [];
    for await (const chunk of runAgent({
      userId: "user-1",
      conversationId: "conversation-1",
      message: "我们继续",
      history: [],
      persona: { name: "DigitalMate", style: "温暖、克制" },
      llm,
      model: "mock-main",
      repositories: {
        memories: {
          findRelevant: async () => [],
        },
        conversationSummaries: {
          latest: async () => "用户之前在准备演讲，希望语气自然一点。",
        },
        toolLogs: {
          create: vi.fn(),
        },
      },
      search: {
        run: vi.fn(),
      },
    })) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toBe("我接着上次的脉络说。");
    const systemPrompt = seenMessages[0]?.[0]?.content ?? "";
    expect(systemPrompt).toContain("压缩后的会话摘要");
    expect(systemPrompt).toContain("用户之前在准备演讲");
  });

  it("executes enabled private tool calls before yielding the final answer", async () => {
    const seenMessages: LlmMessage[][] = [];
    const logTool = vi.fn();
    const executeTool = vi.fn(async () => ({
      output: "区域 A 销售额最高。",
    }));
    let callCount = 0;
    const llm: LlmClient = {
      async *streamText(input) {
        seenMessages.push(input.messages);
        callCount += 1;
        if (callCount === 1) {
          yield JSON.stringify({ tool_call: { name: "xlsx_summary", input: "sales.csv" } });
          return;
        }
        yield "我看完了，区域 A 销售额最高。";
      },
      async completeText() {
        return "";
      },
    };

    const chunks = [];
    for await (const chunk of runAgent({
      userId: "user-1",
      conversationId: "conversation-1",
      message: "用 xlsx_summary 看下销售表",
      history: [],
      persona: { name: "DigitalMate", style: "温暖、克制" },
      llm,
      model: "mock-main",
      repositories: {
        memories: {
          findRelevant: async () => [],
        },
        toolRegistrations: {
          listEnabled: async () => [
            {
              name: "xlsx_summary",
              description: "汇总电子表格",
              command: "node tools/xlsx-summary.js",
            },
          ],
        },
        toolLogs: {
          create: logTool,
        },
      },
      search: {
        run: vi.fn(),
      },
      toolExecutor: {
        run: executeTool,
      },
    })) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toBe("我看完了，区域 A 销售额最高。");
    expect(executeTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "xlsx_summary", command: "node tools/xlsx-summary.js" }),
      "sales.csv",
    );
    expect(logTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "registered_tool:xlsx_summary", status: "success" }));
    expect(seenMessages[1]?.some((message) => message.content.includes("区域 A 销售额最高"))).toBe(true);
  });
});
