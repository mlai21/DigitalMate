import { z } from "zod";

import {
  CHANNEL_REACTIONS,
  type ChannelReaction,
} from "@/server/channels/runtime/types";
import type { LlmClient } from "@/server/llm/types";

// "pending" is the runtime's own busy marker, so the model never picks it.
const SELECTABLE = CHANNEL_REACTIONS.filter(
  (reaction) => reaction !== "pending",
);

const selectionSchema = z.object({
  reaction: z.enum(["none", ...SELECTABLE] as [string, ...string[]]),
});

const selectionPrompt = [
  "你要为一条用户消息选一个表态，像同事顺手贴个表情那样。",
  '输出 JSON 对象，不要任何其他文字，格式：{"reaction":"..."}',
  "可选值及含义：",
  "- acknowledged：用户交代了一件事或提了要求，表示已收到。",
  "- good_question：用户问了一个有意思、值得展开的问题。",
  "- agreed：用户表达了观点或判断，而你认同它。",
  "- done：用户在确认某件事已经办完，或表示感谢、收尾。",
  "- none：普通闲聊、寒暄，或没有明显值得表态的内容。",
  "规则：",
  "- 拿不准就选 none，宁可不贴也不要贴错。",
  "- 只依据这条消息本身判断，不要臆测上下文。",
].join("\n");

/**
 * Picks the reaction to leave on the user's message once the reply lands.
 * Runs on the light model alongside the main turn, and resolves to null
 * whenever the model is unavailable or its answer is unusable, so a missing
 * reaction never blocks or delays the reply.
 */
export async function chooseReactionIntent(input: {
  llm: LlmClient;
  model: string;
  text: string;
  signal?: AbortSignal;
}): Promise<ChannelReaction | null> {
  const text = input.text.trim();
  if (!text) return null;
  try {
    input.signal?.throwIfAborted();
    const raw = await input.llm.completeText({
      model: input.model,
      messages: [
        { role: "system", content: selectionPrompt },
        { role: "user", content: text },
      ],
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const jsonText = extractJsonObject(raw);
    if (!jsonText) return null;
    const parsed = selectionSchema.parse(JSON.parse(jsonText));
    return parsed.reaction === "none"
      ? null
      : parsed.reaction as ChannelReaction;
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
