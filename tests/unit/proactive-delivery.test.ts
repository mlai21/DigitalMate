import { describe, expect, it, vi } from "vitest";
import { processDueProactiveTasks } from "@/server/agent/proactive-delivery";
import type { NormalizedChannelMessage } from "@/server/channels/types";
import type { DbProactiveTask } from "@/server/db/repositories";

const telegramTarget: NormalizedChannelMessage = {
  channel: "telegram",
  externalConversationId: "chat-1",
  externalMessageId: "proactive",
  senderId: "user-1",
  chatType: "direct",
  text: "",
  occurredAt: new Date("2026-07-05T09:00:00+08:00"),
  raw: {},
};

describe("processDueProactiveTasks", () => {
  it("persists due reminders to web chat and pushes to the latest direct IM channel", async () => {
    const sendChannel = vi.fn();
    const messagesCreate = vi.fn();
    const markSent = vi.fn();

    await processDueProactiveTasks({
      now: new Date("2026-07-05T10:00:00+08:00"),
      sendChannel,
      repositories: fakeRepositories({ messagesCreate, markSent, latestDirectTarget: telegramTarget }),
    });

    expect(messagesCreate).toHaveBeenCalledWith({
      userId: "user-1",
      conversationId: "conversation-1",
      role: "assistant",
      content: "提醒一下：提交报销",
    });
    expect(sendChannel).toHaveBeenCalledWith(telegramTarget, "提醒一下：提交报销");
    expect(markSent).toHaveBeenCalledWith("task-1");
  });

  it("keeps quiet-hour proactive tasks pending", async () => {
    const messagesCreate = vi.fn();
    const markSent = vi.fn();

    await processDueProactiveTasks({
      now: new Date("2026-07-05T23:30:00+08:00"),
      sendChannel: vi.fn(),
      repositories: fakeRepositories({ messagesCreate, markSent, latestDirectTarget: telegramTarget }),
    });

    expect(messagesCreate).not.toHaveBeenCalled();
    expect(markSent).not.toHaveBeenCalled();
  });

  it("sends urgent reminders during quiet hours", async () => {
    const messagesCreate = vi.fn();
    const markSent = vi.fn();

    await processDueProactiveTasks({
      now: new Date("2026-07-05T23:30:00+08:00"),
      sendChannel: vi.fn(),
      repositories: fakeRepositories({
        messagesCreate,
        markSent,
        latestDirectTarget: telegramTarget,
        dueTask: {
          id: "task-urgent",
          userId: "user-1",
          conversationId: "conversation-1",
          kind: "reminder",
          content: "吃药",
          scheduledAt: new Date("2026-07-05T23:30:00+08:00"),
          status: "pending",
          metadata: { urgent: true },
        },
      }),
    });

    expect(messagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "assistant",
        content: "提醒一下：吃药",
      }),
    );
    expect(markSent).toHaveBeenCalledWith("task-urgent");
  });

  it("backs off non-reminder tasks after consecutive ignored proactive messages", async () => {
    const messagesCreate = vi.fn();
    const markSent = vi.fn();

    await processDueProactiveTasks({
      now: new Date("2026-07-05T10:00:00+08:00"),
      sendChannel: vi.fn(),
      repositories: fakeRepositories({
        messagesCreate,
        markSent,
        latestDirectTarget: telegramTarget,
        dueTask: {
          id: "task-2",
          userId: "user-1",
          conversationId: "conversation-1",
          kind: "follow_up",
          content: "演讲准备得怎么样了？",
          scheduledAt: new Date("2026-07-05T10:00:00+08:00"),
          status: "pending",
          metadata: {},
        },
        unansweredStreak: 2,
      }),
    });

    expect(messagesCreate).not.toHaveBeenCalled();
    expect(markSent).not.toHaveBeenCalled();
  });

  it("still sends explicit reminders when previous proactive messages were ignored", async () => {
    const messagesCreate = vi.fn();
    const markSent = vi.fn();

    await processDueProactiveTasks({
      now: new Date("2026-07-05T10:00:00+08:00"),
      sendChannel: vi.fn(),
      repositories: fakeRepositories({
        messagesCreate,
        markSent,
        latestDirectTarget: telegramTarget,
        unansweredStreak: 3,
      }),
    });

    expect(messagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "assistant",
        content: "提醒一下：提交报销",
      }),
    );
    expect(markSent).toHaveBeenCalledWith("task-1");
  });
});

function fakeRepositories(input: {
  messagesCreate: (payload: unknown) => unknown;
  markSent: (taskId: string) => void;
  latestDirectTarget: NormalizedChannelMessage | null;
  dueTask?: DbProactiveTask;
  unansweredStreak?: number;
}) {
  const dueTask: DbProactiveTask = {
    id: "task-1",
    userId: "user-1",
    conversationId: "conversation-1",
    kind: "reminder",
    content: "提交报销",
    scheduledAt: new Date("2026-07-05T10:00:00+08:00"),
    status: "pending",
    metadata: {},
  };

  return {
    proactiveTasks: {
      due: vi.fn(async () => [input.dueTask ?? dueTask]),
      countSentToday: vi.fn(async () => 0),
      unansweredStreak: vi.fn(async () => input.unansweredStreak ?? 0),
      markSent: input.markSent,
    },
    settings: {
      get: vi.fn(async () => ({
        proactivity: {
          quietStart: "23:00",
          quietEnd: "08:00",
          maxPerDay: 3,
        },
      })),
    },
    messages: {
      create: input.messagesCreate,
    },
    channels: {
      latestDirectTarget: vi.fn(async () => input.latestDirectTarget),
    },
  };
}
