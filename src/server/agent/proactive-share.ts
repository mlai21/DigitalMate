import { canSendProactiveMessage } from "@/server/agent/reminders";

export type ProactiveSharePolicyInput = {
  now: Date;
  latestShareAt: Date | null;
  quietStart: string;
  quietEnd: string;
  sentToday: number;
  maxPerDay: number;
  unansweredCount?: number;
};

export function shouldCreateProactiveShare(input: ProactiveSharePolicyInput): boolean {
  if ((input.unansweredCount ?? 0) >= 2) return false;

  if (
    !canSendProactiveMessage(input.now, {
      quietStart: input.quietStart,
      quietEnd: input.quietEnd,
      sentToday: input.sentToday,
      maxPerDay: input.maxPerDay,
    })
  ) {
    return false;
  }

  if (!input.latestShareAt) return true;
  return input.now.getTime() - input.latestShareAt.getTime() >= 24 * 60 * 60 * 1000;
}

export function buildProactiveShareContent(input: { memory: string; searchSummary: string }): string {
  return `你之前提到过「${input.memory}」。我刚看到一点可能相关的信息：${input.searchSummary}`;
}
