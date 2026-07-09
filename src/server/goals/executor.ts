import type { RankableMemory } from "@/server/agent/memory";
import type { ToolLogInput } from "@/server/agent/run-agent";
import type { DbGoal, DbGoalStep } from "@/server/db/repositories";
import {
  formatGoalEvidence,
  isGoalEvidenceItem,
  type GoalEvidenceItem,
} from "@/server/goals/contract";
import type { LlmClient, LlmMessage, LlmTool, LlmToolCall } from "@/server/llm/types";
import { estimateMessagesTokenUsage, estimateTokenCount } from "@/server/llm/usage";

export type GoalStepCandidate = {
  intent: string;
  evidence: GoalEvidenceItem[];
  /** Incremental report content produced this round (markdown). */
  candidate: string;
  /** User-facing one-line progress summary proposed by the executor. */
  progressSummary: string;
  failedPaths: string[];
  tokensUsed: number;
};

export type ExecuteGoalStepInput = {
  goal: DbGoal;
  recentSteps: DbGoalStep[];
  llm: LlmClient;
  model: string;
  search: { run(query: string): Promise<{ summary: string }> };
  memories: { findRelevant(userId: string, query: string): Promise<RankableMemory[]> };
  toolLogs: { create(input: ToolLogInput): Promise<unknown> | unknown };
  now?: Date;
};

const maxToolIterations = 6;
const recentEvidenceRounds = 5;

const webSearchTool: LlmTool = {
  name: "web_search",
  description: "联网搜索目标相关信息。查询词要具体；同一查询词失败过就换角度，不要原样重试。",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "搜索查询词" } },
    required: ["query"],
  },
};

const memorySearchTool: LlmTool = {
  name: "memory_search",
  description: "检索用户的长期记忆，寻找与目标相关的既有信息或偏好。",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "记忆检索词" } },
    required: ["query"],
  },
};

/**
 * Execution plane for one goal round: plans this round's intent, runs
 * read-only whitelisted tools, and returns a structured candidate. It never
 * advances goal state itself — that is the orchestrator's job.
 */
export async function executeGoalStep(input: ExecuteGoalStepInput): Promise<GoalStepCandidate> {
  const tools = buildWhitelistedTools(input.goal);
  let messages = buildStepMessages(input);
  let outputTokens = 0;

  let finalText = "";
  for (let iteration = 0; iteration < maxToolIterations; iteration += 1) {
    const { text, toolCalls } = await collectTurn(input.llm.stream({ messages, model: input.model, tools }));
    outputTokens += estimateTokenCount(text);

    if (toolCalls.length === 0 || iteration === maxToolIterations - 1) {
      finalText = text;
      break;
    }

    const toolMessages: LlmMessage[] = [];
    for (const toolCall of toolCalls) {
      const result = await executeGoalToolCall(input, toolCall);
      toolMessages.push({ role: "tool", content: result, toolCallId: toolCall.id });
    }
    messages = [...messages, { role: "assistant", content: text, toolCalls }, ...toolMessages];
  }

  const tokensUsed = estimateMessagesTokenUsage(messages) + outputTokens;
  return { ...parseCandidate(finalText), tokensUsed };
}

function buildWhitelistedTools(goal: DbGoal): LlmTool[] {
  const allowed = goal.contract.scope?.allowedTools ?? [];
  const tools: LlmTool[] = [];
  if (allowed.includes("web_search")) tools.push(webSearchTool);
  if (allowed.includes("memory_search")) tools.push(memorySearchTool);
  return tools;
}

function buildStepMessages(input: ExecuteGoalStepInput): LlmMessage[] {
  const { goal, recentSteps } = input;
  const contract = goal.contract;

  const criteria = (contract.successCriteria ?? [])
    .map((criterion) => `- [${criterion.id}] ${criterion.description}（验证方式：${criterion.verification}）`)
    .join("\n");

  const recentEvidence = recentSteps
    .slice(-recentEvidenceRounds)
    .flatMap((step) =>
      (Array.isArray(step.evidence) ? step.evidence : [])
        .filter(isGoalEvidenceItem)
        .map((item) => `- （第 ${step.round} 轮）${formatGoalEvidence(item)}`),
    )
    .join("\n");

  const failedPaths = recentSteps
    .flatMap((step) => (Array.isArray(step.failedPaths) ? step.failedPaths : []))
    .filter((path): path is string => typeof path === "string" && path.length > 0);

  const systemParts = [
    "你是一个长时目标循环的执行器。每轮你基于目标合同和已有进度，规划本轮要做什么，用只读工具搜集信息，最后产出本轮的候选成果。你的产出会交给独立验证器判定，不要自我宣称目标已完成。",
    `目标：${contract.objective ?? goal.title}`,
    criteria ? `完成标准 checklist：\n${criteria}` : "",
    contract.scope?.forbidden?.length ? `明确禁止：${contract.scope.forbidden.join("；")}` : "",
    goal.progressSummary ? `当前进度摘要：${goal.progressSummary}` : "当前是第一轮，还没有进度。",
    goal.reportDraft ? `报告草稿现状（只需产出增量，不要重复已有内容）：\n${goal.reportDraft.slice(-2000)}` : "",
    recentEvidence ? `最近几轮已收集的证据（不要重复收集）：\n${recentEvidence}` : "",
    failedPaths.length > 0 ? `已失败路径（禁止用相同参数重试）：\n${failedPaths.map((path) => `- ${path}`).join("\n")}` : "",
    [
      "工作方式：先想清楚本轮最有价值的推进点，再调用工具（可多次），信息足够后停止调用工具，输出最终 JSON（不要输出其他内容）：",
      "```json",
      `{
  "intent": "本轮做了什么（一句话）",
  "evidence": [{ "source": "来源名", "url": "链接（可选）", "summary": "该来源提供的事实" }],
  "candidate": "本轮新增的报告内容（markdown，只写增量）",
  "progressSummary": "面向用户的一句话进度描述（自然口吻，不用内部术语）",
  "failedPaths": ["本轮尝试失败、后续应避开的查询或路径"]
}`,
      "```",
      "evidence 必须来自本轮工具调用的真实结果，禁止编造来源或链接。",
    ].join("\n"),
  ].filter(Boolean);

  return [
    { role: "system", content: systemParts.join("\n\n") },
    { role: "user", content: `现在开始第 ${(recentSteps[recentSteps.length - 1]?.round ?? 0) + 1} 轮推进。` },
  ];
}

async function executeGoalToolCall(input: ExecuteGoalStepInput, toolCall: LlmToolCall): Promise<string> {
  const startedAt = Date.now();
  const args = safeParseArguments(toolCall.arguments);
  const query = typeof args.query === "string" ? args.query.trim() : "";

  const logBase = {
    userId: input.goal.userId,
    conversationId: input.goal.conversationId,
    goalId: input.goal.id,
    toolName: toolCall.name,
    inputSummary: query || "(缺少查询词)",
  };

  if (!query) {
    await input.toolLogs.create({
      ...logBase,
      outputSummary: "未提供查询词",
      status: "error",
      durationMs: Date.now() - startedAt,
      error: "Missing query",
    });
    return "没有拿到有效的查询词，请带上明确的 query 重新调用。";
  }

  if (toolCall.name === "web_search") {
    try {
      const result = await input.search.run(query);
      await input.toolLogs.create({
        ...logBase,
        outputSummary: result.summary.slice(0, 500),
        status: "success",
        durationMs: Date.now() - startedAt,
      });
      return `搜索结果：\n${result.summary}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await input.toolLogs.create({
        ...logBase,
        outputSummary: "搜索失败",
        status: "error",
        durationMs: Date.now() - startedAt,
        error: message,
      });
      return `搜索失败（${message}）。换一个查询词或来源，并把这条路径记入 failedPaths。`;
    }
  }

  if (toolCall.name === "memory_search") {
    try {
      const memories = await input.memories.findRelevant(input.goal.userId, query);
      const summary =
        memories.length > 0 ? memories.map((memory) => `- ${memory.content}`).join("\n") : "没有找到相关记忆。";
      await input.toolLogs.create({
        ...logBase,
        outputSummary: summary.slice(0, 500),
        status: "success",
        durationMs: Date.now() - startedAt,
      });
      return `相关记忆：\n${summary}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await input.toolLogs.create({
        ...logBase,
        outputSummary: "记忆检索失败",
        status: "error",
        durationMs: Date.now() - startedAt,
        error: message,
      });
      return "记忆检索暂时不可用，继续其他路径。";
    }
  }

  await input.toolLogs.create({
    ...logBase,
    toolName: `goal_tool:${toolCall.name}`,
    outputSummary: "工具不在目标白名单内",
    status: "error",
    durationMs: Date.now() - startedAt,
    error: "Tool not whitelisted",
  });
  return "该工具不在本目标的白名单内，只能使用给定的工具。";
}

function parseCandidate(text: string): Omit<GoalStepCandidate, "tokensUsed"> {
  const fallback: Omit<GoalStepCandidate, "tokensUsed"> = {
    intent: text.trim().slice(0, 200),
    evidence: [],
    candidate: "",
    progressSummary: "",
    failedPaths: [],
  };
  const parsed = extractJsonObject(text);
  if (!parsed) return fallback;

  return {
    intent: typeof parsed.intent === "string" ? parsed.intent.trim() : fallback.intent,
    evidence: Array.isArray(parsed.evidence) ? parsed.evidence.filter(isGoalEvidenceItem) : [],
    candidate: typeof parsed.candidate === "string" ? parsed.candidate.trim() : "",
    progressSummary: typeof parsed.progressSummary === "string" ? parsed.progressSummary.trim() : "",
    failedPaths: Array.isArray(parsed.failedPaths)
      ? parsed.failedPaths.filter((path): path is string => typeof path === "string" && path.trim().length > 0)
      : [],
  };
}

export function extractJsonObject(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const source = fenced ? fenced[1] : text;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(source.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
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

function safeParseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
