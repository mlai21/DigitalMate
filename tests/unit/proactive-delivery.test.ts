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
  it("cancels legacy shares without an explicit subscription or scheduled digest authorization", async () => {
    const messagesCreate = vi.fn();
    const markSent = vi.fn();
    const markCancelled = vi.fn();

    await processDueProactiveTasks({
      now: new Date("2026-07-05T10:00:00+08:00"),
      sendChannel: vi.fn(),
      repositories: fakeRepositories({
        messagesCreate,
        markSent,
        markCancelled,
        latestDirectTarget: telegramTarget,
        dueTask: {
          id: "legacy-share",
          userId: "user-1",
          conversationId: "conversation-1",
          kind: "share",
          content: "一整页未经整理的搜索结果",
          scheduledAt: new Date("2026-07-05T10:00:00+08:00"),
          status: "pending",
          metadata: {},
        },
      }),
    });

    expect(messagesCreate).not.toHaveBeenCalled();
    expect(markCancelled).toHaveBeenCalledWith("legacy-share");
    expect(markSent).not.toHaveBeenCalled();
  });

  it("cancels shares that name an authorization type but have no persisted source id", async () => {
    const messagesCreate = vi.fn();
    const markCancelled = vi.fn();

    await processDueProactiveTasks({
      now: new Date("2026-07-05T10:00:00+08:00"),
      sendChannel: vi.fn(),
      repositories: fakeRepositories({
        messagesCreate,
        markSent: vi.fn(),
        markCancelled,
        latestDirectTarget: telegramTarget,
        dueTask: {
          id: "source-less-share",
          userId: "user-1",
          conversationId: "conversation-1",
          kind: "share",
          content: "伪造的订阅摘要",
          scheduledAt: new Date("2026-07-05T10:00:00+08:00"),
          status: "pending",
          metadata: { authorization: "subscription" },
        },
      }),
    });

    expect(messagesCreate).not.toHaveBeenCalled();
    expect(markCancelled).toHaveBeenCalledWith("source-less-share");
  });

  it("delivers a share only when its authorization type and source id are both present", async () => {
    const messagesCreate = vi.fn();
    const markSent = vi.fn();

    await processDueProactiveTasks({
      now: new Date("2026-07-05T10:00:00+08:00"),
      sendChannel: vi.fn(),
      repositories: fakeRepositories({
        messagesCreate,
        markSent,
        latestDirectTarget: null,
        dueTask: {
          id: "authorized-share",
          userId: "user-1",
          conversationId: "conversation-1",
          kind: "share",
          content: "这是一条已经整理好的主题摘要",
          scheduledAt: new Date("2026-07-05T10:00:00+08:00"),
          status: "pending",
          metadata: { authorization: "subscription", authorizationSourceId: "subscription-1" },
        },
      }),
    });

    expect(messagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ content: "这是一条已经整理好的主题摘要" }),
    );
    expect(markSent).toHaveBeenCalledWith("authorized-share");
  });

  it("does not push the same proactive task twice when its message already exists", async () => {
    const messagesCreate = vi.fn();
    const markSent = vi.fn();
    const sendChannel = vi.fn();

    await processDueProactiveTasks({
      now: new Date("2026-07-05T10:00:00+08:00"),
      sendChannel,
      repositories: fakeRepositories({
        messagesCreate,
        markSent,
        latestDirectTarget: telegramTarget,
        messageInserted: false,
      }),
    });

    expect(messagesCreate).toHaveBeenCalledTimes(1);
    expect(sendChannel).not.toHaveBeenCalled();
    expect(markSent).toHaveBeenCalledWith("task-1");
  });

  it("marks a task failed when its only channel push attempt fails", async () => {
    const markSent = vi.fn();
    const markFailed = vi.fn();

    await processDueProactiveTasks({
      now: new Date("2026-07-05T10:00:00+08:00"),
      sendChannel: vi.fn(async () => {
        throw new Error("channel unavailable");
      }),
      repositories: fakeRepositories({
        messagesCreate: vi.fn(),
        markSent,
        markFailed,
        latestDirectTarget: telegramTarget,
      }),
    });

    expect(markFailed).toHaveBeenCalledWith("task-1");
    expect(markSent).not.toHaveBeenCalled();
  });

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
  markCancelled?: (taskId: string) => void;
  markFailed?: (taskId: string) => void;
  latestDirectTarget: NormalizedChannelMessage | null;
  dueTask?: DbProactiveTask;
  unansweredStreak?: number;
  messageInserted?: boolean;
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
      markCancelled: input.markCancelled ?? vi.fn(),
      markFailed: input.markFailed ?? vi.fn(),
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
      createFromProactiveTask: vi.fn(async (payload: { taskId: string; userId: string; conversationId: string; content: string }) => {
        input.messagesCreate({
          userId: payload.userId,
          conversationId: payload.conversationId,
          role: "assistant",
          content: payload.content,
        });
        return input.messageInserted ?? true;
      }),
    },
    channels: {
      latestDirectTarget: vi.fn(async () => input.latestDirectTarget),
    },
  };
}
