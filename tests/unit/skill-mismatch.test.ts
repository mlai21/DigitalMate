import { describe, expect, it, vi } from "vitest";

import {
  proposeTighterScopeWithLlm,
  recordSkillMismatch,
} from "@/server/evolution/skill-mismatch";
import type { LlmClient } from "@/server/llm/types";

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

const scope = { userId: "user-1", agentId: "agent-1" };

const skill = {
  id: "skill-1",
  name: "商机资格判断",
  trigger: "客户需求模糊时",
  content: [
    "---",
    "name: 商机资格判断",
    "description: 客户需求模糊时",
    "---",
    "# 商机资格判断",
    "",
    "## 步骤",
    "1. 先确认决策链",
  ].join("\n"),
};

const tightened = [
  "---",
  "name: 商机资格判断",
  "description: 客户预算或决策链不清楚、需要判断这单值不值得推进时（不适用于纯技术选型问题）",
  "---",
  "# 商机资格判断",
  "",
  "## 步骤",
  "1. 先确认决策链",
].join("\n");

function fakeRepositories(overrides?: {
  latestAutoMatch?: unknown;
  hasPendingForSkill?: boolean;
}) {
  return {
    skillUsageLogs: {
      latestAutoMatch: vi.fn(async () => (
        "latestAutoMatch" in (overrides ?? {})
          ? overrides?.latestAutoMatch
          : { skill, matchReason: "以为用户在判断商机" }
      )),
    },
    skillRevisions: {
      hasPendingForSkill: vi.fn(async () => overrides?.hasPendingForSkill ?? false),
      create: vi.fn(),
    },
  } as never as Parameters<typeof recordSkillMismatch>[0]["repositories"];
}

describe("proposeTighterScopeWithLlm", () => {
  it("产出只收紧适用场景、保留步骤的完整 SKILL.md", async () => {
    const llm = completeLlm(JSON.stringify({
      mismatched: true,
      reason: "用户其实在问技术选型，不是判断商机是否推进",
      content: tightened,
    }));

    const proposal = await proposeTighterScopeWithLlm({
      llm,
      model: "light",
      skill,
      matchReason: "以为用户在判断商机",
      correction: "你理解错了，我问的是模型怎么选",
    });

    expect(proposal?.proposedContent).toBe(tightened);
    expect(proposal?.reason).toContain("技术选型");
  });

  it("模型认为不是误匹配时不产出草稿", async () => {
    const llm = completeLlm(JSON.stringify({
      mismatched: false,
      reason: "用户纠正的是措辞，不是用错了做法",
      content: null,
    }));

    await expect(proposeTighterScopeWithLlm({
      llm,
      model: "light",
      skill,
      matchReason: "以为用户在判断商机",
      correction: "说得太长了",
    })).resolves.toBeNull();
  });

  it("步骤被改动、内容非法或与原文相同都拒绝", async () => {
    const rewritesSteps = completeLlm(JSON.stringify({
      mismatched: true,
      reason: "顺手重写了步骤",
      content: [
        "---",
        "name: 商机资格判断",
        "description: 更精确的场景",
        "---",
        "# 商机资格判断",
        "",
        "## 步骤",
        "1. 换一套完全不同的步骤",
      ].join("\n"),
    }));
    const invalid = completeLlm(JSON.stringify({
      mismatched: true,
      reason: "内容不是 SKILL.md",
      content: "随便一段话",
    }));
    const unchanged = completeLlm(JSON.stringify({
      mismatched: true,
      reason: "没改",
      content: skill.content,
    }));

    for (const llm of [rewritesSteps, invalid, unchanged]) {
      await expect(proposeTighterScopeWithLlm({
        llm,
        model: "light",
        skill,
        matchReason: "以为用户在判断商机",
        correction: "你理解错了",
      })).resolves.toBeNull();
    }
  });

  it("模型不可用时降级为不产出，不抛错", async () => {
    const failing: LlmClient = {
      async *stream() {},
      async completeText() {
        throw new Error("light unavailable");
      },
    };

    await expect(proposeTighterScopeWithLlm({
      llm: failing,
      model: "light",
      skill,
      matchReason: "以为用户在判断商机",
      correction: "你理解错了",
    })).resolves.toBeNull();
  });
});

describe("recordSkillMismatch", () => {
  const correction = "你理解错了，我问的是模型怎么选";
  const usableLlm = () => completeLlm(JSON.stringify({
    mismatched: true,
    reason: "用户其实在问技术选型",
    content: tightened,
  }));

  it("纠正且本会话刚自动命中过时，产出待确认的收紧草稿", async () => {
    const repositories = fakeRepositories();

    await expect(recordSkillMismatch({
      repositories,
      scope,
      conversationId: "conversation-1",
      correction,
      llm: usableLlm(),
      model: "light",
    })).resolves.toBe(true);

    expect(repositories.skillUsageLogs.latestAutoMatch)
      .toHaveBeenCalledWith(scope, "conversation-1");
    expect(repositories.skillRevisions.create).toHaveBeenCalledWith({
      userId: "user-1",
      skillId: "skill-1",
      proposedContent: tightened,
      reason: expect.stringContaining("自动匹配"),
    });
  });

  it("不像纠正的消息直接跳过，不查库也不调模型", async () => {
    const repositories = fakeRepositories();
    const completeText = vi.fn();

    await expect(recordSkillMismatch({
      repositories,
      scope,
      conversationId: "conversation-1",
      correction: "好的，谢谢",
      llm: { async *stream() {}, completeText } as never as LlmClient,
      model: "light",
    })).resolves.toBe(false);

    expect(repositories.skillUsageLogs.latestAutoMatch).not.toHaveBeenCalled();
    expect(completeText).not.toHaveBeenCalled();
    expect(repositories.skillRevisions.create).not.toHaveBeenCalled();
  });

  it("本会话没有自动命中记录时不产出草稿", async () => {
    const repositories = fakeRepositories({ latestAutoMatch: null });

    await expect(recordSkillMismatch({
      repositories,
      scope,
      conversationId: "conversation-1",
      correction,
      llm: usableLlm(),
      model: "light",
    })).resolves.toBe(false);
    expect(repositories.skillRevisions.create).not.toHaveBeenCalled();
  });

  it("同一 Skill 已有待确认修订时不再堆叠", async () => {
    const repositories = fakeRepositories({ hasPendingForSkill: true });

    await expect(recordSkillMismatch({
      repositories,
      scope,
      conversationId: "conversation-1",
      correction,
      llm: usableLlm(),
      model: "light",
    })).resolves.toBe(false);
    expect(repositories.skillRevisions.create).not.toHaveBeenCalled();
  });

  it("草稿理由里带上原匹配依据，便于事后核对", async () => {
    const repositories = fakeRepositories();

    await recordSkillMismatch({
      repositories,
      scope,
      conversationId: "conversation-1",
      correction,
      llm: usableLlm(),
      model: "light",
    });

    const created = vi.mocked(repositories.skillRevisions.create).mock.calls[0][0];
    expect(created.reason).toContain("以为用户在判断商机");
  });
});
