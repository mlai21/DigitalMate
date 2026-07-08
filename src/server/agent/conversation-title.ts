import type { LlmClient } from "@/server/llm/types";

const titlePrompt = [
  "根据这轮对话生成一个简短的会话标题，直接输出标题文字，不要引号、句号或任何解释。",
  "要求：不超过 12 个字，概括对话主题，用与对话相同的语言。",
].join("\n");

/**
 * Generate a short conversation title with the light model; falls back to a
 * truncated form of the first user message when the model is unavailable.
 */
export async function generateConversationTitle(input: {
  llm: LlmClient;
  model: string;
  userText: string;
  assistantText: string;
}): Promise<string> {
  try {
    const raw = await input.llm.completeText({
      model: input.model,
      messages: [
        { role: "system", content: titlePrompt },
        { role: "user", content: `用户：${input.userText.slice(0, 800)}\n助手：${input.assistantText.slice(0, 800)}` },
      ],
    });
    const title = raw.replace(/["'“”‘’。.\n\r]+/g, " ").trim();
    if (title.length >= 2 && title.length <= 40) return title;
  } catch {
    // fall through to the truncated fallback
  }
  return fallbackConversationTitle(input.userText);
}

export function fallbackConversationTitle(userText: string): string {
  const compact = userText.replace(/\s+/g, " ").trim();
  return compact.length > 20 ? `${compact.slice(0, 20)}…` : compact || "新的对话";
}
