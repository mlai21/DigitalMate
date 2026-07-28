import { describe, expect, it, vi } from "vitest";

import {
  createLlmSkillMatcher,
  routeSkillWithLlm,
  SKILL_ROUTING_CATALOG_LIMIT,
  type SkillCandidate,
} from "@/server/agent/skill-routing";
import type { LlmClient } from "@/server/llm/types";

function completeLlm(reply: string | (() => string)): LlmClient {
  return {
    async *stream() {
      yield { type: "text", text: typeof reply === "string" ? reply : reply() };
    },
    async completeText() {
      return typeof reply === "string" ? reply : reply();
    },
  };
}

const candidates: SkillCandidate[] = [
  {
    id: "skill-discovery",
    name: "客户需求发现与商机资格判断",
    trigger: "客户需求模糊、需要判断商机是否值得推进时",
  },
  {
    id: "skill-tco",
    name: "容量、性能、成本与 TCO 估算",
    trigger: "客户问要多少卡、能撑多少并发、一年多少钱时",
  },
];

const scope = { userId: "user-1", agentId: "agent-1" };

describe("skill routing", () => {
  it("选中候选并返回可留痕的匹配依据", async () => {
    const llm = completeLlm(
      '{"skill":2,"reason":"用户在问需要多少卡和一年成本，正好是 TCO 估算的场景"}',
    );

    const decision = await routeSkillWithLlm({
      llm,
      model: "light",
      message: "客户问 70B 推理要多少卡，一年成本大概多少",
      candidates,
    });

    expect(decision).toEqual({
      skillId: "skill-tco",
      reason: "用户在问需要多少卡和一年成本，正好是 TCO 估算的场景",
    });
  });

  it("模型选 0 表示都不贴合时不加载任何 Skill", async () => {
    const llm = completeLlm('{"skill":0,"reason":"只是打招呼"}');

    await expect(routeSkillWithLlm({
      llm,
      model: "light",
      message: "在吗",
      candidates,
    })).resolves.toBeNull();
  });

  it("候选为空时不调用模型", async () => {
    const completeText = vi.fn(async () => '{"skill":1,"reason":"x"}');
    const llm = { async *stream() {}, completeText } as unknown as LlmClient;

    await expect(routeSkillWithLlm({
      llm,
      model: "light",
      message: "客户问要多少卡",
      candidates: [],
    })).resolves.toBeNull();
    expect(completeText).not.toHaveBeenCalled();
  });

  it("编号越界、返回非 JSON 或模型报错都降级为不加载", async () => {
    const outOfRange = completeLlm('{"skill":9,"reason":"越界"}');
    const notJson = completeLlm("我觉得应该用 TCO 那个 Skill");
    const failing: LlmClient = {
      async *stream() {},
      async completeText() {
        throw new Error("light model unavailable");
      },
    };

    for (const llm of [outOfRange, notJson, failing]) {
      await expect(routeSkillWithLlm({
        llm,
        model: "light",
        message: "客户问要多少卡",
        candidates,
      })).resolves.toBeNull();
    }
  });

  it("候选清单只把名称与触发条件交给模型，不泄露 Skill 全文", async () => {
    let seenPrompt = "";
    const llm: LlmClient = {
      async *stream() {},
      async completeText(input) {
        seenPrompt = input.messages.map((message) => message.content).join("\n");
        return '{"skill":0,"reason":"不贴合"}';
      },
    };

    await routeSkillWithLlm({
      llm,
      model: "light",
      message: "客户问要多少卡",
      candidates,
    });

    expect(seenPrompt).toContain("容量、性能、成本与 TCO 估算");
    expect(seenPrompt).toContain("客户问要多少卡、能撑多少并发、一年多少钱时");
    expect(seenPrompt).toContain("宁可不用");
  });

  it("目录条数与仓储上限一致，截断只在超过该上限时发生", async () => {
    const many = Array.from({ length: SKILL_ROUTING_CATALOG_LIMIT + 5 }, (_ignored, index) => ({
      id: `skill-${index + 1}`,
      name: `技能 ${index + 1}`,
      trigger: `场景 ${index + 1}`,
    }));
    let seenPrompt = "";
    const llm: LlmClient = {
      async *stream() {},
      async completeText(input) {
        seenPrompt = input.messages.map((message) => message.content).join("\n");
        return '{"skill":0,"reason":"不贴合"}';
      },
    };

    await routeSkillWithLlm({ llm, model: "light", message: "随便问问", candidates: many });

    expect(seenPrompt).toContain(`${SKILL_ROUTING_CATALOG_LIMIT}. 技能 ${SKILL_ROUTING_CATALOG_LIMIT}`);
    expect(seenPrompt).not.toContain(`技能 ${SKILL_ROUTING_CATALOG_LIMIT + 1}`);
  });

  it("中止信号原样抛出，不当作降级", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(routeSkillWithLlm({
      llm: completeLlm('{"skill":1,"reason":"x"}'),
      model: "light",
      message: "客户问要多少卡",
      candidates,
      signal: controller.signal,
    })).rejects.toThrow();
  });
});

describe("llm skill matcher", () => {
  function matcherRepositories(overrides?: {
    listEnabledIndex?: () => Promise<SkillCandidate[]>;
  }) {
    return {
      skills: {
        listEnabledIndex: vi.fn(overrides?.listEnabledIndex ?? (async () => candidates)),
        findByIds: vi.fn(async (_scope: unknown, ids: string[]) => ids.map((id) => ({
          id,
          name: "容量、性能、成本与 TCO 估算",
          trigger: "客户问要多少卡时",
          content: "# TCO\n\n## 步骤\n1. 先算卡数",
        }))),
      },
    };
  }

  it("命中后才按 id 加载全文，并带上匹配依据", async () => {
    const repositories = matcherRepositories();
    const matcher = createLlmSkillMatcher({
      llm: completeLlm('{"skill":2,"reason":"正好是 TCO 场景"}'),
      model: "light",
      repositories,
    });

    const loaded = await matcher(scope, "客户问 70B 要多少卡");

    expect(repositories.skills.findByIds).toHaveBeenCalledWith(scope, ["skill-tco"]);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      id: "skill-tco",
      matchReason: "正好是 TCO 场景",
    });
  });

  it("未命中时不加载全文", async () => {
    const repositories = matcherRepositories();
    const matcher = createLlmSkillMatcher({
      llm: completeLlm('{"skill":0,"reason":"闲聊"}'),
      model: "light",
      repositories,
    });

    await expect(matcher(scope, "在吗")).resolves.toEqual([]);
    expect(repositories.skills.findByIds).not.toHaveBeenCalled();
  });

  it("索引查询失败时降级为不加载，不影响本轮回复", async () => {
    const repositories = matcherRepositories({
      listEnabledIndex: async () => {
        throw new Error("db down");
      },
    });
    const matcher = createLlmSkillMatcher({
      llm: completeLlm('{"skill":1,"reason":"x"}'),
      model: "light",
      repositories,
    });

    await expect(matcher(scope, "客户问要多少卡")).resolves.toEqual([]);
  });
});
