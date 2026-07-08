import { describe, expect, it } from "vitest";
import { shouldInterject } from "@/server/channels/interjection";

describe("shouldInterject", () => {
  it("allows relevant group interjection within configured limits", () => {
    const decision = shouldInterject({
      message: {
        channel: "telegram",
        chatType: "group",
        text: "周末去哪爬山？",
        senderId: "user-1",
        externalConversationId: "group-1",
        externalMessageId: "m1",
        occurredAt: new Date("2026-07-05T10:00:00+08:00"),
      },
      memories: ["用户喜欢周末爬山"],
      now: new Date("2026-07-05T10:00:00+08:00"),
      policy: {
        minIntervalMinutes: 30,
        maxPerHour: 2,
        maxPerDay: 5,
        quietStart: "23:00",
        quietEnd: "08:00",
      },
      recentBotMessageAt: new Date("2026-07-05T09:00:00+08:00"),
      sentInLastHour: 0,
      sentToday: 1,
    });

    expect(decision).toEqual({ shouldInterject: true, reason: "relevant_memory" });
  });

  it("blocks quiet hours and recent bot messages", () => {
    const base = {
      message: {
        channel: "telegram" as const,
        chatType: "group" as const,
        text: "周末去哪爬山？",
        senderId: "user-1",
        externalConversationId: "group-1",
        externalMessageId: "m1",
        occurredAt: new Date("2026-07-05T23:30:00+08:00"),
      },
      memories: ["用户喜欢周末爬山"],
      policy: {
        minIntervalMinutes: 30,
        maxPerHour: 2,
        maxPerDay: 5,
        quietStart: "23:00",
        quietEnd: "08:00",
      },
      recentBotMessageAt: null,
      sentInLastHour: 0,
      sentToday: 0,
    };

    expect(shouldInterject({ ...base, now: new Date("2026-07-05T23:30:00+08:00") }).reason).toBe("quiet_hours");
    expect(
      shouldInterject({
        ...base,
        now: new Date("2026-07-05T10:00:00+08:00"),
        recentBotMessageAt: new Date("2026-07-05T09:45:00+08:00"),
      }).reason,
    ).toBe("too_soon");
  });

  it("blocks interjection when the group conversation is busy", () => {
    expect(
      shouldInterject({
        message: {
          channel: "telegram",
          chatType: "group",
          text: "周末去哪爬山？",
          senderId: "user-1",
          externalConversationId: "group-1",
          externalMessageId: "m1",
          occurredAt: new Date("2026-07-05T10:00:00+08:00"),
        },
        memories: ["用户喜欢周末爬山"],
        now: new Date("2026-07-05T10:00:00+08:00"),
        policy: {
          minIntervalMinutes: 30,
          maxPerHour: 2,
          maxPerDay: 5,
          quietStart: "23:00",
          quietEnd: "08:00",
        },
        recentBotMessageAt: null,
        sentInLastHour: 0,
        sentToday: 0,
        recentMessageCount: 8,
      }),
    ).toEqual({ shouldInterject: false, reason: "conversation_busy" });
  });
});
