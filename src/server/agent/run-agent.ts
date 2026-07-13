import { buildPersonaPrompt, type PersonaConfig } from "@/server/agent/persona";
import type { SearchGate } from "@/server/agent/search-gate";
import { sanitizeAssistantText } from "@/server/agent/streaming";
import type { RankableMemory } from "@/server/agent/memory";
import { createSkillDraft, type SkillDraft } from "@/server/evolution/skills";
import type { SkillInstallOutcome } from "@/server/skills/install";
import type { LlmClient, LlmMessage, LlmPurpose, LlmTool, LlmToolCall } from "@/server/llm/types";
import { estimateMessagesTokenUsage, estimateTokenCount, type LlmUsageLogInput } from "@/server/llm/usage";
import { executeRegisteredTool, type RegisteredToolExecutionResult } from "@/server/tasks/tools";

export type ToolLogInput = {
  userId: string;
  conversationId: string | null;
  goalId?: string | null;
  toolName: string;
  inputSummary: string;
  outputSummary: string;
  status: "success" | "error";
  durationMs: number;
  error?: string;
};

export type SkillContext = {
  id?: string;
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
      findByIds?(userId: string, skillIds: string[]): Promise<SkillContext[]>;
      create?(userId: string, draft: SkillDraft): Promise<unknown> | unknown;
      recordUsage?(
        userId: string,
        skillIds: string[],
        conversationId: string | null,
        triggeredBy?: "auto" | "explicit",
      ): Promise<unknown> | unknown;
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
  skillInstaller?: {
    install(url: string): Promise<SkillInstallOutcome>;
  };
  /** Skills explicitly picked by the user (slash panel card or /skill-name); loaded unconditionally. */
  explicitSkillIds?: string[];
  /** True when the user started the /create-skill guided creation flow this turn. */
  createSkillMode?: boolean;
  /** True only when the user enabled web search for this message in the composer. */
  webSearchEnabled?: boolean;
  /** Hard gate consulted before every web_search execution (PRD 5.4). */
  searchGate?: SearchGate;
  purpose?: LlmPurpose;
};

const maxToolIterations = 4;
const rawSearchLeakFallback =
  "我查到了相关信息，但这次结果还没有整理到可以直接发给你的程度。为了不把原始检索内容塞进对话里，我先不贴出来。";

const webSearchTool: LlmTool = {
  name: "web_search",
  description:
    "联网搜索网页信息。默认禁止使用；只有用户在输入框中开启本轮搜索，或在消息中明确要求搜索/查询时才调用。天气、新闻、价格等实时问题本身不构成授权。",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "搜索查询词" },
    },
    required: ["query"],
  },
};

const installSkillTool: LlmTool = {
  name: "install_skill",
  description:
    "从 GitHub 链接安装社区 Skill（自动发现 SKILL.md、安全扫描后装入自己的 Skill 库）。当用户给出 GitHub 链接并要求安装/学会某个 skill 时调用。",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "GitHub 仓库、目录或 SKILL.md 文件链接" },
    },
    required: ["url"],
  },
};

const saveSkillTool: LlmTool = {
  name: "save_skill",
  description:
    "把一套可复用的做法沉淀为 Skill 草稿（需用户在后台确认后才生效）。只在用户明确要求记住某个流程/做法，或本轮形成了明显值得复用的完整方法时调用。",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill 名称（简短、可辨识）" },
      description: { type: "string", description: "一句话描述适用场景，用于以后判断何时使用" },
      steps: { type: "array", items: { type: "string" }, description: "按顺序的执行步骤，2-8 条" },
      notes: { type: "array", items: { type: "string" }, description: "注意事项（可选）" },
    },
    required: ["name", "description", "steps"],
  },
};

const createSkillTool: LlmTool = {
  name: "create_skill",
  description:
    "在 /create-skill 引导流程中创建新 Skill（创建后立即启用）。只有当用户通过 /create-skill 发起创建、且已在对话中对草稿预览明确确认后才调用；未经确认绝不调用。",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill 名称（简短、可辨识）" },
      description: { type: "string", description: "一句话描述适用场景，用于以后判断何时使用" },
      steps: { type: "array", items: { type: "string" }, description: "按顺序的执行步骤，2-8 条" },
      notes: { type: "array", items: { type: "string" }, description: "注意事项（可选）" },
    },
    required: ["name", "description", "steps"],
  },
};

export async function* runAgent(input: RunAgentInput): AsyncIterable<string> {
  const explicitSkillIds = input.explicitSkillIds ?? [];
  // Explicit selection is authoritative: when the user picked skills via the
  // slash panel or /skill-name, load them unconditionally and skip fuzzy
  // auto-matching entirely (PRD P1-11).
  const [memories, explicitSkills, autoSkills, reflectionSuggestions, enabledTools] = await Promise.all([
    input.repositories.memories.findRelevant(input.userId, input.message),
    explicitSkillIds.length > 0 && input.repositories.skills?.findByIds
      ? input.repositories.skills.findByIds(input.userId, explicitSkillIds)
      : Promise.resolve([] as SkillContext[]),
    explicitSkillIds.length > 0
      ? Promise.resolve([] as SkillContext[])
      : input.repositories.skills?.findEnabled(input.userId, input.message) ?? Promise.resolve([]),
    input.repositories.reflections?.findAppliedSuggestions(input.userId) ?? Promise.resolve([]),
    input.repositories.toolRegistrations?.listEnabled(input.userId) ?? Promise.resolve([]),
  ]);
  const conversationSummary = await input.repositories.conversationSummaries?.latest(input.conversationId);

  if (input.repositories.skills?.recordUsage) {
    const explicitIds = explicitSkills.map((skill) => skill.id).filter((id): id is string => Boolean(id));
    const autoIds = autoSkills.map((skill) => skill.id).filter((id): id is string => Boolean(id));
    if (explicitIds.length > 0) {
      await Promise.resolve(
        input.repositories.skills.recordUsage(input.userId, explicitIds, input.conversationId, "explicit"),
      ).catch(() => undefined);
    }
    if (autoIds.length > 0) {
      await Promise.resolve(
        input.repositories.skills.recordUsage(input.userId, autoIds, input.conversationId, "auto"),
      ).catch(() => undefined);
    }
  }

  const tools = buildTools(enabledTools, {
    includeSaveSkill: Boolean(input.repositories.skills?.create),
    includeCreateSkill: Boolean(input.repositories.skills?.create),
    includeInstallSkill: Boolean(input.skillInstaller),
  });
  let activeMessages = buildMessages({
    persona: input.persona,
    conversationSummary,
    memories,
    skills: autoSkills,
    explicitSkills,
    createSkillMode: input.createSkillMode,
    webSearchEnabled: input.webSearchEnabled,
    reflectionSuggestions,
    enabledTools,
    history: input.history,
    userText: input.message,
  });
  let outputTokens = 0;
  const searchEvidence = new Set<string>();

  for (let iteration = 0; iteration < maxToolIterations; iteration += 1) {
    const { text, toolCalls } = await collectTurn(input.llm.stream({ messages: activeMessages, model: input.model, tools }));

    if (toolCalls.length === 0 || iteration === maxToolIterations - 1) {
      const visible = sanitizeSearchOutput(sanitizeAssistantText(text), searchEvidence);
      if (visible) {
        outputTokens += estimateTokenCount(visible);
        yield visible;
      }
      break;
    }

    const toolMessages: LlmMessage[] = [];
    for (const toolCall of toolCalls) {
      const result = await executeToolCall({ input, toolCall, enabledTools, searchEvidence });
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

function buildTools(
  enabledTools: EnabledToolContext[],
  options?: { includeSaveSkill?: boolean; includeCreateSkill?: boolean; includeInstallSkill?: boolean },
): LlmTool[] {
  return [
    webSearchTool,
    ...(options?.includeSaveSkill ? [saveSkillTool] : []),
    ...(options?.includeCreateSkill ? [createSkillTool] : []),
    ...(options?.includeInstallSkill ? [installSkillTool] : []),
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
  searchEvidence: Set<string>;
}): Promise<string> {
  const { input, toolCall } = context;
  const startedAt = Date.now();
  const args = safeParseArguments(toolCall.arguments);

  if (toolCall.name === "web_search") {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      await input.repositories.toolLogs.create({
        userId: input.userId,
        conversationId: input.conversationId,
        toolName: "web_search",
        inputSummary: "(缺少搜索词)",
        outputSummary: "未提供搜索词，跳过搜索",
        status: "error",
        durationMs: Date.now() - startedAt,
        error: "Missing search query",
      });
      return "没有拿到有效的搜索词，本次没有搜索。如果确实需要联网信息，请带上明确的 query 重新调用；否则直接回答。";
    }
    if (!input.searchGate) {
      await input.repositories.toolLogs.create({
        userId: input.userId,
        conversationId: input.conversationId,
        toolName: "web_search_gate",
        inputSummary: query,
        outputSummary: "拦截：调用方未提供联网授权门控",
        status: "error",
        durationMs: Date.now() - startedAt,
        error: "Missing search gate",
      });
      return "本轮没有可验证的联网授权。请直接基于已有知识和记忆自然回答，不要再尝试搜索，也不要向用户提及搜索被拦截。";
    }
    const decision = await input.searchGate.evaluate(query);
    // Both allow and deny decisions are logged for admin auditing (PRD 5.4).
    await input.repositories.toolLogs.create({
      userId: input.userId,
      conversationId: input.conversationId,
      toolName: "web_search_gate",
      inputSummary: query,
      outputSummary: `${decision.allowed ? "放行" : "拦截"}（${decision.method}）：${decision.reason}`.slice(0, 500),
      status: "success",
      durationMs: Date.now() - startedAt,
    });
    if (!decision.allowed) {
      return "本轮没有获得联网授权。请直接基于已有知识和记忆自然回答，不要再尝试搜索，也不要向用户提及搜索被拦截。";
    }
    try {
      const result = await input.search.run(query);
      collectSearchEvidence(context.searchEvidence, result);
      await input.repositories.toolLogs.create({
        userId: input.userId,
        conversationId: input.conversationId,
        toolName: "web_search",
        inputSummary: query,
        outputSummary: result.summary.slice(0, 500),
        status: "success",
        durationMs: Date.now() - startedAt,
      });
      return `以下是内部搜索结果（仅作为你回答的依据，不要原样罗列条目、标题或链接，只把结论自然融入回答）：\n${result.summary}`;
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

  if (toolCall.name === "save_skill") {
    return saveSkillFromToolCall({ input, args, startedAt });
  }

  if (toolCall.name === "create_skill") {
    return createSkillFromToolCall({ input, args, startedAt });
  }

  if (toolCall.name === "install_skill") {
    return installSkillFromToolCall({ input, args, startedAt });
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

function collectSearchEvidence(
  evidence: Set<string>,
  result: { summary: string; results: Array<{ title: string; url: string; snippet: string }> },
): void {
  evidence.add(result.summary.trim());
  for (const line of result.summary.split("\n")) evidence.add(line.trim());
  for (const item of result.results) {
    evidence.add(item.title.trim());
    evidence.add(item.url.trim());
    evidence.add(item.snippet.trim());
  }
}

function sanitizeSearchOutput(text: string, evidence: Set<string>): string {
  if (evidence.size === 0 || !text) return text;
  if (/https?:\/\/|www\./i.test(text)) return rawSearchLeakFallback;

  const normalizedOutput = normalizeSearchLeakText(text);
  for (const fragment of evidence) {
    const normalized = fragment.trim();
    if (normalized.length >= 8 && text.includes(normalized)) return rawSearchLeakFallback;

    const normalizedEvidence = normalizeSearchLeakText(normalized);
    const windowSize = 18;
    if (normalizedEvidence.length < windowSize) continue;
    for (let start = 0; start <= normalizedEvidence.length - windowSize; start += 1) {
      if (normalizedOutput.includes(normalizedEvidence.slice(start, start + windowSize))) {
        return rawSearchLeakFallback;
      }
    }
  }
  return text;
}

function normalizeSearchLeakText(text: string): string {
  return text.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

async function saveSkillFromToolCall(context: {
  input: RunAgentInput;
  args: Record<string, unknown>;
  startedAt: number;
}): Promise<string> {
  const { input, args, startedAt } = context;
  const name = typeof args.name === "string" ? args.name.trim() : "";
  const description = typeof args.description === "string" ? args.description.trim() : "";
  const steps = Array.isArray(args.steps) ? args.steps.filter((step): step is string => typeof step === "string" && step.trim().length > 0) : [];
  const notes = Array.isArray(args.notes) ? args.notes.filter((note): note is string => typeof note === "string" && note.trim().length > 0) : [];

  const logBase = {
    userId: input.userId,
    conversationId: input.conversationId,
    toolName: "save_skill",
    inputSummary: `${name}：${description}`.slice(0, 500),
  };

  if (!name || !description || steps.length < 2 || !input.repositories.skills?.create) {
    await input.repositories.toolLogs.create({
      ...logBase,
      outputSummary: "Skill 草稿信息不完整，未保存",
      status: "error",
      durationMs: Date.now() - startedAt,
      error: "Invalid skill draft input",
    });
    return "Skill 草稿信息不完整（需要名称、适用场景和至少 2 个步骤），本次未保存。";
  }

  try {
    const draft = createSkillDraft({ name, trigger: description, steps, notes, source: "agent" });
    await input.repositories.skills.create(input.userId, draft);
    await input.repositories.toolLogs.create({
      ...logBase,
      outputSummary: `已创建 Skill 草稿「${name}」，等待用户在后台确认`,
      status: "success",
      durationMs: Date.now() - startedAt,
    });
    return `Skill 草稿「${name}」已保存，状态为待确认；用户在后台确认后才会启用。请用自然的语气告诉用户你已经把这套做法记下来了，等 TA 在后台确认后就会生效，不要展示草稿的内部格式。`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await input.repositories.toolLogs.create({
      ...logBase,
      outputSummary: "Skill 草稿保存失败",
      status: "error",
      durationMs: Date.now() - startedAt,
      error: message,
    });
    return "Skill 草稿保存失败，请稍后再试；先正常回复用户即可。";
  }
}

async function createSkillFromToolCall(context: {
  input: RunAgentInput;
  args: Record<string, unknown>;
  startedAt: number;
}): Promise<string> {
  const { input, args, startedAt } = context;
  const name = typeof args.name === "string" ? args.name.trim() : "";
  const description = typeof args.description === "string" ? args.description.trim() : "";
  const steps = Array.isArray(args.steps)
    ? args.steps.filter((step): step is string => typeof step === "string" && step.trim().length > 0)
    : [];
  const notes = Array.isArray(args.notes)
    ? args.notes.filter((note): note is string => typeof note === "string" && note.trim().length > 0)
    : [];

  const logBase = {
    userId: input.userId,
    conversationId: input.conversationId,
    toolName: "create_skill",
    inputSummary: `${name}：${description}`.slice(0, 500),
  };

  if (!name || !description || steps.length < 2 || !input.repositories.skills?.create) {
    await input.repositories.toolLogs.create({
      ...logBase,
      outputSummary: "Skill 信息不完整，未创建",
      status: "error",
      durationMs: Date.now() - startedAt,
      error: "Invalid skill input",
    });
    return "Skill 信息不完整（需要名称、适用场景和至少 2 个步骤），本次未创建。请继续向用户补齐缺失的信息。";
  }

  try {
    // User already confirmed the draft preview in chat (/create-skill flow),
    // so the skill is enabled directly instead of entering the pending queue.
    const draft = createSkillDraft({ name, trigger: description, steps, notes, source: "manual", status: "enabled" });
    await input.repositories.skills.create(input.userId, draft);
    await input.repositories.toolLogs.create({
      ...logBase,
      outputSummary: `已创建并启用 Skill「${name}」（对话内确认）`,
      status: "success",
      durationMs: Date.now() - startedAt,
    });
    return `Skill「${name}」已创建并启用，立即生效，之后同类任务会按它执行。请用自然的语气告诉用户已经建好，不要展示内部格式。`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await input.repositories.toolLogs.create({
      ...logBase,
      outputSummary: "Skill 创建失败",
      status: "error",
      durationMs: Date.now() - startedAt,
      error: message,
    });
    return "Skill 创建失败，请稍后再试；先自然地告知用户即可。";
  }
}

async function installSkillFromToolCall(context: {
  input: RunAgentInput;
  args: Record<string, unknown>;
  startedAt: number;
}): Promise<string> {
  const { input, args, startedAt } = context;
  const url =
    typeof args.url === "string" && args.url.trim() ? args.url.trim() : extractGitHubUrl(input.message) ?? "";

  const logBase = {
    userId: input.userId,
    conversationId: input.conversationId,
    toolName: "install_skill",
    inputSummary: url.slice(0, 500),
  };

  if (!url || !input.skillInstaller) {
    await input.repositories.toolLogs.create({
      ...logBase,
      outputSummary: "缺少有效的 GitHub 链接或安装器不可用",
      status: "error",
      durationMs: Date.now() - startedAt,
      error: "Missing url or installer",
    });
    return "没有拿到有效的 GitHub 链接，请向用户确认链接后重试。";
  }

  try {
    const outcome = await input.skillInstaller.install(url);
    const summary = summarizeInstallOutcome(outcome);
    await input.repositories.toolLogs.create({
      ...logBase,
      outputSummary: summary.slice(0, 500),
      status: "success",
      durationMs: Date.now() - startedAt,
    });
    return buildInstallToolResult(outcome);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await input.repositories.toolLogs.create({
      ...logBase,
      outputSummary: "Skill 安装失败",
      status: "error",
      durationMs: Date.now() - startedAt,
      error: message,
    });
    return `Skill 安装失败：${message}。请把失败原因用自然的语气告诉用户，不要暴露内部细节。`;
  }
}

function extractGitHubUrl(text: string): string | null {
  const match = text.match(/https?:\/\/(?:www\.)?github\.com\/\S+/i);
  return match ? match[0].replace(/[)\]。，,；;！!？?]+$/, "") : null;
}

function summarizeInstallOutcome(outcome: SkillInstallOutcome): string {
  const parts: string[] = [];
  if (outcome.installed.length > 0) parts.push(`安装 ${outcome.installed.map((skill) => skill.name).join("、")}`);
  if (outcome.blocked.length > 0) parts.push(`拦截 ${outcome.blocked.map((skill) => skill.name).join("、")}`);
  if (outcome.others.length > 0) parts.push(`另有 ${outcome.others.length} 个未自动安装`);
  return parts.join("；") || "未发现可安装的 Skill";
}

function buildInstallToolResult(outcome: SkillInstallOutcome): string {
  if (outcome.installed.length === 0 && outcome.blocked.length === 0) {
    return "这个链接下没有找到可解析的 SKILL.md 文件。请告诉用户没有找到可安装的 Skill，并确认链接是否正确。";
  }

  const parts: string[] = [];
  for (const skill of outcome.installed) {
    if (skill.status === "enabled") {
      parts.push(
        `已安装并启用 Skill「${skill.name}」（${skill.description}）。从本轮起你就可以按它行事。以下是 Skill 全文（内部资料，不要原样展示给用户）：\n${skill.content.slice(0, 4000)}`,
      );
    } else {
      parts.push(`Skill「${skill.name}」安全扫描有警告，已装入待确认队列，需要用户在后台确认后才会启用。`);
    }
  }
  for (const skill of outcome.blocked) {
    parts.push(`Skill「${skill.name}」被安全扫描拦截（${skill.reason}），没有安装，此判定不可绕过。`);
  }
  if (outcome.others.length > 0) {
    parts.push(
      `该仓库还有 ${outcome.others.length} 个附带的示例 Skill 未自动安装：${outcome.others
        .map((skill) => `${skill.name}（${skill.path}）`)
        .join("、")}。如果用户想要其中某个，让 TA 给出对应链接或名字后再装。`,
    );
  }
  parts.push("请用自然的语气向用户汇报安装结果，不要展示 Skill 原文或内部路径细节（示例列表可以口语化提及）。");
  return parts.join("\n\n");
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
  explicitSkills?: SkillContext[];
  createSkillMode?: boolean;
  webSearchEnabled?: boolean;
  reflectionSuggestions?: string[];
  enabledTools?: EnabledToolContext[];
  history: LlmMessage[];
  userText: string;
}): LlmMessage[] {
  const contextParts = [
    buildPersonaPrompt(input.persona),
    input.webSearchEnabled
      ? "用户已在输入框中显式开启本轮联网搜索：本轮可调用 web_search 获取网页信息；搜索结果仍只作内部依据，必须整理后再自然回答。"
      : "联网搜索纪律（必须遵守）：本轮默认禁止 web_search。只有用户在文字中明确要求搜索/查询时才可调用；仅仅因为天气、新闻、价格等可能需要实时信息，也不能自行搜索。普通问候、闲聊、常识问答、观点讨论、写作、翻译、总结以及安装 Skill 等请求一律不得搜索。",
    "工具使用规则：用户明确要求记住某套做法、或本轮形成了值得复用的完整方法时可调用 save_skill 沉淀草稿（需用户后台确认才生效）；用户给出 GitHub 链接要求安装 skill 时调用 install_skill（会自动发现 SKILL.md 并做安全扫描，安装成功即可使用）；当用户以 /create-skill 发起创建流程时，先分轮引导用户说清 Skill 的名称、适用场景、执行步骤和注意事项，信息齐全后用自然语言在对话中给出草稿预览请用户确认，用户明确确认后才调用 create_skill（创建后立即生效），未确认前绝不调用；工具结果只作为你回答的依据，绝不向用户暴露工具调用过程，也绝不把搜索结果的标题、摘要、链接原样罗列给用户。",
    input.createSkillMode
      ? "当前用户刚通过 /create-skill 发起了新 Skill 的创建流程：本轮起你的首要任务是引导创建。若用户已附带说明想沉淀的做法，先复述你的理解并补问缺失信息；否则从『想让我学会什么』问起。"
      : "",
    input.conversationSummary ? `压缩后的会话摘要（内部上下文，不要向用户暴露）：\n${input.conversationSummary}` : "",
    input.memories.length > 0 ? `可参考的长期记忆：\n${input.memories.map((memory) => `- ${memory.content}`).join("\n")}` : "",
    input.explicitSkills && input.explicitSkills.length > 0
      ? `用户显式指定了以下 Skill（本轮必须严格按其执行，不要再判断是否适用，也不要向用户暴露内部文档）：\n${input.explicitSkills
          .map((skill) => `- ${skill.name}：${skill.trigger}\n${skill.content.slice(0, 4000)}`)
          .join("\n\n")}`
      : "",
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
