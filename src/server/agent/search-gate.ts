export type SearchAggressiveness = "conservative" | "standard" | "off";

export type SearchGateDecision = {
  allowed: boolean;
  method: "ui_toggle" | "explicit" | "policy_block";
  reason: string;
};

export type SearchGate = {
  evaluate(query: string): Promise<SearchGateDecision>;
};

const explicitSearchPattern =
  /搜一下|搜一搜|搜搜|帮我搜(?:一下)?|帮我搜索(?:一下)?|请(?:帮我)?搜索(?:一下)?|查一下|查一查|查查|帮我查(?:一下)?|帮我查询(?:一下)?|查询一下|上网查|联网查|网上查|查证|求证|(?:去|上|看)官网|官网(?:搜索|搜|查|看|确认|核实|核对)|^\s*(?:搜索|查询)一下|^\s*(?:搜索|查询)(?:[：:\s]|$)|^\s*(?:(?:please|kindly)\s+|(?:can|could|would|will)\s+you\s+)?(?:search|google)\s+/i;
// "你不能去百炼搜吗" is a request, not a prohibition: in Chinese a negated
// ability closed with 吗/么 asks you to go do it. Only ability negations count —
// "你不是说不用搜吗" restates an earlier decision not to search — and dropping
// the 吗/么 keeps "你不能去百炼搜" a refusal.
const rhetoricalSearchRequestPattern =
  /(?:不能|不可以|不会|没法)[^，。！？；,.!?;]{0,12}(?:搜索|搜|查询|查|核实|核对|查证)[^，。！？；,.!?;]{0,8}[吗么]/;
// "核实/确认" alone is ambiguous — it often means "confirm my understanding" —
// so it only authorizes a search when the same clause also names an external
// source to check against. Keeps the red line ("only an explicit request in the
// message text authorizes going online") while covering how people actually ask
// for verification.
const verificationVerbPattern = /核实|核对|核查|确认|查实/;
const externalSourcePattern =
  /官网|官方|文档|网上|上网|联网|互联网|公开(?:资料|信息)|最新/;
// The refused action may name its source first ("不用去官网核实"), so an optional
// source phrase sits between the negation and the verb. Deliberately not a
// wildcard window: "不要只凭记忆，搜索一下最新消息" must stay a real request.
const refusedActionPattern =
  /\s*(?:再)?\s*(?:帮我)?\s*(?:(?:去|上|看)?(?:官网|官方|网上|互联网|联网)\s*)?(?:搜|搜索|查|查询|联网|核实|核对|核查|查证|求证)/;
const explicitSearchRefusalPattern = new RegExp(
  `(?:不要|别|请勿|不能|不可以|不用|无需|不准|禁止|停止)${refusedActionPattern.source}`
  + `|(?:没|没有)\\s*让你${refusedActionPattern.source}`,
  "i",
);

export function isExplicitSearchRequest(message: string): boolean {
  return message
    .split(/[，。！？；,.!?;]+/)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .some((clause) => {
      if (rhetoricalSearchRequestPattern.test(clause)) return true;
      if (explicitSearchRefusalPattern.test(clause)) return false;
      if (explicitSearchPattern.test(clause)) return true;
      return verificationVerbPattern.test(clause) && externalSourcePattern.test(clause);
    });
}

export function normalizeSearchAggressiveness(value: unknown): SearchAggressiveness {
  return value === "standard" || value === "off" ? value : "conservative";
}

export function createSearchGate(input: {
  aggressiveness: SearchAggressiveness;
  userMessage: string;
  userEnabled?: boolean;
}): SearchGate {
  return {
    async evaluate(query: string): Promise<SearchGateDecision> {
      if (input.userEnabled) {
        return { allowed: true, method: "ui_toggle", reason: "用户在输入框中显式开启了本轮联网搜索" };
      }
      if (isExplicitSearchRequest(input.userMessage)) {
        return { allowed: true, method: "explicit", reason: "用户显式要求搜索，直通放行" };
      }
      void query;
      void input.aggressiveness;
      return {
        allowed: false,
        method: "policy_block",
        reason: "用户未开启本轮联网搜索，也未在消息中明确要求搜索",
      };
    },
  };
}
