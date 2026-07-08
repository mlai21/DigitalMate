import { describe, expect, it } from "vitest";
import { canSendProactiveMessage, parseFollowUp, parseReminder } from "@/server/agent/reminders";

describe("parseReminder", () => {
  it("parses relative minute reminders", () => {
    const result = parseReminder("10 分钟后提醒我喝水", new Date("2026-07-05T10:00:00+08:00"));

    expect(result?.scheduledAt.toISOString()).toBe("2026-07-05T02:10:00.000Z");
    expect(result?.content).toBe("喝水");
    expect(result?.urgent).toBe(false);
  });

  it("marks explicit urgent reminders", () => {
    const result = parseReminder("10 分钟后紧急提醒我吃药", new Date("2026-07-05T10:00:00+08:00"));

    expect(result?.scheduledAt.toISOString()).toBe("2026-07-05T02:10:00.000Z");
    expect(result?.content).toBe("吃药");
    expect(result?.urgent).toBe(true);
  });

  it("parses tomorrow reminders with a specific time", () => {
    const result = parseReminder("明天 9:30 提醒我提交报销", new Date("2026-07-05T10:00:00+08:00"));

    expect(result?.scheduledAt.toISOString()).toBe("2026-07-06T01:30:00.000Z");
    expect(result?.content).toBe("提交报销");
  });

  it("parses weekday reminders before the reminder verb", () => {
    const result = parseReminder("周五提醒我提交报销", new Date("2026-07-05T10:00:00+08:00"));

    expect(result?.scheduledAt.toISOString()).toBe("2026-07-10T01:00:00.000Z");
    expect(result?.content).toBe("提交报销");
  });

  it("parses weekday deadlines after the reminder verb", () => {
    const result = parseReminder("提醒我周五之前把报销交了", new Date("2026-07-06T10:00:00+08:00"));

    expect(result?.scheduledAt.toISOString()).toBe("2026-07-10T01:00:00.000Z");
    expect(result?.content).toBe("把报销交了");
  });
});

describe("parseFollowUp", () => {
  it("schedules a next-day follow-up for ongoing user tasks", () => {
    const result = parseFollowUp("我在准备一个演讲", new Date("2026-07-05T10:00:00+08:00"));

    expect(result?.scheduledAt.toISOString()).toBe("2026-07-06T01:00:00.000Z");
    expect(result?.content).toBe("演讲准备得怎么样了？");
  });

  it("does not create a follow-up for explicit reminders", () => {
    expect(parseFollowUp("明天 9 点提醒我提交报销", new Date("2026-07-05T10:00:00+08:00"))).toBeNull();
  });
});

describe("canSendProactiveMessage", () => {
  it("blocks quiet hours for non-urgent reminders", () => {
    expect(
      canSendProactiveMessage(new Date("2026-07-05T23:30:00+08:00"), {
        quietStart: "23:00",
        quietEnd: "08:00",
        sentToday: 0,
        maxPerDay: 3,
      }),
    ).toBe(false);
  });

  it("allows urgent reminders during quiet hours", () => {
    expect(
      canSendProactiveMessage(new Date("2026-07-05T23:30:00+08:00"), {
        quietStart: "23:00",
        quietEnd: "08:00",
        sentToday: 0,
        maxPerDay: 3,
        allowQuietHours: true,
      }),
    ).toBe(true);
  });
});
