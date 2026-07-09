import { describe, expect, it, vi } from "vitest";
import {
  processSkillImprovement,
  proposeSkillRevisionWithLlm,
  shouldProposeRevision,
} from "@/server/evolution/skill-improvement";
import type { LlmClient } from "@/server/llm/types";

const updatedSkillMd = ["---", "name: 周报整理", "description: 整理周报", "---", "", "# 周报整理", "", "## 步骤", "1. 收集更新", "2. 标注风险"].join(
  "\n",
);

function completeLlm(reply: string): LlmClient {
  return {
    async *stream() {
      yield { type: "text", text: reply };
    },
    async completeText() {
      return reply;
    },
  };
}

const baseSkill = {
  id: "s1",
  name: "周报整理",
  trigger: "整理周报",
  content: "---\nname: 周报整理\ndescription: 整理周报\n---\n\n# 周报整理\n\n## 步骤\n1. 收集更新",
};

function buildRepositories(overrides?: {
  usageCount?: number;
  hasPending?: boolean;
}) {
  return {
    skills: { listEnabled: async () => [baseSkill] },
    skillRevisions: {
      create: vi.fn(),
      hasPendingForSkill: async () => overrides?.hasPending ?? false,
      latestForSkill: async () => null,
    },
    skillUsageLogs: {
      countSince: async () => overrides?.usageCount ?? 5,
      recentConversationIds: async () => ["c1"],
    },
    messages: {
      list: async () => [
        { role: "user", content: "帮我整理周报，记得标一下风险" },
        { role: "assistant", content: "好，我按步骤整理，补上风险栏。" },
      ],
    },
  };
}

describe("shouldProposeRevision", () => {
  it("requires the usage threshold and no pending revision", () => {
    expect(shouldProposeRevision({ usageSinceLastRevision: 5, hasPendingRevision: false })).toBe(true);
    expect(shouldProposeRevision({ usageSinceLastRevision: 4, hasPendingRevision: false })).toBe(false);
    expect(shouldProposeRevision({ usageSinceLastRevision: 10, hasPendingRevision: true })).toBe(false);
    expect(shouldProposeRevision({ usageSinceLastRevision: 2, hasPendingRevision: false, threshold: 2 })).toBe(true);
  });
});

describe("proposeSkillRevisionWithLlm", () => {
  it("returns a proposal when the model suggests a valid update", async () => {
    const proposal = await proposeSkillRevisionWithLlm({
      llm: completeLlm(JSON.stringify({ needsUpdate: true, reason: "实际使用中用户每次都要求标注风险", content: updatedSkillMd })),
      model: "light",
      skill: baseSkill,
      usageContext: "用户：记得标风险",
    });

    expect(proposal?.reason).toContain("标注风险");
    expect(proposal?.proposedContent).toContain("标注风险");
  });

  it("returns null when no update is needed or output is unusable", async () => {
    expect(
      await proposeSkillRevisionWithLlm({
        llm: completeLlm('{"needsUpdate":false,"reason":"","content":null}'),
        model: "light",
        skill: baseSkill,
        usageContext: "…",
      }),
    ).toBeNull();
    expect(
      await proposeSkillRevisionWithLlm({
        llm: completeLlm("挺好的不用改"),
        model: "light",
        skill: baseSkill,
        usageContext: "…",
      }),
    ).toBeNull();
  });

  it("rejects proposals that are not valid SKILL.md or unchanged", async () => {
    expect(
      await proposeSkillRevisionWithLlm({
        llm: completeLlm(JSON.stringify({ needsUpdate: true, reason: "改了", content: "没有标题的内容" })),
        model: "light",
        skill: baseSkill,
        usageContext: "…",
      }),
    ).toBeNull();
    expect(
      await proposeSkillRevisionWithLlm({
        llm: completeLlm(JSON.stringify({ needsUpdate: true, reason: "没变", content: baseSkill.content })),
        model: "light",
        skill: baseSkill,
        usageContext: "…",
      }),
    ).toBeNull();
  });
});

describe("processSkillImprovement", () => {
  const llm = completeLlm(JSON.stringify({ needsUpdate: true, reason: "补充风险标注步骤", content: updatedSkillMd }));

  it("creates a pending revision for a frequently used skill", async () => {
    const repositories = buildRepositories({ usageCount: 5 });

    const outcome = await processSkillImprovement({ repositories, llm, model: "light", userId: "u1" });

    expect(outcome.proposed).toBe(1);
    expect(repositories.skillRevisions.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", skillId: "s1", reason: "补充风险标注步骤" }),
    );
  });

  it("skips skills below the usage threshold", async () => {
    const repositories = buildRepositories({ usageCount: 3 });

    const outcome = await processSkillImprovement({ repositories, llm, model: "light", userId: "u1" });

    expect(outcome.proposed).toBe(0);
    expect(repositories.skillRevisions.create).not.toHaveBeenCalled();
  });

  it("does not stack revisions when one is already pending", async () => {
    const repositories = buildRepositories({ usageCount: 10, hasPending: true });

    const outcome = await processSkillImprovement({ repositories, llm, model: "light", userId: "u1" });

    expect(outcome.proposed).toBe(0);
    expect(repositories.skillRevisions.create).not.toHaveBeenCalled();
  });
});
