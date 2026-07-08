import type { LlmMessage, LlmPurpose } from "@/server/llm/types";

export type LlmUsageLogInput = {
  userId: string;
  conversationId?: string | null;
  purpose: LlmPurpose;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type UsageLogForSummary = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export function estimateTokenCount(text: string): number {
  if (!text.trim()) return 0;

  const cjkChars = text.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const asciiChars = text.replace(/[\u3400-\u9fff\s]/g, "").length;
  const words = text
    .replace(/[\u3400-\u9fff]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;

  return cjkChars + Math.max(Math.ceil(asciiChars / 4), words);
}

export function estimateMessagesTokenUsage(messages: LlmMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokenCount(message.content) + 4, 0);
}

export function summarizeUsageLogs(logs: UsageLogForSummary[]) {
  const summary = {
    requestCount: logs.length,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    byModel: [] as Array<{ model: string; requestCount: number; totalTokens: number }>,
  };
  const byModel = new Map<string, { model: string; requestCount: number; totalTokens: number }>();

  for (const log of logs) {
    summary.inputTokens += log.inputTokens;
    summary.outputTokens += log.outputTokens;
    summary.totalTokens += log.totalTokens;

    const model = byModel.get(log.model) ?? { model: log.model, requestCount: 0, totalTokens: 0 };
    model.requestCount += 1;
    model.totalTokens += log.totalTokens;
    byModel.set(log.model, model);
  }

  summary.byModel = [...byModel.values()];
  return summary;
}
