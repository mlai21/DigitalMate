import type { LlmClient } from "@/server/llm/types";

export type ReflectionRecord = {
  positives: string[];
  negatives: string[];
  suggestions: string[];
};

const llmReflectionPrompt = [
  "你是一个私人 AI 助手的自我反思模块。请回顾今天的对话记录，评估助手的表现，输出 JSON 对象，不要任何其他文字。",
  '格式：{"positives":["..."],"negatives":["..."],"suggestions":["..."]}',
  "规则：",
  "- positives：今天做得好的地方（语气、判断、帮助程度），最多 3 条。",
  "- negatives：做得不好或用户表现出不满的地方，最多 3 条。",
  "- suggestions：下次对话可执行的具体行为修正（如“少追问、先给结论”），最多 3 条。",
  "- 每条不超过 60 字；没有内容的维度输出空数组。",
  "- 反思只写入后台记录，绝不出现在对话输出中。",
].join("\n");

/**
 * LLM-generated daily reflection. Returns null when the model output cannot
 * be parsed so the caller can fall back to a conservative template.
 */
export async function generateReflectionWithLlm(input: {
  llm: LlmClient;
  model: string;
  digest: string;
}): Promise<ReflectionRecord | null> {
  try {
    const raw = await input.llm.completeText({
      model: input.model,
      messages: [
        { role: "system", content: llmReflectionPrompt },
        { role: "user", content: input.digest },
      ],
    });
    const jsonText = extractJsonObject(raw);
    if (!jsonText) return null;
    const parsed = JSON.parse(jsonText) as Partial<Record<keyof ReflectionRecord, unknown>>;
    const record: ReflectionRecord = {
      positives: toStringList(parsed.positives),
      negatives: toStringList(parsed.negatives),
      suggestions: toStringList(parsed.suggestions),
    };
    if (record.positives.length + record.negatives.length + record.suggestions.length === 0) return null;
    return record;
  } catch {
    return null;
  }
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 3);
}

export function buildReflectionPrompt(input: { messages: string[]; toolFailures: string[] }): string {
  return [
    "请回顾以下对话与工具表现，生成结构化反思，只写入后台反思记录，不要出现在对话输出中。",
    "输出格式：做得好：...。需要改进：...。建议：...。",
    "",
    "对话摘要：",
    ...input.messages.map((message) => `- ${message}`),
    "",
    "工具失败：",
    ...(input.toolFailures.length ? input.toolFailures.map((failure) => `- ${failure}`) : ["- 无"]),
  ].join("\n");
}

export function normalizeReflection(text: string): ReflectionRecord {
  return {
    positives: extractSection(text, "做得好"),
    negatives: extractSection(text, "需要改进"),
    suggestions: extractSection(text, "建议"),
  };
}

export function shouldRunDailyReflection(now: Date, lastReflectionAt: Date | null): boolean {
  if (!lastReflectionAt) return true;
  return now.getTime() - lastReflectionAt.getTime() >= 24 * 60 * 60 * 1000;
}

function extractSection(text: string, label: string): string[] {
  const pattern = new RegExp(`${label}[：:]([^。]+)`);
  const match = text.match(pattern);
  if (!match) return [];
  return match[1]
    .split(/[、,，；;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}
