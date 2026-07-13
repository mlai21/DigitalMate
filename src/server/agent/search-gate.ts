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
  /搜一下|搜一搜|搜搜|帮我搜(?:一下)?|帮我搜索(?:一下)?|请(?:帮我)?搜索(?:一下)?|查一下|查一查|查查|帮我查(?:一下)?|帮我查询(?:一下)?|查询一下|上网查|联网查|网上查|^\s*(?:搜索|查询)一下|^\s*(?:搜索|查询)(?:[：:\s]|$)|^\s*(?:(?:please|kindly)\s+|(?:can|could|would|will)\s+you\s+)?(?:search|google)\s+/i;
const explicitSearchRefusalPattern =
  /(?:不要|别|请勿|不能|不可以|不用|无需|不准|禁止|停止)\s*(?:再)?\s*(?:帮我)?\s*(?:搜|搜索|查|查询|联网)|(?:没|没有)\s*让你\s*(?:搜|搜索|查|查询|联网)/i;

export function isExplicitSearchRequest(message: string): boolean {
  return message
    .split(/[，。！？；,.!?;]+/)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .some((clause) => !explicitSearchRefusalPattern.test(clause) && explicitSearchPattern.test(clause));
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
