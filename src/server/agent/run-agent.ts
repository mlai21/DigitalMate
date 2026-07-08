import { buildPersonaPrompt, type PersonaConfig } from "@/server/agent/persona";
import { sanitizeAssistantText } from "@/server/agent/streaming";
import { shouldSearchWeb } from "@/server/agent/tools/web-search";
import type { RankableMemory } from "@/server/agent/memory";
import type { LlmClient, LlmMessage, LlmPurpose } from "@/server/llm/types";
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

export type PrivateToolCall = {
  name: string;
  input: string;
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

const maxPrivateToolCalls = 2;

export async function* runAgent(input: RunAgentInput): AsyncIterable<string> {
  const [memories, skills, reflectionSuggestions, enabledTools] = await Promise.all([
    input.repositories.memories.findRelevant(input.userId, input.message),
    input.repositories.skills?.findEnabled(input.userId, input.message) ?? Promise.resolve([]),
    input.repositories.reflections?.findAppliedSuggestions(input.userId) ?? Promise.resolve([]),
    input.repositories.toolRegistrations?.listEnabled(input.userId) ?? Promise.resolve([]),
  ]);
  const conversationSummary = await input.repositories.conversationSummaries?.latest(input.conversationId);
  const searchSummary = await maybeSearch(input);
  const messages = buildMessages({
    persona: input.persona,
    conversationSummary,
    memories,
    skills,
    reflectionSuggestions,
    enabledTools,
    searchSummary,
    history: input.history,
    userText: input.message,
  });
  const inputTokens = estimateMessagesTokenUsage(messages);
  let outputTokens = 0;
  let activeMessages = messages;

  for (let iteration = 0; iteration <= maxPrivateToolCalls; iteration += 1) {
    const rawText = await collectText(input.llm.streamText({ messages: activeMessages, model: input.model }));
    const toolCall = parsePrivateToolCall(rawText);
    if (toolCall) {
      const result = await executePrivateToolCall({
        input,
        toolCall,
        enabledTools,
      });
      activeMessages = [
        ...activeMessages,
        { role: "assistant", content: `工具调用请求：${toolCall.name}` },
        {
          role: "user",
          content: `工具 ${toolCall.name} 返回：\n${result}\n\n请基于这个结果自然回复用户，不要暴露工具调用细节。`,
        },
      ];
      continue;
    }

    const visible = sanitizeAssistantText(rawText);
    if (visible) {
      outputTokens += estimateTokenCount(visible);
      yield visible;
    }
    break;
  }

  await input.repositories.llmUsage?.create({
    userId: input.userId,
    conversationId: input.conversationId,
    purpose: input.purpose ?? "main",
    model: input.model,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  });
}

export function parsePrivateToolCall(text: string): PrivateToolCall | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;

  try {
    const parsed = JSON.parse(trimmed) as {
      tool_call?: { name?: unknown; input?: unknown; arguments?: unknown };
    };
    const call = parsed.tool_call;
    if (!call || typeof call.name !== "string") return null;
    const input =
      typeof call.input === "string"
        ? call.input
        : call.arguments === undefined
          ? ""
          : JSON.stringify(call.arguments);
    return { name: call.name, input };
  } catch {
    return null;
  }
}

async function executePrivateToolCall(input: {
  input: RunAgentInput;
  toolCall: PrivateToolCall;
  enabledTools: EnabledToolContext[];
}): Promise<string> {
  const tool = input.enabledTools.find((item) => item.name === input.toolCall.name);
  const startedAt = Date.now();
  if (!tool) {
    await input.input.repositories.toolLogs.create({
      userId: input.input.userId,
      conversationId: input.input.conversationId,
      toolName: `registered_tool:${input.toolCall.name}`,
      inputSummary: input.toolCall.input,
      outputSummary: "工具未启用或不存在",
      status: "error",
      durationMs: Date.now() - startedAt,
      error: "Tool is not enabled",
    });
    return "工具未启用或不存在。";
  }

  try {
    const result = await (input.input.toolExecutor?.run(tool, input.toolCall.input) ??
      executeRegisteredTool(tool, input.toolCall.input));
    await input.input.repositories.toolLogs.create({
      userId: input.input.userId,
      conversationId: input.input.conversationId,
      toolName: `registered_tool:${tool.name}`,
      inputSummary: input.toolCall.input,
      outputSummary: result.output.slice(0, 500),
      status: "success",
      durationMs: Date.now() - startedAt,
    });
    return result.output;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await input.input.repositories.toolLogs.create({
      userId: input.input.userId,
      conversationId: input.input.conversationId,
      toolName: `registered_tool:${tool.name}`,
      inputSummary: input.toolCall.input,
      outputSummary: "工具执行失败",
      status: "error",
      durationMs: Date.now() - startedAt,
      error: message,
    });
    return `工具执行失败：${message}`;
  }
}

async function collectText(stream: AsyncIterable<string>): Promise<string> {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks.join("");
}

export function buildMessages(input: {
  persona: PersonaConfig;
  conversationSummary?: string | null;
  memories: RankableMemory[];
  skills?: SkillContext[];
  reflectionSuggestions?: string[];
  enabledTools?: EnabledToolContext[];
  searchSummary?: string;
  history: LlmMessage[];
  userText: string;
}): LlmMessage[] {
  const contextParts = [
    buildPersonaPrompt(input.persona),
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
    input.searchSummary ? `联网搜索摘要：\n${input.searchSummary}` : "",
  ].filter(Boolean);

  return [
    { role: "system", content: contextParts.join("\n\n") },
    ...input.history,
    { role: "user", content: input.userText },
  ];
}

async function maybeSearch(input: RunAgentInput): Promise<string | undefined> {
  if (!shouldSearchWeb(input.message)) return undefined;

  const startedAt = Date.now();
  try {
    const result = await input.search.run(input.message);
    await input.repositories.toolLogs.create({
      userId: input.userId,
      conversationId: input.conversationId,
      toolName: "web_search",
      inputSummary: input.message,
      outputSummary: result.summary,
      status: "success",
      durationMs: Date.now() - startedAt,
    });
    return result.summary;
  } catch (error) {
    await input.repositories.toolLogs.create({
      userId: input.userId,
      conversationId: input.conversationId,
      toolName: "web_search",
      inputSummary: input.message,
      outputSummary: "搜索失败",
      status: "error",
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    return "我这边刚才没查到可靠结果。";
  }
}
