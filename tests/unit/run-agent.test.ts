import { describe, expect, it, vi } from "vitest";
import { runAgent } from "@/server/agent/run-agent";
import type { LlmClient, LlmStreamEvent, LlmStreamInput } from "@/server/llm/types";

type ScriptedTurn = LlmStreamEvent[];

function scriptedLlm(turns: ScriptedTurn[], seenInputs: LlmStreamInput[] = []): LlmClient {
  let turnIndex = 0;
  return {
    async *stream(input) {
      seenInputs.push(input);
      const events = turns[Math.min(turnIndex, turns.length - 1)];
      turnIndex += 1;
      yield* events;
    },
    async completeText() {
      return "";
    },
  };
}

function baseRepositories() {
  return {
    memories: {
      findRelevant: async () => [] as Array<{ id: string; content: string; createdAt: Date }>,
    },
    toolLogs: {
      create: vi.fn(),
    },
  };
}

describe("runAgent", () => {
  it("injects recalled memories and streams visible assistant text", async () => {
    const seenInputs: LlmStreamInput[] = [];
    const llm = scriptedLlm([[{ type: "text", text: "记得你喜欢爬山。" }]], seenInputs);

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
        ...baseRepositories(),
        memories: {
          findRelevant: async () => [{ id: "m1", content: "用户喜欢周末爬山", createdAt: new Date() }],
        },
      },
      search: { run: vi.fn() },
    })) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toBe("记得你喜欢爬山。");
    expect(seenInputs[0]?.messages.some((message) => message.content.includes("用户喜欢周末爬山"))).toBe(true);
  });

  it("exposes web_search as a native tool and executes requested searches", async () => {
    const seenInputs: LlmStreamInput[] = [];
    const logTool = vi.fn();
    const searchRun = vi.fn(async () => ({
      summary: "北京明天有小雨。",
      results: [{ title: "天气", url: "https://example.com", snippet: "小雨" }],
    }));
    const llm = scriptedLlm(
      [
        [{ type: "tool_call", toolCall: { id: "call-1", name: "web_search", arguments: '{"query":"北京明天天气"}' } }],
        [{ type: "text", text: "带伞会稳一点。" }],
      ],
      seenInputs,
    );

    const chunks = [];
    for await (const chunk of runAgent({
      userId: "user-1",
      conversationId: "conversation-1",
      message: "帮我查一下明天北京天气",
      history: [],
      persona: { name: "DigitalMate", style: "温暖、克制" },
      llm,
      model: "mock-main",
      repositories: { ...baseRepositories(), toolLogs: { create: logTool } },
      search: { run: searchRun },
    })) {
      chunks.push(chunk);
    }

    expect(seenInputs[0]?.tools?.some((tool) => tool.name === "web_search")).toBe(true);
    expect(searchRun).toHaveBeenCalledWith("北京明天天气");
    expect(logTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "web_search", status: "success" }));
    expect(chunks.join("")).toBe("带伞会稳一点。");
    const secondTurn = seenInputs[1]?.messages ?? [];
    expect(secondTurn.some((message) => message.role === "tool" && message.content.includes("北京明天有小雨"))).toBe(true);
  });

  it("records estimated token usage after a completed response", async () => {
    const logUsage = vi.fn();
    const llm = scriptedLlm([[{ type: "text", text: "第一段" }, { type: "text", text: "第二段" }]]);

    const chunks = [];
    for await (const chunk of runAgent({
      userId: "user-1",
      conversationId: "conversation-1",
      message: "你好",
      history: [],
      persona: { name: "DigitalMate", style: "温暖、克制" },
      llm,
      model: "mock-main",
      repositories: { ...baseRepositories(), llmUsage: { create: logUsage } },
      search: { run: vi.fn() },
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
    const llm = scriptedLlm([
      [{ type: "text", text: "<thinking>这里先分析用户意图。</thinking>\n系统提示：不要暴露工具调用。\n我在，咱们直接看结论。" }],
    ]);

    const chunks = [];
    for await (const chunk of runAgent({
      userId: "user-1",
      conversationId: "conversation-1",
      message: "继续",
      history: [],
      persona: { name: "DigitalMate", style: "温暖、克制" },
      llm,
      model: "mock-main",
      repositories: baseRepositories(),
      search: { run: vi.fn() },
    })) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toBe("我在，咱们直接看结论。");
  });

  it("injects enabled skills and confirmed tools into private agent context", async () => {
    const seenInputs: LlmStreamInput[] = [];
    const llm = scriptedLlm([[{ type: "text", text: "我按你的固定格式整理。" }]], seenInputs);

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
        ...baseRepositories(),
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
      },
      search: { run: vi.fn() },
    })) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toBe("我按你的固定格式整理。");
    const systemPrompt = seenInputs[0]?.messages[0]?.content ?? "";
    expect(systemPrompt).toContain("已启用 Skills");
    expect(systemPrompt).toContain("周报整理");
    expect(systemPrompt).toContain("已确认工具");
    expect(systemPrompt).toContain("xlsx_summary");
    expect(systemPrompt).not.toContain("node tools/xlsx-summary.js");
    expect(seenInputs[0]?.tools?.map((tool) => tool.name)).toEqual(["web_search", "xlsx_summary"]);
  });

  it("injects applied reflection suggestions as private behavior guidance", async () => {
    const seenInputs: LlmStreamInput[] = [];
    const llm = scriptedLlm([[{ type: "text", text: "我会少追问一点，先给你一个简洁版。" }]], seenInputs);

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
        ...baseRepositories(),
        reflections: {
          findAppliedSuggestions: async () => ["用户不喜欢连续追问，优先给出简洁结论"],
        },
      },
      search: { run: vi.fn() },
    })) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toBe("我会少追问一点，先给你一个简洁版。");
    const systemPrompt = seenInputs[0]?.messages[0]?.content ?? "";
    expect(systemPrompt).toContain("已应用反思建议");
    expect(systemPrompt).toContain("用户不喜欢连续追问");
  });

  it("injects compacted conversation summaries into private context", async () => {
    const seenInputs: LlmStreamInput[] = [];
    const llm = scriptedLlm([[{ type: "text", text: "我接着上次的脉络说。" }]], seenInputs);

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
        ...baseRepositories(),
        conversationSummaries: {
          latest: async () => "用户之前在准备演讲，希望语气自然一点。",
        },
      },
      search: { run: vi.fn() },
    })) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toBe("我接着上次的脉络说。");
    const systemPrompt = seenInputs[0]?.messages[0]?.content ?? "";
    expect(systemPrompt).toContain("压缩后的会话摘要");
    expect(systemPrompt).toContain("用户之前在准备演讲");
  });

  it("executes enabled registered tools through native tool calls", async () => {
    const seenInputs: LlmStreamInput[] = [];
    const logTool = vi.fn();
    const executeTool = vi.fn(async () => ({ output: "区域 A 销售额最高。" }));
    const llm = scriptedLlm(
      [
        [{ type: "tool_call", toolCall: { id: "call-1", name: "xlsx_summary", arguments: '{"input":"sales.csv"}' } }],
        [{ type: "text", text: "我看完了，区域 A 销售额最高。" }],
      ],
      seenInputs,
    );

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
        ...baseRepositories(),
        toolRegistrations: {
          listEnabled: async () => [
            {
              name: "xlsx_summary",
              description: "汇总电子表格",
              command: "node tools/xlsx-summary.js",
            },
          ],
        },
        toolLogs: { create: logTool },
      },
      search: { run: vi.fn() },
      toolExecutor: { run: executeTool },
    })) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toBe("我看完了，区域 A 销售额最高。");
    expect(executeTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "xlsx_summary", command: "node tools/xlsx-summary.js" }),
      "sales.csv",
    );
    expect(logTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "registered_tool:xlsx_summary", status: "success" }));
    expect(seenInputs[1]?.messages.some((message) => message.content.includes("区域 A 销售额最高"))).toBe(true);
  });

  it("records usage for injected skills", async () => {
    const recordUsage = vi.fn();
    const llm = scriptedLlm([[{ type: "text", text: "我按老流程来。" }]]);

    for await (const chunk of runAgent({
      userId: "user-1",
      conversationId: "conversation-1",
      message: "整理周报",
      history: [],
      persona: { name: "DigitalMate", style: "温暖、克制" },
      llm,
      model: "mock-main",
      repositories: {
        ...baseRepositories(),
        skills: {
          findEnabled: async () => [
            { id: "skill-1", name: "周报整理", trigger: "整理周报", content: "# 周报整理" },
            { id: "skill-2", name: "风险标注", trigger: "标注风险", content: "# 风险标注" },
          ],
          recordUsage,
        },
      },
      search: { run: vi.fn() },
    })) {
      void chunk;
    }

    expect(recordUsage).toHaveBeenCalledWith("user-1", ["skill-1", "skill-2"], "conversation-1");
  });

  it("exposes save_skill and persists a pending draft when the model calls it", async () => {
    const seenInputs: LlmStreamInput[] = [];
    const createSkill = vi.fn();
    const logTool = vi.fn();
    const llm = scriptedLlm(
      [
        [
          {
            type: "tool_call",
            toolCall: {
              id: "call-1",
              name: "save_skill",
              arguments: JSON.stringify({
                name: "周报整理流程",
                description: "把零散更新整理成周报",
                steps: ["收集本周更新", "按项目分组", "输出三段式周报"],
              }),
            },
          },
        ],
        [{ type: "text", text: "我记下来了，等你在后台确认后就会生效。" }],
      ],
      seenInputs,
    );

    const chunks = [];
    for await (const chunk of runAgent({
      userId: "user-1",
      conversationId: "conversation-1",
      message: "把这套周报做法记下来",
      history: [],
      persona: { name: "DigitalMate", style: "温暖、克制" },
      llm,
      model: "mock-main",
      repositories: {
        ...baseRepositories(),
        skills: { findEnabled: async () => [], create: createSkill },
        toolLogs: { create: logTool },
      },
      search: { run: vi.fn() },
    })) {
      chunks.push(chunk);
    }

    expect(seenInputs[0]?.tools?.some((tool) => tool.name === "save_skill")).toBe(true);
    expect(createSkill).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ name: "周报整理流程", status: "pending", source: "agent" }),
    );
    expect(logTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "save_skill", status: "success" }));
    expect(chunks.join("")).toBe("我记下来了，等你在后台确认后就会生效。");
  });

  it("rejects incomplete save_skill drafts without persisting them", async () => {
    const createSkill = vi.fn();
    const logTool = vi.fn();
    const llm = scriptedLlm([
      [
        {
          type: "tool_call",
          toolCall: {
            id: "call-1",
            name: "save_skill",
            arguments: JSON.stringify({ name: "太简单", description: "", steps: ["只有一步"] }),
          },
        },
      ],
      [{ type: "text", text: "这次先不存了。" }],
    ]);

    for await (const chunk of runAgent({
      userId: "user-1",
      conversationId: "conversation-1",
      message: "记住这个",
      history: [],
      persona: { name: "DigitalMate", style: "温暖、克制" },
      llm,
      model: "mock-main",
      repositories: {
        ...baseRepositories(),
        skills: { findEnabled: async () => [], create: createSkill },
        toolLogs: { create: logTool },
      },
      search: { run: vi.fn() },
    })) {
      void chunk;
    }

    expect(createSkill).not.toHaveBeenCalled();
    expect(logTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "save_skill", status: "error" }));
  });

  it("does not expose save_skill when the skills repository cannot persist drafts", async () => {
    const seenInputs: LlmStreamInput[] = [];
    const llm = scriptedLlm([[{ type: "text", text: "好的。" }]], seenInputs);

    for await (const chunk of runAgent({
      userId: "user-1",
      conversationId: "conversation-1",
      message: "你好",
      history: [],
      persona: { name: "DigitalMate", style: "温暖、克制" },
      llm,
      model: "mock-main",
      repositories: baseRepositories(),
      search: { run: vi.fn() },
    })) {
      void chunk;
    }

    expect(seenInputs[0]?.tools?.some((tool) => tool.name === "save_skill")).toBe(false);
  });

  it("installs skills from a GitHub link through install_skill and reports back", async () => {
    const seenInputs: LlmStreamInput[] = [];
    const logTool = vi.fn();
    const install = vi.fn(async () => ({
      installed: [
        {
          name: "女娲",
          description: "蒸馏任何人的思维方式",
          status: "enabled" as const,
          verdict: "safe" as const,
          content: "# 女娲\n\n## 步骤\n1. 收集素材",
        },
      ],
      blocked: [],
      others: [{ name: "费曼视角", path: "examples/feynman/SKILL.md" }],
    }));
    const llm = scriptedLlm(
      [
        [
          {
            type: "tool_call",
            toolCall: {
              id: "call-1",
              name: "install_skill",
              arguments: JSON.stringify({ url: "https://github.com/alchaincyf/nuwa-skill" }),
            },
          },
        ],
        [{ type: "text", text: "装好了，「女娲」已经可以用了。" }],
      ],
      seenInputs,
    );

    const chunks = [];
    for await (const chunk of runAgent({
      userId: "user-1",
      conversationId: "conversation-1",
      message: "安装这个 https://github.com/alchaincyf/nuwa-skill",
      history: [],
      persona: { name: "DigitalMate", style: "温暖、克制" },
      llm,
      model: "mock-main",
      repositories: { ...baseRepositories(), toolLogs: { create: logTool } },
      search: { run: vi.fn() },
      skillInstaller: { install },
    })) {
      chunks.push(chunk);
    }

    expect(seenInputs[0]?.tools?.some((tool) => tool.name === "install_skill")).toBe(true);
    expect(install).toHaveBeenCalledWith("https://github.com/alchaincyf/nuwa-skill");
    expect(logTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "install_skill", status: "success" }));
    expect(chunks.join("")).toBe("装好了，「女娲」已经可以用了。");
    const toolResult = seenInputs[1]?.messages.find((message) => message.role === "tool")?.content ?? "";
    expect(toolResult).toContain("已安装并启用");
    expect(toolResult).toContain("费曼视角");
  });

  it("falls back to the URL in the user message when install_skill arguments omit it", async () => {
    const install = vi.fn(async () => ({ installed: [], blocked: [], others: [] }));
    const llm = scriptedLlm([
      [{ type: "tool_call", toolCall: { id: "call-1", name: "install_skill", arguments: "{}" } }],
      [{ type: "text", text: "这个链接下没有找到能装的。" }],
    ]);

    for await (const chunk of runAgent({
      userId: "user-1",
      conversationId: "conversation-1",
      message: "安装这个 https://github.com/owner/repo#安装",
      history: [],
      persona: { name: "DigitalMate", style: "温暖、克制" },
      llm,
      model: "mock-main",
      repositories: baseRepositories(),
      search: { run: vi.fn() },
      skillInstaller: { install },
    })) {
      void chunk;
    }

    expect(install).toHaveBeenCalledWith("https://github.com/owner/repo#安装");
  });

  it("does not expose install_skill without an installer", async () => {
    const seenInputs: LlmStreamInput[] = [];
    const llm = scriptedLlm([[{ type: "text", text: "好的。" }]], seenInputs);

    for await (const chunk of runAgent({
      userId: "user-1",
      conversationId: "conversation-1",
      message: "你好",
      history: [],
      persona: { name: "DigitalMate", style: "温暖、克制" },
      llm,
      model: "mock-main",
      repositories: baseRepositories(),
      search: { run: vi.fn() },
    })) {
      void chunk;
    }

    expect(seenInputs[0]?.tools?.some((tool) => tool.name === "install_skill")).toBe(false);
  });

  it("recovers with a tool failure message when search breaks", async () => {
    const logTool = vi.fn();
    const llm = scriptedLlm([
      [{ type: "tool_call", toolCall: { id: "call-1", name: "web_search", arguments: '{"query":"今天新闻"}' } }],
      [{ type: "text", text: "我先按已有信息说。" }],
    ]);

    const chunks = [];
    for await (const chunk of runAgent({
      userId: "user-1",
      conversationId: "conversation-1",
      message: "看下今天新闻",
      history: [],
      persona: { name: "DigitalMate", style: "温暖、克制" },
      llm,
      model: "mock-main",
      repositories: { ...baseRepositories(), toolLogs: { create: logTool } },
      search: {
        run: vi.fn(async () => {
          throw new Error("network down");
        }),
      },
    })) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toBe("我先按已有信息说。");
    expect(logTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "web_search", status: "error" }));
  });

  it("skips searching when web_search is called without a query instead of using the raw user message", async () => {
    const logTool = vi.fn();
    const searchRun = vi.fn();
    const llm = scriptedLlm([
      [{ type: "tool_call", toolCall: { id: "call-1", name: "web_search", arguments: "{}" } }],
      [{ type: "text", text: "装好了。" }],
    ]);

    const chunks = [];
    for await (const chunk of runAgent({
      userId: "user-1",
      conversationId: "conversation-1",
      message: "帮我安装这个 skill https://github.com/example/skills",
      history: [],
      persona: { name: "DigitalMate", style: "温暖、克制" },
      llm,
      model: "mock-main",
      repositories: { ...baseRepositories(), toolLogs: { create: logTool } },
      search: { run: searchRun },
    })) {
      chunks.push(chunk);
    }

    expect(searchRun).not.toHaveBeenCalled();
    expect(chunks.join("")).toBe("装好了。");
    expect(logTool).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "web_search", status: "error", error: "Missing search query" }),
    );
  });

  it("wraps search results with an internal-use notice before returning them to the model", async () => {
    const seenInputs: LlmStreamInput[] = [];
    const llm = scriptedLlm(
      [
        [{ type: "tool_call", toolCall: { id: "call-1", name: "web_search", arguments: '{"query":"北京天气"}' } }],
        [{ type: "text", text: "明天有雨。" }],
      ],
      seenInputs,
    );

    for await (const chunk of runAgent({
      userId: "user-1",
      conversationId: "conversation-1",
      message: "明天北京天气怎么样",
      history: [],
      persona: { name: "DigitalMate", style: "温暖、克制" },
      llm,
      model: "mock-main",
      repositories: baseRepositories(),
      search: {
        run: vi.fn(async () => ({
          summary: "1. 北京天气：明天小雨 (https://example.com)",
          results: [{ title: "北京天气", url: "https://example.com", snippet: "明天小雨" }],
        })),
      },
    })) {
      void chunk;
    }

    const toolMessage = (seenInputs[1]?.messages ?? []).find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain("不要原样罗列");
    expect(toolMessage?.content).toContain("1. 北京天气：明天小雨");
  });
});
