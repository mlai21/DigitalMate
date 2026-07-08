import { z } from "zod";
import { extractRuleBasedMemories, redactSensitiveMemory, type ExtractedMemory } from "@/server/agent/memory";
import type { LlmClient } from "@/server/llm/types";

const extractionSchema = z
  .array(
    z.object({
      kind: z.enum(["episodic", "profile", "agent_self"]),
      content: z.string().min(2).max(300),
      confidence: z.number().min(0).max(1),
    }),
  )
  .max(8);

const extractionPrompt = [
  "你是记忆抽取器。从用户消息中抽取值得长期记住的事实，输出 JSON 数组，不要任何其他文字。",
  '每项格式：{"kind":"profile|episodic|agent_self","content":"...","confidence":0.0-1.0}',
  "规则：",
  "- profile：用户的稳定偏好、身份、人际关系（如“用户喜欢周末爬山”）。",
  "- episodic：有时效的事件、计划（如“用户下周五要交报销”）。",
  "- content 用第三人称陈述，以“用户”开头，简洁完整。",
  "- 不要抽取闲聊、问句、指令类内容；没有可记内容时输出 []。",
  "- 绝不抽取证件号、银行卡号、手机号、邮箱、密码、密钥等敏感信息。",
].join("\n");

/**
 * LLM-driven memory extraction using the light model. Falls back to the
 * rule-based extractor when the model output is unusable (or the mock client
 * is active), so the pipeline never silently loses messages.
 */
export async function extractMemoriesWithLlm(input: {
  llm: LlmClient;
  model: string;
  text: string;
}): Promise<ExtractedMemory[]> {
  try {
    const raw = await input.llm.completeText({
      model: input.model,
      messages: [
        { role: "system", content: extractionPrompt },
        { role: "user", content: input.text },
      ],
    });
    const jsonText = extractJsonArray(raw);
    if (!jsonText) return extractRuleBasedMemories(input.text);
    const parsed = extractionSchema.parse(JSON.parse(jsonText));
    return parsed
      .map((memory) => ({ ...memory, content: redactSensitiveMemory(memory.content) }))
      .filter((memory): memory is ExtractedMemory => Boolean(memory.content));
  } catch {
    return extractRuleBasedMemories(input.text);
  }
}

function extractJsonArray(text: string): string | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
}
