import { describe, expect, it } from "vitest";
import { createSearchGate, isExplicitSearchRequest, normalizeSearchAggressiveness } from "@/server/agent/search-gate";

describe("isExplicitSearchRequest", () => {
  it("detects explicit search phrasing", () => {
    expect(isExplicitSearchRequest("帮我搜一下明天的天气")).toBe(true);
    expect(isExplicitSearchRequest("查一下最近的新闻")).toBe(true);
    expect(isExplicitSearchRequest("上网查下这个股票")).toBe(true);
  });

  it("detects verification phrasing that names an external source", () => {
    expect(isExplicitSearchRequest("去官网核实一下这个 SLA")).toBe(true);
    expect(isExplicitSearchRequest("查证一下这个资质要求")).toBe(true);
    expect(isExplicitSearchRequest("按官方文档确认下这个模型的定价")).toBe(true);
    expect(isExplicitSearchRequest("联网核对一下最新的模型列表")).toBe(true);
  });

  it("does not treat casual chat as an explicit request", () => {
    expect(isExplicitSearchRequest("你觉得人生的意义是什么")).toBe(false);
    expect(isExplicitSearchRequest("今天有点累")).toBe(false);
    expect(isExplicitSearchRequest("在吗")).toBe(false);
  });

  it("keeps verification verbs closed when no external source is named", () => {
    expect(isExplicitSearchRequest("你再确认一下我的理解对不对")).toBe(false);
    expect(isExplicitSearchRequest("帮我核实一下这个报价单的算法")).toBe(false);
    expect(isExplicitSearchRequest("确认下我们下一步做什么")).toBe(false);
  });

  it("keeps implicit realtime questions closed", () => {
    expect(isExplicitSearchRequest("百炼现在支持哪些模型")).toBe(false);
    expect(isExplicitSearchRequest("这个价格对吗")).toBe(false);
    expect(isExplicitSearchRequest("最新的模型是哪个")).toBe(false);
  });

  it("gives explicit refusals priority over search keywords", () => {
    expect(isExplicitSearchRequest("不要搜索这个问题")).toBe(false);
    expect(isExplicitSearchRequest("我没让你查询")).toBe(false);
    expect(isExplicitSearchRequest("别帮我查，直接按已有知识回答")).toBe(false);
    expect(isExplicitSearchRequest("请勿搜索")).toBe(false);
    expect(isExplicitSearchRequest("不能搜索")).toBe(false);
    expect(isExplicitSearchRequest("不可以搜索")).toBe(false);
    expect(isExplicitSearchRequest("不用去官网核实，按你已有的说")).toBe(false);
  });

  it("detects a named site as the place to search, not only to verify", () => {
    expect(isExplicitSearchRequest("你去这个官网搜去https://help.aliyun.com/zh/model-studio/what-is-model-studio")).toBe(true);
    expect(isExplicitSearchRequest("官网搜一下这个型号")).toBe(true);
    expect(isExplicitSearchRequest("你能去官网搜吗")).toBe(true);
  });

  it("reads a negated ability question as a request to search", () => {
    expect(isExplicitSearchRequest("你不能去百炼搜吗，skill不是给你了嘛")).toBe(true);
    expect(isExplicitSearchRequest("你不可以查一下官网么")).toBe(true);
  });

  it("still refuses the same negation when it is not a question", () => {
    expect(isExplicitSearchRequest("你不能去百炼搜")).toBe(false);
    expect(isExplicitSearchRequest("不能去官网搜")).toBe(false);
    expect(isExplicitSearchRequest("你不是说不用搜吗")).toBe(false);
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
