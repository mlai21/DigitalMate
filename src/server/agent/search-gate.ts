import type { LlmClient } from "@/server/llm/types";

export type SearchAggressiveness = "conservative" | "standard" | "off";

export type SearchGateDecision = {
  allowed: boolean;
  method: "explicit" | "llm_gate" | "policy_off" | "prompt_only";
  reason: string;
};

export type SearchGate = {
  evaluate(query: string): Promise<SearchGateDecision>;
};

const explicitSearchPattern =
  /搜一下|搜搜|搜索|帮我搜|查一下|查查|帮我查|查询|上网查|联网查|网上查|search\s+(for|the|it|online)|google\s/i;

const gatePrompt = [
  "你是一个搜索调用审查器，判断 AI 助手回答这条用户消息是否真的需要联网搜索。",
  "只有以下情况才允许搜索：",
  "1. 用户明确要求搜索、查询或获取实时信息；",
  "2. 回答必须依赖当下才有的数据（天气、新闻、股价、赛事、营业信息、价格等）；",
  "3. 问题涉及明显超出模型知识截止时间的具体事实。",
  "闲聊、常识问答、观点讨论、写作、翻译、总结、代码、安装或保存类操作请求一律不允许。拿不准时选择不允许。",
  '只输出 JSON，格式：{"allow": true 或 false, "reason": "一句话原因"}',
].join("\n");

export function isExplicitSearchRequest(message: string): boolean {
  return explicitSearchPattern.test(message);
}

export function normalizeSearchAggressiveness(value: unknown): SearchAggressiveness {
  return value === "standard" || value === "off" ? value : "conservative";
}

export function createSearchGate(input: {
  aggressiveness: SearchAggressiveness;
  userMessage: string;
  llm?: LlmClient;
  model?: string;
}): SearchGate {
  return {
    async evaluate(query: string): Promise<SearchGateDecision> {
      if (isExplicitSearchRequest(input.userMessage)) {
        return { allowed: true, method: "explicit", reason: "用户显式要求搜索，直通放行" };
      }
      if (input.aggressiveness === "off") {
        return { allowed: false, method: "policy_off", reason: "搜索档位为关闭，仅用户显式要求时才搜索" };
      }
      if (input.aggressiveness === "standard") {
        return { allowed: true, method: "prompt_only", reason: "标准档位：仅依赖提示词白名单约束" };
      }
      if (!input.llm || !input.model) {
        return { allowed: false, method: "llm_gate", reason: "门控模型不可用，按保守策略不搜索" };
      }
      try {
        const raw = await input.llm.completeText({
          model: input.model,
          messages: [
            { role: "system", content: gatePrompt },
            { role: "user", content: `用户消息：${input.userMessage}\n拟搜索查询：${query}` },
          ],
        });
        const verdict = parseGateVerdict(raw);
        if (!verdict) {
          return { allowed: false, method: "llm_gate", reason: "门控输出无法解析，按保守策略不搜索" };
        }
        return { allowed: verdict.allow, method: "llm_gate", reason: verdict.reason };
      } catch {
        return { allowed: false, method: "llm_gate", reason: "门控判定失败，按保守策略不搜索" };
      }
    },
  };
}

function parseGateVerdict(raw: string): { allow: boolean; reason: string } | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { allow?: unknown; reason?: unknown };
    if (typeof parsed.allow !== "boolean") return null;
    return { allow: parsed.allow, reason: typeof parsed.reason === "string" ? parsed.reason : "门控未给出原因" };
  } catch {
    return null;
  }
}
