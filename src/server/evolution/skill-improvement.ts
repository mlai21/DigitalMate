import type { LlmClient } from "@/server/llm/types";
import { parseSkillMd } from "@/server/skills/skill-md";

export const SKILL_IMPROVEMENT_USAGE_THRESHOLD = 5;

const MAX_CONVERSATIONS = 3;
const MAX_MESSAGES_PER_CONVERSATION = 10;

export type SkillRevisionProposal = {
  proposedContent: string;
  reason: string;
};

type ImprovableSkill = {
  id: string;
  name: string;
  trigger: string;
  content: string;
};

type ImprovementRepositories = {
  skills: {
    listEnabled(userId: string): Promise<ImprovableSkill[]>;
  };
  skillRevisions: {
    create(input: { userId: string; skillId: string; proposedContent: string; reason: string }): Promise<unknown> | unknown;
    hasPendingForSkill(skillId: string): Promise<boolean>;
    latestForSkill(skillId: string): Promise<{ createdAt: Date } | null>;
  };
  skillUsageLogs: {
    countSince(skillId: string, since: Date | null): Promise<number>;
    recentConversationIds(skillId: string, limit: number): Promise<string[]>;
  };
  messages: {
    list(conversationId: string): Promise<Array<{ role: string; content: string }>>;
  };
};

export function shouldProposeRevision(input: {
  usageSinceLastRevision: number;
  hasPendingRevision: boolean;
  threshold?: number;
}): boolean {
  if (input.hasPendingRevision) return false;
  return input.usageSinceLastRevision >= (input.threshold ?? SKILL_IMPROVEMENT_USAGE_THRESHOLD);
}

const improvementPrompt = [
  "你是一个私人 AI 助手的 Skill 自我改进模块。给你一份当前的 SKILL.md 和它最近实际被使用的对话片段，判断这个 Skill 是否需要更新。",
  '只输出 JSON：{"needsUpdate":bool,"reason":"简短中文说明改了什么、为什么","content":"完整的更新后 SKILL.md"|null}',
  "要求：",
  "- 只做增量修订（补充遗漏步骤、修正过时做法、吸收实际使用中发现的更优路径），不要推翻重写。",
  "- content 必须是完整合法的 SKILL.md（保留 frontmatter 的 name/description，description 可微调）。",
  "- 如果实际使用中没有暴露任何问题或改进点，needsUpdate=false、content=null。",
  "- reason 不超过 120 字。",
].join("\n");

/**
 * Asks the light model whether a frequently used skill needs an incremental
 * revision based on how it was actually used. Returns null when no update is
 * warranted or the model output is unusable.
 */
export async function proposeSkillRevisionWithLlm(input: {
  llm: LlmClient;
  model: string;
  skill: { name: string; trigger: string; content: string };
  usageContext: string;
}): Promise<SkillRevisionProposal | null> {
  try {
    const raw = await input.llm.completeText({
      model: input.model,
      messages: [
        { role: "system", content: improvementPrompt },
        {
          role: "user",
          content: [
            `当前 SKILL.md（${input.skill.name}）：`,
            input.skill.content.slice(0, 6000),
            "",
            "最近的实际使用片段：",
            input.usageContext.slice(0, 6000),
          ].join("\n"),
        },
      ],
    });
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) return null;
    const parsed = JSON.parse(raw.slice(start, end + 1)) as {
      needsUpdate?: boolean;
      reason?: string;
      content?: string | null;
    };
    if (!parsed.needsUpdate || typeof parsed.content !== "string" || typeof parsed.reason !== "string") return null;
    const content = parsed.content.trim();
    if (!content || content === input.skill.content.trim()) return null;
    if (!parseSkillMd(content)) return null;
    return { proposedContent: content, reason: parsed.reason.slice(0, 300) };
  } catch {
    return null;
  }
}

/**
 * Scans enabled skills and creates pending revision drafts for the ones that
 * crossed the usage threshold since their last revision. Revisions only take
 * effect after the user approves them in the admin console.
 */
export async function processSkillImprovement(input: {
  repositories: ImprovementRepositories;
  llm: LlmClient;
  model: string;
  userId: string;
  threshold?: number;
}): Promise<{ proposed: number }> {
  const skills = await input.repositories.skills.listEnabled(input.userId);
  let proposed = 0;

  for (const skill of skills) {
    const hasPending = await input.repositories.skillRevisions.hasPendingForSkill(skill.id);
    if (hasPending) continue;

    const latestRevision = await input.repositories.skillRevisions.latestForSkill(skill.id);
    const usage = await input.repositories.skillUsageLogs.countSince(skill.id, latestRevision?.createdAt ?? null);
    if (!shouldProposeRevision({ usageSinceLastRevision: usage, hasPendingRevision: hasPending, threshold: input.threshold })) {
      continue;
    }

    const usageContext = await buildUsageContext(input.repositories, skill.id);
    if (!usageContext) continue;

    const proposal = await proposeSkillRevisionWithLlm({ llm: input.llm, model: input.model, skill, usageContext });
    if (!proposal) continue;

    await input.repositories.skillRevisions.create({
      userId: input.userId,
      skillId: skill.id,
      proposedContent: proposal.proposedContent,
      reason: proposal.reason,
    });
    proposed += 1;
  }

  return { proposed };
}

async function buildUsageContext(repositories: ImprovementRepositories, skillId: string): Promise<string> {
  const conversationIds = await repositories.skillUsageLogs.recentConversationIds(skillId, MAX_CONVERSATIONS);
  const snippets: string[] = [];
  for (const conversationId of conversationIds) {
    const messages = await repositories.messages.list(conversationId);
    const recent = messages.slice(-MAX_MESSAGES_PER_CONVERSATION);
    if (recent.length === 0) continue;
    snippets.push(
      recent.map((message) => `${message.role === "user" ? "用户" : "助手"}：${message.content.slice(0, 300)}`).join("\n"),
    );
  }
  return snippets.join("\n---\n");
}
