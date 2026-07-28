import { z } from "zod";

import type { SkillContext } from "@/server/agent/run-agent";
import type { AgentScope } from "@/server/agents/types";
import type { LlmClient } from "@/server/llm/types";

/** A Skill as shown to the router: index only, never the full body. */
export type SkillCandidate = {
  id: string;
  name: string;
  trigger: string;
};

export type SkillRouteDecision = {
  skillId: string;
  reason: string;
};

/**
 * How many enabled Skills can take part in auto-matching for one agent.
 *
 * Single source of truth for both the catalog query and the router, so a Skill
 * is never silently invisible to routing while still being listed everywhere
 * else. Matches the other per-agent Skill queries; beyond it the least recently
 * used Skills drop out first (see `listEnabledIndex`).
 */
export const SKILL_ROUTING_CATALOG_LIMIT = 100;

const maxReasonLength = 300;

const decisionSchema = z.object({
  skill: z.union([z.number(), z.string()]),
  reason: z.string().optional(),
});

const routingPrompt = [
  "你要判断用户这条消息该不该套用某个已有的做法（Skill），像同事回想“这事我们有没有现成流程”那样。",
  '输出 JSON 对象，不要任何其他文字，格式：{"skill":<编号或 0>,"reason":"一句话说明依据"}',
  "规则：",
  "- 只有当用户这条消息要做的事，正好就是某个 Skill 适用场景描述的那件事时，才填它的编号。",
  "- 有两个及以上 Skill 同样贴合时填 0，不要挑一个凑。",
  "- 用户只是闲聊、寒暄、问一个事实或让你改写文字时填 0。",
  "- 拿不准就填 0：宁可不用，也不可误用（用错做法比不用更糟）。",
  "- reason 用一句话说明为什么选它或为什么都不选，供人事后核对。",
].join("\n");

/**
 * Asks the light model to pick at most one Skill for this message.
 *
 * Deliberately biased towards picking nothing: an unusable answer, an unknown
 * index or an unavailable model all resolve to null, because loading the wrong
 * Skill is worse than loading none (PRD 6.3).
 */
export async function routeSkillWithLlm(input: {
  llm: LlmClient;
  model: string;
  message: string;
  candidates: SkillCandidate[];
  signal?: AbortSignal;
}): Promise<SkillRouteDecision | null> {
  const message = input.message.trim();
  const candidates = input.candidates.slice(0, SKILL_ROUTING_CATALOG_LIMIT);
  if (!message || candidates.length === 0) return null;
  input.signal?.throwIfAborted();

  const catalog = candidates
    .map((candidate, index) => `${index + 1}. ${candidate.name}｜适用场景：${candidate.trigger}`)
    .join("\n");

  let raw: string;
  try {
    raw = await input.llm.completeText({
      model: input.model,
      messages: [
        { role: "system", content: routingPrompt },
        { role: "user", content: `可选做法：\n${catalog}\n\n用户消息：\n${message}` },
      ],
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return null;
  }

  try {
    const jsonText = extractJsonObject(raw);
    if (!jsonText) return null;
    const parsed = decisionSchema.parse(JSON.parse(jsonText));
    const index = typeof parsed.skill === "number"
      ? parsed.skill
      : Number.parseInt(parsed.skill, 10);
    if (!Number.isInteger(index) || index < 1 || index > candidates.length) return null;
    const chosen = candidates[index - 1];
    if (!chosen) return null;
    return {
      skillId: chosen.id,
      reason: (parsed.reason ?? "").trim().slice(0, maxReasonLength),
    };
  } catch {
    return null;
  }
}

/**
 * Builds a `findEnabled`-compatible auto-matcher backed by the light model.
 *
 * Progressive disclosure (PRD 6.3): the router only ever sees the Skill index,
 * and the full body is loaded by id after a hit. Any failure degrades to "no
 * Skill this turn" so auto-matching can never break the reply itself.
 */
export function createLlmSkillMatcher(input: {
  llm: LlmClient;
  model: string;
  repositories: {
    skills: {
      listEnabledIndex(scope: AgentScope): Promise<SkillCandidate[]>;
      findByIds(scope: AgentScope, skillIds: string[]): Promise<SkillContext[]>;
    };
  };
}): (scope: AgentScope, query: string, signal?: AbortSignal) => Promise<SkillContext[]> {
  return async (scope, query, signal) => {
    try {
      const candidates = await input.repositories.skills.listEnabledIndex(scope);
      const decision = await routeSkillWithLlm({
        llm: input.llm,
        model: input.model,
        message: query,
        candidates,
        ...(signal ? { signal } : {}),
      });
      if (!decision) return [];
      const loaded = await input.repositories.skills.findByIds(scope, [decision.skillId]);
      return loaded.map((skill) => ({ ...skill, matchReason: decision.reason }));
    } catch (error) {
      if (signal?.aborted) throw error;
      return [];
    }
  };
}

/**
 * Swaps a repository set's `findEnabled` for the light-model matcher, so the
 * Web path auto-matches through the router without threading a separate seam
 * into runAgent. Attachment and explicit-Skill turns never reach `findEnabled`,
 * so no routing call happens there.
 */
export function withLlmSkillMatching<
  T extends {
    skills: {
      listEnabledIndex(scope: AgentScope): Promise<SkillCandidate[]>;
      findByIds(scope: AgentScope, skillIds: string[]): Promise<SkillContext[]>;
    };
  },
>(repositories: T, light: { client: LlmClient; model: string }): T {
  return {
    ...repositories,
    skills: {
      ...repositories.skills,
      findEnabled: createLlmSkillMatcher({
        llm: light.client,
        model: light.model,
        repositories,
      }),
    },
  };
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
}
