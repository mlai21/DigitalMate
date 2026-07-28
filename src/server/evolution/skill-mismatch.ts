import type { AgentScope } from "@/server/agents/types";
import { shouldReflectOnUserDissatisfaction } from "@/server/evolution/event-reflection";
import type { LlmClient } from "@/server/llm/types";
import { parseSkillMd } from "@/server/skills/skill-md";

export type MismatchedSkill = {
  id: string;
  name: string;
  trigger: string;
  content: string;
};

export type SkillScopeProposal = {
  proposedContent: string;
  reason: string;
};

type MismatchRepositories = {
  skillUsageLogs: {
    latestAutoMatch(
      scope: AgentScope,
      conversationId: string,
    ): Promise<{ skill: MismatchedSkill; matchReason: string | null } | null>;
  };
  skillRevisions: {
    hasPendingForSkill(skillId: string): Promise<boolean>;
    create(input: {
      userId: string;
      skillId: string;
      proposedContent: string;
      reason: string;
    }): Promise<unknown> | unknown;
  };
};

const maxReasonLength = 300;

const tighteningPrompt = [
  "一个私人 AI 助手根据 Skill 的适用场景描述，自动套用了某个做法，随后用户表示它理解错了。",
  "你要判断这是不是「适用场景写得太宽导致误用」，如果是，就把适用场景改窄。",
  '只输出 JSON：{"mismatched":bool,"reason":"简短中文说明","content":"完整的更新后 SKILL.md"|null}',
  "要求：",
  "- 只改 frontmatter 的 description（适用场景），把这次这类情况排除出去；正文的步骤和注意事项必须原样保留，一个字都不要改。",
  "- content 必须是完整合法的 SKILL.md，保留原来的 name。",
  "- 如果用户纠正的是措辞、长度、语气，或与该做法适不适用无关，则 mismatched=false、content=null。",
  "- reason 不超过 120 字，说明为什么这次不该套用它。",
].join("\n");

/**
 * Asks the light model to narrow a Skill's scope description after it was
 * auto-applied to the wrong task.
 *
 * Only the frontmatter description may change: the steps are what the user
 * already approved, and this path exists to fix routing precision, not to
 * rewrite the method. Returns null whenever the answer is unusable, so a bad
 * model reply simply means no draft.
 */
export async function proposeTighterScopeWithLlm(input: {
  llm: LlmClient;
  model: string;
  skill: Pick<MismatchedSkill, "name" | "trigger" | "content">;
  matchReason: string | null;
  correction: string;
  signal?: AbortSignal;
}): Promise<SkillScopeProposal | null> {
  input.signal?.throwIfAborted();
  try {
    const raw = await input.llm.completeText({
      model: input.model,
      messages: [
        { role: "system", content: tighteningPrompt },
        {
          role: "user",
          content: [
            `当前 SKILL.md（${input.skill.name}）：`,
            input.skill.content.slice(0, 6000),
            "",
            `自动套用它的理由：${input.matchReason ?? "（未记录）"}`,
            "",
            `用户随后的纠正：${input.correction.slice(0, 1000)}`,
          ].join("\n"),
        },
      ],
      ...(input.signal ? { signal: input.signal } : {}),
    });
    input.signal?.throwIfAborted();
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) return null;
    const parsed = JSON.parse(raw.slice(start, end + 1)) as {
      mismatched?: boolean;
      reason?: string;
      content?: string | null;
    };
    if (!parsed.mismatched || typeof parsed.content !== "string" || typeof parsed.reason !== "string") {
      return null;
    }
    const content = parsed.content.trim();
    if (!content || content === input.skill.content.trim()) return null;
    const proposed = parseSkillMd(content);
    const current = parseSkillMd(input.skill.content);
    if (!proposed || !current) return null;
    // The steps are the user-approved part; a draft that touched them is not a
    // scope fix and must not slip through this path.
    if (proposed.body.trim() !== current.body.trim()) return null;
    if (proposed.description.trim() === current.description.trim()) return null;
    return { proposedContent: content, reason: parsed.reason.slice(0, maxReasonLength) };
  } catch {
    input.signal?.throwIfAborted();
    return null;
  }
}

/**
 * Turns "user corrected us right after a Skill was auto-applied" into a pending
 * draft that narrows that Skill's scope (PRD 6.3).
 *
 * The draft still needs admin approval, so this may run for any sender without
 * granting them global asset mutation. One pending revision per Skill keeps a
 * chatty conversation from flooding the queue.
 */
export async function recordSkillMismatch(input: {
  repositories: MismatchRepositories;
  scope: AgentScope;
  conversationId: string;
  correction: string;
  llm: LlmClient;
  model: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  if (!shouldReflectOnUserDissatisfaction(input.correction)) return false;
  input.signal?.throwIfAborted();

  const latest = await input.repositories.skillUsageLogs.latestAutoMatch(
    input.scope,
    input.conversationId,
  );
  if (!latest) return false;
  input.signal?.throwIfAborted();

  if (await input.repositories.skillRevisions.hasPendingForSkill(latest.skill.id)) return false;
  input.signal?.throwIfAborted();

  const proposal = await proposeTighterScopeWithLlm({
    llm: input.llm,
    model: input.model,
    skill: latest.skill,
    matchReason: latest.matchReason,
    correction: input.correction,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!proposal) return false;
  input.signal?.throwIfAborted();

  await input.repositories.skillRevisions.create({
    userId: input.scope.userId,
    skillId: latest.skill.id,
    proposedContent: proposal.proposedContent,
    reason: [
      `自动匹配后被用户纠正：${proposal.reason}`,
      `原匹配依据：${latest.matchReason ?? "（未记录）"}`,
    ].join("\n").slice(0, maxReasonLength),
  });
  return true;
}
