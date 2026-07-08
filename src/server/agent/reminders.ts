export type ParsedReminder = {
  content: string;
  scheduledAt: Date;
  urgent: boolean;
};

export type ParsedFollowUp = {
  content: string;
  scheduledAt: Date;
};

export type ProactivePolicy = {
  quietStart: string;
  quietEnd: string;
  sentToday: number;
  maxPerDay: number;
  allowQuietHours?: boolean;
};

const weekdayMap = new Map([
  ["一", 1],
  ["二", 2],
  ["三", 3],
  ["四", 4],
  ["五", 5],
  ["六", 6],
  ["日", 0],
  ["天", 0],
]);

export function parseReminder(text: string, now = new Date()): ParsedReminder | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  const urgent = isUrgentReminder(normalized);

  const relative = normalized.match(/(\d+)\s*(秒|分钟|小时|天)后(?:紧急|急|务必|重要)?提醒我(.+)/);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const content = cleanReminderContent(relative[3]);
    const multipliers: Record<string, number> = {
      秒: 1_000,
      分钟: 60_000,
      小时: 3_600_000,
      天: 86_400_000,
    };
    return { content, scheduledAt: new Date(now.getTime() + amount * multipliers[unit]), urgent };
  }

  const tomorrow = normalized.match(/明天\s*(\d{1,2})(?::|点)(\d{1,2})?\s*(?:紧急|急|务必|重要)?提醒我(.+)/);
  if (tomorrow) {
    const scheduledAt = atLocalTime(addDays(now, 1), Number(tomorrow[1]), Number(tomorrow[2] ?? 0));
    return { content: cleanReminderContent(tomorrow[3]), scheduledAt, urgent };
  }

  const today = normalized.match(/今天\s*(\d{1,2})(?::|点)(\d{1,2})?\s*(?:紧急|急|务必|重要)?提醒我(.+)/);
  if (today) {
    const scheduledAt = atLocalTime(now, Number(today[1]), Number(today[2] ?? 0));
    return { content: cleanReminderContent(today[3]), scheduledAt, urgent };
  }

  const weekdayAfterReminder = normalized.match(/(?:紧急|急|务必|重要)?提醒我(?:在)?(?:周|星期|礼拜)([一二三四五六日天])(?:之前|前)?(.+)/);
  if (weekdayAfterReminder) {
    const target = weekdayMap.get(weekdayAfterReminder[1]);
    if (target === undefined) return null;
    const scheduledAt = atLocalTime(nextWeekday(now, target), 9, 0);
    return { content: cleanReminderContent(weekdayAfterReminder[2]), scheduledAt, urgent };
  }

  const weekday = normalized.match(/(?:周|星期|礼拜)([一二三四五六日天]).*?(?:紧急|急|务必|重要)?提醒我(.+)/);
  if (weekday) {
    const target = weekdayMap.get(weekday[1]);
    if (target === undefined) return null;
    const scheduledAt = atLocalTime(nextWeekday(now, target), 9, 0);
    return { content: cleanReminderContent(weekday[2]), scheduledAt, urgent };
  }

  return null;
}

export function parseFollowUp(text: string, now = new Date()): ParsedFollowUp | null {
  if (parseReminder(text, now)) return null;

  const normalized = text.replace(/\s+/g, " ").trim();
  const preparing = normalized.match(/我在准备(?:一个|一场|一份)?(.+)/);
  if (preparing) {
    const topic = cleanFollowUpTopic(preparing[1]);
    if (!topic) return null;
    return { content: `${topic}准备得怎么样了？`, scheduledAt: atLocalTime(addDays(now, 1), 9, 0) };
  }

  const todo = normalized.match(/我(?:要|需要|打算)(.+)/);
  if (todo) {
    const topic = cleanFollowUpTopic(todo[1]);
    if (!topic) return null;
    return { content: `${topic}进展怎么样了？`, scheduledAt: atLocalTime(addDays(now, 1), 9, 0) };
  }

  return null;
}

export function canSendProactiveMessage(now: Date, policy: ProactivePolicy): boolean {
  if (policy.sentToday >= policy.maxPerDay) return false;
  if (policy.allowQuietHours) return true;

  const minutes = now.getHours() * 60 + now.getMinutes();
  const start = parseClock(policy.quietStart);
  const end = parseClock(policy.quietEnd);

  if (start < end) {
    return !(minutes >= start && minutes < end);
  }

  return !(minutes >= start || minutes < end);
}

function isUrgentReminder(text: string): boolean {
  return /紧急|急|务必|重要/.test(text);
}

function cleanReminderContent(content: string): string {
  return content.replace(/[。.!！?？\s]+$/g, "").trim();
}

function cleanFollowUpTopic(content: string): string {
  return content.replace(/[。.!！?？\s]+$/g, "").replace(/^(一下|一下子)/, "").trim();
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function atLocalTime(date: Date, hour: number, minute: number): Date {
  const scheduledAt = new Date(date);
  scheduledAt.setHours(hour, minute, 0, 0);
  return scheduledAt;
}

function nextWeekday(date: Date, targetWeekday: number): Date {
  const next = new Date(date);
  const current = next.getDay();
  const days = (targetWeekday - current + 7) % 7 || 7;
  next.setDate(next.getDate() + days);
  return next;
}

function parseClock(value: string): number {
  const [hour = "0", minute = "0"] = value.split(":");
  return Number(hour) * 60 + Number(minute);
}
