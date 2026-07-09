import { describe, expect, it, vi } from "vitest";
import { createSearchGate, isExplicitSearchRequest, normalizeSearchAggressiveness } from "@/server/agent/search-gate";
import type { LlmClient } from "@/server/llm/types";

function gateLlm(reply: string | (() => Promise<string>)): LlmClient {
  return {
    async *stream() {},
    completeText: typeof reply === "string" ? vi.fn(async () => reply) : vi.fn(reply),
  };
}

describe("isExplicitSearchRequest", () => {
  it("detects explicit search phrasing", () => {
    expect(isExplicitSearchRequest("帮我搜一下明天的天气")).toBe(true);
    expect(isExplicitSearchRequest("查一下最近的新闻")).toBe(true);
    expect(isExplicitSearchRequest("上网查下这个股票")).toBe(true);
  });

  it("does not treat casual chat as an explicit request", () => {
    expect(isExplicitSearchRequest("你觉得人生的意义是什么")).toBe(false);
    expect(isExplicitSearchRequest("今天有点累")).toBe(false);
  });
});

describe("normalizeSearchAggressiveness", () => {
  it("falls back to conservative for unknown values", () => {
    expect(normalizeSearchAggressiveness("standard")).toBe("standard");
    expect(normalizeSearchAggressiveness("off")).toBe("off");
    expect(normalizeSearchAggressiveness("whatever")).toBe("conservative");
    expect(normalizeSearchAggressiveness(undefined)).toBe("conservative");
  });
});

describe("createSearchGate", () => {
  it("passes explicit user requests through without consulting the gate model", async () => {
    const llm = gateLlm('{"allow": false, "reason": "不应该被调用"}');
    const gate = createSearchGate({
      aggressiveness: "conservative",
      userMessage: "帮我搜一下 WWDC 的最新消息",
      llm,
      model: "mock-light",
    });

    const decision = await gate.evaluate("WWDC 最新消息");

    expect(decision.allowed).toBe(true);
    expect(decision.method).toBe("explicit");
    expect(llm.completeText).not.toHaveBeenCalled();
  });

  it("denies everything except explicit requests when the policy is off", async () => {
    const gate = createSearchGate({ aggressiveness: "off", userMessage: "明天天气怎么样" });

    const decision = await gate.evaluate("明天天气");

    expect(decision.allowed).toBe(false);
    expect(decision.method).toBe("policy_off");
  });

  it("allows without a hard gate on the standard tier", async () => {
    const gate = createSearchGate({ aggressiveness: "standard", userMessage: "明天天气怎么样" });

    const decision = await gate.evaluate("明天天气");

    expect(decision.allowed).toBe(true);
    expect(decision.method).toBe("prompt_only");
  });

  it("follows the light-model verdict on the conservative tier", async () => {
    const allowGate = createSearchGate({
      aggressiveness: "conservative",
      userMessage: "明天北京会下雨吗",
      llm: gateLlm('{"allow": true, "reason": "天气依赖实时数据"}'),
      model: "mock-light",
    });
    const denyGate = createSearchGate({
      aggressiveness: "conservative",
      userMessage: "你怎么看远程办公",
      llm: gateLlm('{"allow": false, "reason": "观点讨论不需要实时信息"}'),
      model: "mock-light",
    });

    await expect(allowGate.evaluate("北京明天天气")).resolves.toMatchObject({ allowed: true, method: "llm_gate" });
    await expect(denyGate.evaluate("远程办公 趋势")).resolves.toMatchObject({ allowed: false, method: "llm_gate" });
  });

  it("fails closed when the gate model errors or returns garbage", async () => {
    const errorGate = createSearchGate({
      aggressiveness: "conservative",
      userMessage: "有什么好看的电影",
      llm: gateLlm(async () => {
        throw new Error("model down");
      }),
      model: "mock-light",
    });
    const garbageGate = createSearchGate({
      aggressiveness: "conservative",
      userMessage: "有什么好看的电影",
      llm: gateLlm("我觉得可以搜"),
      model: "mock-light",
    });
    const missingLlmGate = createSearchGate({ aggressiveness: "conservative", userMessage: "有什么好看的电影" });

    await expect(errorGate.evaluate("好看的电影")).resolves.toMatchObject({ allowed: false });
    await expect(garbageGate.evaluate("好看的电影")).resolves.toMatchObject({ allowed: false });
    await expect(missingLlmGate.evaluate("好看的电影")).resolves.toMatchObject({ allowed: false });
  });
});
