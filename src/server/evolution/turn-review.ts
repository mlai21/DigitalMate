import { z } from "zod";
import type { LlmClient } from "@/server/llm/types";
import type { ReflectionRecord } from "@/server/evolution/reflection";
import type { SkillDraft } from "@/server/evolution/skills";
import { createSkillDraft } from "@/server/evolution/skills";

export type TurnReviewResult = {
  reflection: ReflectionRecord | null;
  skillDraft: SkillDraft | null;
};

const reviewSchema = z.object({
  worthRecording: z.boolean(),
  positives: z.array(z.string()).max(2).default([]),
  negatives: z.array(z.string()).max(2).default([]),
  suggestions: z.array(z.string()).max(2).default([]),
  skill: z
    .object({
      name: z.string().min(2).max(60),
      trigger: z.string().min(2).max(200),
      steps: z.array(z.string().min(2).max(200)).min(2).max(8),
    })
    .nullable()
    .default(null),
});

const reviewPrompt = [
  "你是一个私人 AI 助手的轮后复盘模块。给你一轮对话（用户消息 + 助手回复），判断有没有值得沉淀的东西，输出 JSON 对象，不要任何其他文字。",
  '格式：{"worthRecording":bool,"positives":["..."],"negatives":["..."],"suggestions":["..."],"skill":{"name":"...","trigger":"...","steps":["..."]}|null}',
  "判断标准（Hermes 式）：",
  "- worthRecording=true 仅当：用户纠正了助手的做法；助手踩坑后找到了正确路径；或首次成功完成一类可复用的复杂任务。日常闲聊一律 false。",
  "- suggestions：下次对话可执行的具体行为修正（如“先给结论再解释”），最多 2 条，每条不超过 60 字。",
  "- skill：只有当这轮对话形成了一套可复用的做法时才给出（名称、适用场景、步骤），否则为 null。",
  "- 反思只写入后台，绝不出现在对话输出中。",
].join("\n");

/**
 * Hermes-style lightweight per-turn background review: runs on the light
 * model after a turn completes, and proposes behavior corrections and skill
 * drafts. Returns null when the turn carries nothing worth recording.
 */
export async function reviewTurnWithLlm(input: {
  llm: LlmClient;
  model: string;
  userText: string;
  assistantText: string;
}): Promise<TurnReviewResult | null> {
  try {
    const raw = await input.llm.completeText({
      model: input.model,
      messages: [
        { role: "system", content: reviewPrompt },
        { role: "user", content: `用户：${input.userText.slice(0, 2000)}\n\n助手：${input.assistantText.slice(0, 2000)}` },
      ],
    });
    const jsonText = extractJsonObject(raw);
    if (!jsonText) return null;
    const parsed = reviewSchema.parse(JSON.parse(jsonText));
    if (!parsed.worthRecording) return null;

    const hasReflection = parsed.positives.length + parsed.negatives.length + parsed.suggestions.length > 0;
    return {
      reflection: hasReflection
        ? { positives: parsed.positives, negatives: parsed.negatives, suggestions: parsed.suggestions }
        : null,
      skillDraft: parsed.skill
        ? createSkillDraft({ name: parsed.skill.name, trigger: parsed.skill.trigger, steps: parsed.skill.steps, source: "agent" })
        : null,
    };
  } catch {
    return null;
  }
}

type TurnReviewRepositories = {
  reflections: {
    create(input: { userId: string; reflection: ReflectionRecord; sourceWindow?: unknown }): Promise<unknown> | unknown;
  };
  skills: {
    create(userId: string, draft: SkillDraft): Promise<unknown> | unknown;
  };
};

export async function recordTurnReview(
  repositories: TurnReviewRepositories,
  input: {
    userId: string;
    conversationId: string;
    llm: LlmClient;
    model: string;
    userText: string;
    assistantText: string;
  },
): Promise<TurnReviewResult | null> {
  const result = await reviewTurnWithLlm(input);
  if (!result) return null;

  if (result.reflection) {
    await repositories.reflections.create({
      userId: input.userId,
      reflection: result.reflection,
      sourceWindow: { event: "turn_review", conversationId: input.conversationId },
    });
  }
  if (result.skillDraft) {
    await repositories.skills.create(input.userId, result.skillDraft);
  }
  return result;
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
}
