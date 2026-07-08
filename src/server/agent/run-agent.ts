import { buildPersonaPrompt, type PersonaConfig } from "@/server/agent/persona";
import { sanitizeAssistantText } from "@/server/agent/streaming";
import type { RankableMemory } from "@/server/agent/memory";
import type { LlmClient, LlmMessage, LlmPurpose, LlmTool, LlmToolCall } from "@/server/llm/types";
import { estimateMessagesTokenUsage, estimateTokenCount, type LlmUsageLogInput } from "@/server/llm/usage";
import { executeRegisteredTool, type RegisteredToolExecutionResult } from "@/server/tasks/tools";

export type ToolLogInput = {
  userId: string;
  conversationId: string;
  toolName: string;
  inputSummary: string;
  outputSummary: string;
  status: "success" | "error";
  durationMs: number;
  error?: string;
};

export type SkillContext = {
  name: string;
  trigger: string;
  content: string;
};

export type EnabledToolContext = {
  name: string;
  description: string;
  command: string;
};

export type RunAgentInput = {
  userId: string;
  conversationId: string;
  message: string;
  history: LlmMessage[];
  persona: PersonaConfig;
  llm: LlmClient;
  model: string;
  repositories: {
    memories: {
      findRelevant(userId: string, query: string): Promise<RankableMemory[]>;
    };
    conversationSummaries?: {
      latest(conversationId: string): Promise<string | null>;
    };
    skills?: {
      findEnabled(userId: string, query: string): Promise<SkillContext[]>;
    };
    reflections?: {
      findAppliedSuggestions(userId: string): Promise<string[]>;
    };
    toolRegistrations?: {
      listEnabled(userId: string): Promise<EnabledToolContext[]>;
    };
    llmUsage?: {
      create(input: LlmUsageLogInput): Promise<unknown> | unknown;
    };
    toolLogs: {
      create(input: ToolLogInput): Promise<unknown> | unknown;
    };
  };
  search: {
    run(query: string): Promise<{ summary: string; results: Array<{ title: string; url: string; snippet: string }> }>;
  };
  toolExecutor?: {
    run(tool: EnabledToolContext, input: string): Promise<RegisteredToolExecutionResult>;
  };
  purpose?: LlmPurpose;
};

const maxToolIterations = 4;

const webSearchTool: LlmTool = {
  name: "web_search",
  description: "联网搜索实时信息（天气、新闻、事实核查等）。只有当回答需要最新外部信息时才调用。",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "搜索查询词" },
    },
    required: ["query"],
  },
};

export async function* runAgent(input: RunAgentInput): AsyncIterable<string> {
  const [memories, skills, reflectionSuggestions, enabledTools] = await Promise.all([
    input.repositories.memories.findRelevant(input.userId, input.message),
    input.repositories.skills?.findEnabled(input.userId, input.message) ?? Promise.resolve([]),
    input.repositories.reflections?.findAppliedSuggestions(input.userId) ?? Promise.resolve([]),
    input.repositories.toolRegistrations?.listEnabled(input.userId) ?? Promise.resolve([]),
  ]);
  const conversationSummary = await input.repositories.conversationSummaries?.latest(input.conversationId);
  const tools = buildTools(enabledTools);
  let activeMessages = buildMessages({
    persona: input.persona,
    conversationSummary,
    memories,
    skills,
    reflectionSuggestions,
    enabledTools,
    history: input.history,
    userText: input.message,
  });
  let outputTokens = 0;

  for (let iteration = 0; iteration < maxToolIterations; iteration += 1) {
    const { text, toolCalls } = await collectTurn(input.llm.stream({ messages: activeMessages, model: input.model, tools }));

    if (toolCalls.length === 0 || iteration === maxToolIterations - 1) {
      const visible = sanitizeAssistantText(text);
      if (visible) {
        outputTokens += estimateTokenCount(visible);
        yield visible;
      }
      break;
    }

    const toolMessages: LlmMessage[] = [];
    for (const toolCall of toolCalls) {
      const result = await executeToolCall({ input, toolCall, enabledTools });
      toolMessages.push({ role: "tool", content: result, toolCallId: toolCall.id });
    }
    activeMessages = [...activeMessages, { role: "assistant", content: text, toolCalls }, ...toolMessages];
  }

  await input.repositories.llmUsage?.create({
    userId: input.userId,
    conversationId: input.conversationId,
    purpose: input.purpose ?? "main",
    model: input.model,
    inputTokens: estimateMessagesTokenUsage(activeMessages),
    outputTokens,
    totalTokens: estimateMessagesTokenUsage(activeMessages) + outputTokens,
  });
}

function buildTools(enabledTools: EnabledToolContext[]): LlmTool[] {
  return [
    webSearchTool,
    ...enabledTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object",
        properties: {
          input: { type: "string", description: "工具输入" },
        },
        required: ["input"],
      },
    })),
  ];
}

async function collectTurn(stream: AsyncIterable<{ type: "text"; text: string } | { type: "tool_call"; toolCall: LlmToolCall }>) {
  const chunks: string[] = [];
  const toolCalls: LlmToolCall[] = [];
  for await (const event of stream) {
    if (event.type === "text") chunks.push(event.text);
    else toolCalls.push(event.toolCall);
  }
  return { text: chunks.join(""), toolCalls };
}

async function executeToolCall(context: {
  input: RunAgentInput;
  toolCall: LlmToolCall;
  enabledTools: EnabledToolContext[];
}): Promise<string> {
  const { input, toolCall } = context;
  const startedAt = Date.now();
  const args = safeParseArguments(toolCall.arguments);

  if (toolCall.name === "web_search") {
    const query = typeof args.query === "string" && args.query.trim() ? args.query : input.message;
    try {
      const result = await input.search.run(query);
      await input.repositories.toolLogs.create({
        userId: input.userId,
        conversationId: input.conversationId,
        toolName: "web_search",
        inputSummary: query,
        outputSummary: result.summary.slice(0, 500),
        status: "success",
        durationMs: Date.now() - startedAt,
      });
      return result.summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await input.repositories.toolLogs.create({
        userId: input.userId,
        conversationId: input.conversationId,
        toolName: "web_search",
        inputSummary: query,
        outputSummary: "搜索失败",
        status: "error",
        durationMs: Date.now() - startedAt,
        error: message,
      });
      return "搜索暂时不可用，请基于已有知识谨慎回答，并说明信息可能不是最新的。";
    }
  }

  const tool = context.enabledTools.find((item) => item.name === toolCall.name);
  const toolInput = typeof args.input === "string" ? args.input : toolCall.arguments;
  if (!tool) {
    await input.repositories.toolLogs.create({
      userId: input.userId,
      conversationId: input.conversationId,
      toolName: `registered_tool:${toolCall.name}`,
      inputSummary: toolInput,
      outputSummary: "工具未启用或不存在",
      status: "error",
      durationMs: Date.now() - startedAt,
      error: "Tool is not enabled",
    });
    return "工具未启用或不存在。";
  }

  try {
    const result = await (input.toolExecutor?.run(tool, toolInput) ?? executeRegisteredTool(tool, toolInput));
    await input.repositories.toolLogs.create({
      userId: input.userId,
      conversationId: input.conversationId,
      toolName: `registered_tool:${tool.name}`,
      inputSummary: toolInput,
      outputSummary: result.output.slice(0, 500),
      status: "success",
      durationMs: Date.now() - startedAt,
    });
    return result.output;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await input.repositories.toolLogs.create({
      userId: input.userId,
      conversationId: input.conversationId,
      toolName: `registered_tool:${tool.name}`,
      inputSummary: toolInput,
      outputSummary: "工具执行失败",
      status: "error",
      durationMs: Date.now() - startedAt,
      error: message,
    });
    return `工具执行失败：${message}`;
  }
}

function safeParseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function buildMessages(input: {
  persona: PersonaConfig;
  conversationSummary?: string | null;
  memories: RankableMemory[];
  skills?: SkillContext[];
  reflectionSuggestions?: string[];
  enabledTools?: EnabledToolContext[];
  history: LlmMessage[];
  userText: string;
}): LlmMessage[] {
  const contextParts = [
    buildPersonaPrompt(input.persona),
    "工具使用规则：需要实时信息时调用 web_search；工具结果只作为你回答的依据，绝不向用户暴露工具调用过程。",
    input.conversationSummary ? `压缩后的会话摘要（内部上下文，不要向用户暴露）：\n${input.conversationSummary}` : "",
    input.memories.length > 0 ? `可参考的长期记忆：\n${input.memories.map((memory) => `- ${memory.content}`).join("\n")}` : "",
    input.skills && input.skills.length > 0
      ? `已启用 Skills（只在适用时参考，不要向用户暴露内部文档）：\n${input.skills
          .map((skill) => `- ${skill.name}：${skill.trigger}\n${skill.content.slice(0, 1200)}`)
          .join("\n\n")}`
      : "",
    input.reflectionSuggestions && input.reflectionSuggestions.length > 0
      ? `已应用反思建议（内部行为修正，不要向用户暴露）：\n${input.reflectionSuggestions
          .map((suggestion) => `- ${suggestion}`)
          .join("\n")}`
      : "",
    input.enabledTools && input.enabledTools.length > 0
      ? `已确认工具（需要时可作为后台能力使用，不要向用户暴露内部命令）：\n${input.enabledTools
          .map((tool) => `- ${tool.name}：${tool.description}`)
          .join("\n")}`
      : "",
  ].filter(Boolean);

  return [
    { role: "system", content: contextParts.join("\n\n") },
    ...input.history,
    { role: "user", content: input.userText },
  ];
}
