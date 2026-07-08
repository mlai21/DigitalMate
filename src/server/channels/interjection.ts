import type { NormalizedChannelMessage } from "@/server/channels/types";

export type InterjectionPolicy = {
  minIntervalMinutes: number;
  maxPerHour: number;
  maxPerDay: number;
  quietStart: string;
  quietEnd: string;
};

export type InterjectionDecisionReason =
  | "relevant_memory"
  | "not_group"
  | "quiet_hours"
  | "too_soon"
  | "hourly_limit"
  | "daily_limit"
  | "conversation_busy"
  | "not_relevant";

export type InterjectionDecision = {
  shouldInterject: boolean;
  reason: InterjectionDecisionReason;
};

export function shouldInterject(input: {
  message: NormalizedChannelMessage;
  memories: string[];
  now: Date;
  policy: InterjectionPolicy;
  recentBotMessageAt: Date | null;
  sentInLastHour: number;
  sentToday: number;
  recentMessageCount?: number;
}): InterjectionDecision {
  if (input.message.chatType !== "group") return { shouldInterject: false, reason: "not_group" };
  if (isQuietHour(input.now, input.policy)) return { shouldInterject: false, reason: "quiet_hours" };
  if (input.recentBotMessageAt) {
    const minutes = (input.now.getTime() - input.recentBotMessageAt.getTime()) / 60_000;
    if (minutes < input.policy.minIntervalMinutes) return { shouldInterject: false, reason: "too_soon" };
  }
  if (input.sentInLastHour >= input.policy.maxPerHour) return { shouldInterject: false, reason: "hourly_limit" };
  if (input.sentToday >= input.policy.maxPerDay) return { shouldInterject: false, reason: "daily_limit" };
  if ((input.recentMessageCount ?? 0) >= 6) return { shouldInterject: false, reason: "conversation_busy" };
  if (!isRelevant(input.message.text, input.memories)) return { shouldInterject: false, reason: "not_relevant" };
  return { shouldInterject: true, reason: "relevant_memory" };
}

function isRelevant(text: string, memories: string[]): boolean {
  const queryTokens = tokenize(text);
  return memories.some((memory) => [...tokenize(memory)].some((token) => queryTokens.has(token)));
}

function tokenize(text: string): Set<string> {
  const compact = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const tokens = new Set<string>();
  for (let size = 2; size <= 4; size += 1) {
    for (let index = 0; index <= compact.length - size; index += 1) {
      tokens.add(compact.slice(index, index + size));
    }
  }
  return tokens;
}

function isQuietHour(now: Date, policy: InterjectionPolicy): boolean {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const start = parseClock(policy.quietStart);
  const end = parseClock(policy.quietEnd);
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

function parseClock(value: string): number {
  const [hour = "0", minute = "0"] = value.split(":");
  return Number(hour) * 60 + Number(minute);
}
