import { describe, expect, it } from "vitest";
import { createSearchGate, isExplicitSearchRequest, normalizeSearchAggressiveness } from "@/server/agent/search-gate";

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

  it("gives explicit refusals priority over search keywords", () => {
    expect(isExplicitSearchRequest("不要搜索这个问题")).toBe(false);
    expect(isExplicitSearchRequest("我没让你查询")).toBe(false);
    expect(isExplicitSearchRequest("别帮我查，直接按已有知识回答")).toBe(false);
    expect(isExplicitSearchRequest("请勿搜索")).toBe(false);
    expect(isExplicitSearchRequest("不能搜索")).toBe(false);
    expect(isExplicitSearchRequest("不可以搜索")).toBe(false);
  });

  it("does not confuse discussion of search with an instruction to search", () => {
    expect(isExplicitSearchRequest("解释一下搜索算法")).toBe(false);
    expect(isExplicitSearchRequest("我在做搜索功能")).toBe(false);
    expect(isExplicitSearchRequest("Explain how search for text works")).toBe(false);
    expect(isExplicitSearchRequest("I work at Google Search")).toBe(false);
  });

  it("allows a positive search command in a separate clause after rejecting another action", () => {
    expect(isExplicitSearchRequest("不要只凭记忆，搜索一下最新消息")).toBe(true);
    expect(isExplicitSearchRequest("别猜了，查一下官网")).toBe(true);
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
  it("passes a per-message UI authorization through without consulting the gate model", async () => {
    const gate = createSearchGate({
      aggressiveness: "conservative",
      userMessage: "帮我看看这个问题",
      userEnabled: true,
    });

    await expect(gate.evaluate("这个问题的最新信息")).resolves.toMatchObject({
      allowed: true,
      method: "ui_toggle",
    });
  });

  it("blocks implicit realtime searches when the user did not authorize this turn", async () => {
    const gate = createSearchGate({
      aggressiveness: "conservative",
      userMessage: "明天北京天气怎么样",
      userEnabled: false,
    });

    await expect(gate.evaluate("北京明天天气")).resolves.toMatchObject({
      allowed: false,
      method: "policy_block",
    });
  });

  it("passes explicit user requests through without consulting the gate model", async () => {
    const gate = createSearchGate({
      aggressiveness: "conservative",
      userMessage: "帮我搜一下 WWDC 的最新消息",
    });

    const decision = await gate.evaluate("WWDC 最新消息");

    expect(decision.allowed).toBe(true);
    expect(decision.method).toBe("explicit");
  });

  it("denies everything except explicit requests when the policy is off", async () => {
    const gate = createSearchGate({ aggressiveness: "off", userMessage: "明天天气怎么样" });

    const decision = await gate.evaluate("明天天气");

    expect(decision.allowed).toBe(false);
    expect(decision.method).toBe("policy_block");
  });

  it("does not let the legacy standard tier bypass explicit authorization", async () => {
    const gate = createSearchGate({ aggressiveness: "standard", userMessage: "明天天气怎么样" });

    const decision = await gate.evaluate("明天天气");

    expect(decision.allowed).toBe(false);
    expect(decision.method).toBe("policy_block");
  });

  it("fails closed for ordinary messages without any model call", async () => {
    const gate = createSearchGate({ aggressiveness: "conservative", userMessage: "有什么好看的电影" });

    await expect(gate.evaluate("好看的电影")).resolves.toMatchObject({
      allowed: false,
      method: "policy_block",
    });
  });
});
