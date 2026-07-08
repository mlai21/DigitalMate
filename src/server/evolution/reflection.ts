export type ReflectionRecord = {
  positives: string[];
  negatives: string[];
  suggestions: string[];
};

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
