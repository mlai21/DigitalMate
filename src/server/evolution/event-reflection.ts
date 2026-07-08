import type { ReflectionRecord } from "@/server/evolution/reflection";

export type EventReflectionKind = "daily" | "task_failure" | "user_dissatisfaction" | "proactive_ignored";

type ReflectionWriter = {
  reflections: {
    create(input: { userId: string; reflection: ReflectionRecord; sourceWindow?: unknown }): Promise<unknown> | unknown;
    latestBySourceEvent?(userId: string, event: EventReflectionKind): Promise<Date | null>;
  };
};

type EventReflectionInput = {
  userId: string;
  event: EventReflectionKind;
  summary: string;
  source?: Record<string, unknown>;
  dedupeByEvent?: boolean;
  now?: Date;
};

const eventLabels: Record<EventReflectionKind, string> = {
  daily: "每日反思",
  task_failure: "任务失败",
  user_dissatisfaction: "用户不满",
  proactive_ignored: "主动消息被忽略",
};

export function shouldReflectOnUserDissatisfaction(text: string): boolean {
  const normalized = text.replace(/\s+/g, "").toLowerCase();
  return [
    /你.*(错了|不对|理解错|没懂|答错|搞错|没用|不靠谱)/,
    /(回复|回答|方案|结果|这个|方向).*(不对|错了|没用|不靠谱)/,
    /(不是这个意思|答非所问|不满意|算了吧|别再这样|先别再这样)/,
  ].some((pattern) => pattern.test(normalized));
}

export function shouldRecordEventReflection(now: Date, latestEventReflectionAt: Date | null): boolean {
  if (!latestEventReflectionAt) return true;
  return now.getTime() - latestEventReflectionAt.getTime() >= 24 * 60 * 60 * 1000;
}

export function buildEventReflection(input: { event: EventReflectionKind; summary: string }): ReflectionRecord {
  const label = eventLabels[input.event];
  const summary = trimSummary(input.summary);
  const suggestions = {
    daily: `下次对话前参考这条反思，保留有效做法并继续观察用户反馈。`,
    task_failure: `下次遇到类似任务，先确认输入与依赖条件，再给出可执行的修正路径。`,
    user_dissatisfaction: `下次遇到类似反馈，先承认偏差并复述用户意图，再给出更短的修正版。`,
    proactive_ignored: `下次主动联系前降低频率，等待用户重新回应或出现更明确的触发信号。`,
  } satisfies Record<EventReflectionKind, string>;

  return {
    positives: ["及时记录了异常信号"],
    negatives: [`${label}：${summary}`],
    suggestions: [suggestions[input.event]],
  };
}

export async function recordEventReflection(repositories: ReflectionWriter, input: EventReflectionInput): Promise<boolean> {
  if (input.event === "user_dissatisfaction" && !shouldReflectOnUserDissatisfaction(input.summary)) {
    return false;
  }

  const shouldDedupe = input.dedupeByEvent ?? input.event === "proactive_ignored";
  if (shouldDedupe && repositories.reflections.latestBySourceEvent) {
    const latest = await repositories.reflections.latestBySourceEvent(input.userId, input.event);
    if (!shouldRecordEventReflection(input.now ?? new Date(), latest)) return false;
  }

  await repositories.reflections.create({
    userId: input.userId,
    reflection: buildEventReflection({ event: input.event, summary: input.summary }),
    sourceWindow: {
      event: input.event,
      ...(input.source ?? {}),
    },
  });
  return true;
}

function trimSummary(summary: string): string {
  const normalized = summary.replace(/\s+/g, " ").trim();
  if (normalized.length <= 180) return normalized;
  return `${normalized.slice(0, 177)}...`;
}
