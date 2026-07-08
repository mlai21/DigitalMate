import { describe, expect, it, vi } from "vitest";
import { handleChannelMessage } from "@/server/channels/handler";
import type { NormalizedChannelMessage } from "@/server/channels/types";
import type { LlmClient } from "@/server/llm/types";

const directMessage: NormalizedChannelMessage = {
  channel: "telegram",
  externalConversationId: "123",
  externalMessageId: "m1",
  senderId: "u1",
  chatType: "direct",
  text: "你好",
  occurredAt: new Date("2026-07-05T10:00:00+08:00"),
  raw: {},
};

describe("handleChannelMessage", () => {
  it("answers direct channel messages with the shared agent", async () => {
    const send = vi.fn();
    const createChannelMessage = vi.fn((input: unknown) => {
      void input;
    });
    const llm: LlmClient = {
      async *streamText() {
        yield "我在。";
      },
      async completeText() {
        return "我在。";
      },
    };

    await handleChannelMessage({
      message: directMessage,
      userId: "user-1",
      repositories: fakeRepositories({ createChannelMessage }),
      llm,
      model: "mock-main",
      send,
      now: new Date("2026-07-05T10:00:00+08:00"),
    });

    expect(createChannelMessage).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(directMessage, "我在。");
  });

  it("splits long channel replies into natural message segments", async () => {
    const send = vi.fn();
    const llm: LlmClient = {
      async *streamText() {
        yield "我在。可以先把事情拆小！然后我们一步一步来？";
      },
      async completeText() {
        return "";
      },
    };

    await handleChannelMessage({
      message: directMessage,
      userId: "user-1",
      repositories: fakeRepositories({}),
      llm,
      model: "mock-main",
      send,
      now: new Date("2026-07-05T10:00:00+08:00"),
    });

    expect(send).toHaveBeenNthCalledWith(1, directMessage, "我在。");
    expect(send).toHaveBeenNthCalledWith(2, directMessage, "可以先把事情拆小！");
    expect(send).toHaveBeenNthCalledWith(3, directMessage, "然后我们一步一步来？");
  });

  it("applies configured channel cadence between message segments", async () => {
    const send = vi.fn();
    const delay = vi.fn();
    const llm: LlmClient = {
      async *streamText() {
        yield "第一句。第二句。第三句。";
      },
      async completeText() {
        return "";
      },
    };

    await handleChannelMessage({
      message: directMessage,
      userId: "user-1",
      repositories: fakeRepositories({ cadence: { segmentDelayMs: 25, maxSegments: 2 } }),
      llm,
      model: "mock-main",
      send,
      delay,
      now: new Date("2026-07-05T10:00:00+08:00"),
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, directMessage, "第一句。");
    expect(send).toHaveBeenNthCalledWith(2, directMessage, "第二句。");
    expect(delay).toHaveBeenCalledWith(25);
  });

  it("applies a configured first-response delay before sending channel replies", async () => {
    const send = vi.fn();
    const delay = vi.fn();
    const llm: LlmClient = {
      async *streamText() {
        yield "第一句。第二句。";
      },
      async completeText() {
        return "";
      },
    };

    await handleChannelMessage({
      message: directMessage,
      userId: "user-1",
      repositories: fakeRepositories({ cadence: { responseDelayMs: 80, segmentDelayMs: 25, maxSegments: 2 } }),
      llm,
      model: "mock-main",
      send,
      delay,
      now: new Date("2026-07-05T10:00:00+08:00"),
    });

    expect(delay).toHaveBeenNthCalledWith(1, 80);
    expect(delay).toHaveBeenNthCalledWith(2, 25);
    expect(send).toHaveBeenNthCalledWith(1, directMessage, "第一句。");
  });

  it("creates reminder tasks from direct channel messages", async () => {
    const createTask = vi.fn();
    const llm: LlmClient = {
      async *streamText() {
        yield "好，我帮你记下。";
      },
      async completeText() {
        return "";
      },
    };

    await handleChannelMessage({
      message: { ...directMessage, text: "10 分钟后提醒我喝水" },
      userId: "user-1",
      repositories: fakeRepositories({ createTask }),
      llm,
      model: "mock-main",
      send: vi.fn(),
      now: new Date("2026-07-05T10:00:00+08:00"),
    });

    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        conversationId: "conversation-1",
        kind: "reminder",
        content: "喝水",
        scheduledAt: new Date("2026-07-05T02:10:00.000Z"),
      }),
    );
  });

  it("creates urgent reminder tasks from direct channel messages", async () => {
    const createTask = vi.fn();
    const llm: LlmClient = {
      async *streamText() {
        yield "好，我会及时提醒你。";
      },
      async completeText() {
        return "";
      },
    };

    await handleChannelMessage({
      message: { ...directMessage, text: "10 分钟后紧急提醒我吃药" },
      userId: "user-1",
      repositories: fakeRepositories({ createTask }),
      llm,
      model: "mock-main",
      send: vi.fn(),
      now: new Date("2026-07-05T10:00:00+08:00"),
    });

    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        conversationId: "conversation-1",
        kind: "reminder",
        content: "吃药",
        scheduledAt: new Date("2026-07-05T02:10:00.000Z"),
        metadata: { urgent: true },
      }),
    );
  });


  it("creates follow-up tasks from direct channel messages", async () => {
    const createTask = vi.fn();
    const llm: LlmClient = {
      async *streamText() {
        yield "记下了，明天我来问问进展。";
      },
      async completeText() {
        return "";
      },
    };

    await handleChannelMessage({
      message: { ...directMessage, text: "我在准备一个演讲" },
      userId: "user-1",
      repositories: fakeRepositories({ createTask }),
      llm,
      model: "mock-main",
      send: vi.fn(),
      now: new Date("2026-07-05T10:00:00+08:00"),
    });

    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        conversationId: "conversation-1",
        kind: "follow_up",
        content: "演讲准备得怎么样了？",
        scheduledAt: new Date("2026-07-06T01:00:00.000Z"),
      }),
    );
  });

  it("records user dissatisfaction from channel messages as private reflections", async () => {
    const createReflection = vi.fn();
    const llm: LlmClient = {
      async *streamText() {
        yield "我重新按你的意思来。";
      },
      async completeText() {
        return "";
      },
    };

    await handleChannelMessage({
      message: { ...directMessage, text: "你刚才理解错了，不是这个意思" },
      userId: "user-1",
      repositories: fakeRepositories({ createReflection }),
      llm,
      model: "mock-main",
      send: vi.fn(),
      now: new Date("2026-07-05T10:00:00+08:00"),
    });

    expect(createReflection).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        sourceWindow: expect.objectContaining({
          event: "user_dissatisfaction",
          conversationId: "conversation-1",
        }),
      }),
    );
  });

  it("records group interjection decisions before sending", async () => {
    const send = vi.fn();
    const createDecision = vi.fn((input: unknown) => {
      void input;
    });
    const llm: LlmClient = {
      async *streamText() {
        yield "上次你说想爬山，周末可以看看天气。";
      },
      async completeText() {
        return "";
      },
    };

    await handleChannelMessage({
      message: { ...directMessage, chatType: "group", text: "周末去哪爬山？" },
      userId: "user-1",
      repositories: fakeRepositories({ createDecision }),
      llm,
      model: "mock-main",
      send,
      now: new Date("2026-07-05T10:00:00+08:00"),
    });

    expect(createDecision).toHaveBeenCalledWith(expect.objectContaining({ shouldInterject: true }));
    expect(send).toHaveBeenCalled();
  });

  it("keeps group chatter out of long-term memory extraction", async () => {
    const createMessage = vi.fn();
    const llm: LlmClient = {
      async *streamText() {
        yield "上次你说想爬山，周末可以看看天气。";
      },
      async completeText() {
        return "";
      },
    };

    await handleChannelMessage({
      message: { ...directMessage, chatType: "group", text: "我朋友小李的身份证是 110101199003071234" },
      userId: "user-1",
      repositories: fakeRepositories({ createMessage }),
      llm,
      model: "mock-main",
      send: vi.fn(),
      now: new Date("2026-07-05T10:00:00+08:00"),
    });

    expect(createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "user",
        content: "我朋友小李的身份证是 110101199003071234",
        memoryProcessed: true,
      }),
    );
  });

  it("does not interject while a group conversation is busy", async () => {
    const send = vi.fn();
    const createDecision = vi.fn((input: unknown) => {
      void input;
    });
    const llm: LlmClient = {
      async *streamText() {
        yield "上次你说想爬山，周末可以看看天气。";
      },
      async completeText() {
        return "";
      },
    };

    await handleChannelMessage({
      message: { ...directMessage, chatType: "group", text: "周末去哪爬山？" },
      userId: "user-1",
      repositories: fakeRepositories({ createDecision, recentMessageCount: 8 }),
      llm,
      model: "mock-main",
      send,
      now: new Date("2026-07-05T10:00:00+08:00"),
    });

    expect(createDecision).toHaveBeenCalledWith(expect.objectContaining({ shouldInterject: false, reason: "conversation_busy" }));
    expect(send).not.toHaveBeenCalled();
  });
});

function fakeRepositories(overrides: {
  createChannelMessage?: (input: unknown) => unknown;
  createDecision?: (input: unknown) => unknown;
  createReflection?: (input: unknown) => unknown;
  createMessage?: (input: unknown) => unknown;
  recentMessageCount?: number;
  createTask?: (input: unknown) => unknown;
  cadence?: unknown;
}) {
  return {
    channels: {
      ensureConversation: vi.fn(async () => ({ id: "conversation-1" })),
      createChannelMessage:
        overrides.createChannelMessage ??
        vi.fn((input: unknown) => {
          void input;
        }),
      recentBotMessageAt: vi.fn(async () => new Date("2026-07-05T09:00:00+08:00")),
      sentCounts: vi.fn(async () => ({ sentInLastHour: 0, sentToday: 0 })),
      recentMessageCount: vi.fn(async () => overrides.recentMessageCount ?? 1),
      createDecision:
        overrides.createDecision ??
        vi.fn((input: unknown) => {
          void input;
        }),
    },
    memories: {
      findRelevant: vi.fn(async () => [{ id: "m1", content: "用户喜欢周末爬山", createdAt: new Date() }]),
    },
    proactiveTasks: {
      create:
        overrides.createTask ??
        vi.fn((input: unknown) => {
          void input;
        }),
    },
    toolLogs: {
      create: vi.fn(),
    },
    reflections: {
      findAppliedSuggestions: vi.fn(async () => []),
      create:
        overrides.createReflection ??
        vi.fn((input: unknown) => {
          void input;
        }),
    },
    messages: {
      recentHistory: vi.fn(async () => []),
      create:
        overrides.createMessage ??
        vi.fn((input: unknown) => {
          void input;
        }),
    },
    settings: {
      get: vi.fn(async () => ({
        persona: { name: "DigitalMate", style: "温暖" },
        proactivity: { quietStart: "23:00", quietEnd: "08:00", maxPerDay: 5 },
        modelRouting: { main: "mock", light: "mock" },
        cadence: overrides.cadence ?? {},
      })),
    },
  };
}
