import { describe, expect, it, vi } from "vitest";

import {
  createChannelAgentTurnRunner,
  toLegacyChannelMessage,
} from "@/server/channels/runtime/agent-turn";
import type { ClaimedChannelEvent } from "@/server/channels/runtime/event-repository";
import type {
  ExecutionJournal,
  ExecutionStep,
  ExecutionStepAction,
} from "@/server/channels/runtime/execution-journal";
import type { ChannelAgentTurnContext } from "@/server/channels/runtime/turn-executor";
import type { LlmClient } from "@/server/llm/types";

const scope = { userId: "user-1", agentId: "agent-1" };
const now = new Date("2026-07-05T10:00:00+08:00");

function textLlm(reply: string): LlmClient {
  return {
    async *stream() {
      yield { type: "text", text: reply };
    },
    async completeText() {
      return reply;
    },
  };
}

describe("channel agent turn", () => {
  it("只生成完整回复，不直接写助手消息或发送平台消息", async () => {
    const repositories = fakeRepositories();
    const runner = createRunner(repositories, textLlm("我在。"));
    const context = createContext();

    expect(await runner.decideTurn(context)).toEqual({
      kind: "proceed",
    });
    expect(await collect(runner.runAgentTurn(context))).toBe("我在。");
    expect(repositories.channels.createChannelMessage)
      .toHaveBeenCalledTimes(1);
    expect(repositories.messages.create).not.toHaveBeenCalled();
  });

  it("提醒副作用通过执行日志只创建一次", async () => {
    const repositories = fakeRepositories();
    const runner = createRunner(
      repositories,
      textLlm("好，我帮你记下。"),
    );
    const context = createContext({
      text: "10 分钟后紧急提醒我吃药",
    });

    await collect(runner.runAgentTurn(context));
    await collect(runner.runAgentTurn(context));

    expect(repositories.proactiveTasks.create)
      .toHaveBeenCalledTimes(1);
    expect(repositories.proactiveTasks.create)
      .toHaveBeenCalledWith(
        scope,
        expect.objectContaining({
          conversationId: "conversation-1",
          kind: "reminder",
          content: "吃药",
          scheduledAt: new Date("2026-07-05T02:10:00.000Z"),
          metadata: { urgent: true },
        }),
      );
  });

  it("群聊繁忙时记录决定并跳过 Agent", async () => {
    const repositories = fakeRepositories({
      recentMessageCount: 8,
    });
    const runner = createRunner(
      repositories,
      textLlm("不应执行"),
    );
    const context = createContext({
      chatType: "group",
      text: "周末去哪爬山？",
    });

    await expect(runner.decideTurn(context)).resolves.toEqual({
      kind: "skip",
      reason: "conversation_busy",
    });
    expect(repositories.channels.createDecision)
      .toHaveBeenCalledWith(
        scope,
        expect.objectContaining({
          shouldInterject: false,
          reason: "conversation_busy",
        }),
      );
  });

  it("群聊决定结果不确定时安全跳过且不重复判断", async () => {
    const repositories = fakeRepositories();
    const journal = memoryJournal({
      "tool:group_interjection_decision": "ambiguous",
    });
    const runner = createRunner(
      repositories,
      textLlm("不应执行"),
    );
    const context = createContext(
      { chatType: "group" },
      journal,
    );

    await expect(runner.decideTurn(context)).resolves.toEqual({
      kind: "skip",
      reason: "decision_outcome_unknown",
    });
    expect(repositories.channels.createDecision)
      .not.toHaveBeenCalled();
  });

  it("只有权限信封批准的斜杠命令才能加载 Skill", async () => {
    const repositories = fakeRepositories();
    const runner = createRunner(
      repositories,
      textLlm("已按 Skill 处理。"),
    );

    await collect(runner.runAgentTurn(createContext({
      text: "/weekly-review 整理这一周",
      skillPermission: "none",
    })));
    expect(repositories.skills.findEnabledByName)
      .not.toHaveBeenCalled();

    await collect(runner.runAgentTurn(createContext({
      externalEventId: "event-2",
      text: "/weekly-review 整理这一周",
      skillPermission: "explicit_slash",
    })));
    expect(repositories.skills.findEnabledByName)
      .toHaveBeenCalledWith(scope, "weekly-review");
    expect(repositories.skills.findByIds)
      .toHaveBeenCalledWith(scope, ["skill-1"]);
  });

  it("附件上下文禁止搜索、Skill 与其他工具", async () => {
    const repositories = fakeRepositories();
    const search = vi.fn();
    const llm: LlmClient = {
      async *stream() {
        yield {
          type: "tool_call",
          toolCall: {
            id: "search-1",
            name: "web_search",
            arguments: JSON.stringify({ query: "新闻" }),
          },
        };
      },
      async completeText() {
        return "";
      },
    };
    const runner = createChannelAgentTurnRunner({
      repositories: repositories as never,
      resolveMainModel: () => ({ client: llm, model: "mock-main" }),
      search: search as never,
      now: () => now,
    });

    const output = await collect(runner.runAgentTurn(createContext({
      text: "/weekly-review 搜一下新闻",
      skillPermission: "explicit_slash",
      attachmentsPresent: true,
    })));

    expect(output).toContain("附件");
    expect(search).not.toHaveBeenCalled();
    expect(repositories.skills.findEnabledByName)
      .not.toHaveBeenCalled();
    expect(repositories.skills.findByIds)
      .not.toHaveBeenCalled();
  });

  it("历史消息含附件时同样禁止搜索和 Skill", async () => {
    const repositories = fakeRepositories({
      historyAttachment: true,
    });
    const search = vi.fn();
    const runner = createChannelAgentTurnRunner({
      repositories: repositories as never,
      resolveMainModel: () => ({
        client: textLlm("我会只阅读已有上下文。"),
        model: "mock-main",
      }),
      search: search as never,
      now: () => now,
    });

    await collect(runner.runAgentTurn(createContext({
      text: "/weekly-review 搜一下新闻",
      skillPermission: "explicit_slash",
    })));

    expect(search).not.toHaveBeenCalled();
    expect(repositories.skills.findEnabledByName)
      .not.toHaveBeenCalled();
  });

  it("私有反思仅在识别到不满时记录", async () => {
    const repositories = fakeRepositories();
    const runner = createRunner(
      repositories,
      textLlm("我重新按你的意思来。"),
    );

    await collect(runner.runAgentTurn(createContext({
      text: "你刚才理解错了，不是这个意思",
    })));

    expect(repositories.reflections.create).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        sourceWindow: expect.objectContaining({
          event: "user_dissatisfaction",
          conversationId: "conversation-1",
        }),
      }),
    );
  });

  it("传给旧会话索引的 raw 只包含脱敏摘要", () => {
    const context = createContext({
      rawSummary: {
        eventType: "message",
        platformMessageId: "m-1",
      },
    });

    expect(toLegacyChannelMessage(context).raw).toEqual({
      eventType: "message",
      platformMessageId: "m-1",
    });
  });

  it("小艺事件进入唯一 DigitalMate Agent 而非第二套运行时", async () => {
    const repositories = fakeRepositories();
    const runner = createRunner(
      repositories,
      textLlm("小艺渠道回复"),
    );
    const context = createContext({
      channelType: "xiaoyi",
    });

    await expect(runner.decideTurn(context))
      .resolves.toEqual({ kind: "proceed" });
    await expect(
      collect(runner.runAgentTurn(context)),
    ).resolves.toBe("小艺渠道回复");
    expect(repositories.channels.createChannelMessage)
      .toHaveBeenCalledWith(
        scope,
        expect.objectContaining({
          message: expect.objectContaining({
            channel: "xiaoyi",
          }),
        }),
      );
  });
});

function createRunner(
  repositories: ReturnType<typeof fakeRepositories>,
  llm: LlmClient,
) {
  return createChannelAgentTurnRunner({
    repositories: repositories as never,
    resolveMainModel: () => ({
      client: llm,
      model: "mock-main",
    }),
    now: () => now,
  });
}

function createContext(
  overrides: {
    externalEventId?: string;
    text?: string;
    chatType?: "direct" | "group";
    skillPermission?: "none" | "explicit_slash";
    attachmentsPresent?: boolean;
    rawSummary?: Record<string, string>;
    channelType?: "telegram" | "xiaoyi";
  } = {},
  journal = memoryJournal(),
): ChannelAgentTurnContext {
  const claim = {
    id: overrides.externalEventId ?? "event-1",
    scope,
    connectionId: "connection-1",
    normalizedEvent: {
      connectionId: "connection-1",
      agentId: scope.agentId,
      channelType: overrides.channelType ?? "telegram",
      externalEventId:
        overrides.externalEventId ?? "event-1",
      externalConversationId: "chat-1",
      externalSenderId: "sender-1",
      chatType: overrides.chatType ?? "direct",
      mentioned: false,
      text: overrides.text ?? "你好",
      thread: {},
      attachments: [],
      occurredAt: now,
      receivedAt: now,
      permission: {
        webSearch: false,
        backgroundNetwork: false,
        tools: false,
        skills: overrides.skillPermission ?? "none",
        attachmentsPresent:
          overrides.attachmentsPresent ?? false,
      },
      rawSummary: overrides.rawSummary ?? {
        eventType: "message",
      },
    },
    clientTurnId: "turn-1",
    payloadHash: "a".repeat(64),
    status: "running",
    claimOwner: "worker-1",
    claimExpiresAt: new Date(now.getTime() + 60_000),
    attempts: 1,
    failureCode: null,
    assistantMessageId: null,
    completedAt: null,
  } as ClaimedChannelEvent;
  return {
    claim,
    conversationId: "conversation-1",
    journal,
  };
}

function fakeRepositories(
  overrides: {
    recentMessageCount?: number;
    historyAttachment?: boolean;
  } = {},
) {
  return {
    channels: {
      createChannelMessage: vi.fn(),
      recentBotMessageAt: vi.fn(async () =>
        new Date("2026-07-05T09:00:00+08:00")
      ),
      sentCounts: vi.fn(async () => ({
        sentInLastHour: 0,
        sentToday: 0,
      })),
      recentMessageCount: vi.fn(async () =>
        overrides.recentMessageCount ?? 1
      ),
      createDecision: vi.fn(),
    },
    memories: {
      findRelevant: vi.fn(async () => [{
        id: "memory-1",
        content: "用户喜欢周末爬山",
        createdAt: now,
      }]),
    },
    proactiveTasks: {
      create: vi.fn(),
    },
    messages: {
      recentHistory: vi.fn(async () =>
        overrides.historyAttachment
          ? [{
              id: "history-1",
              role: "user" as const,
              content: "附件内容",
            }]
          : []
      ),
      create: vi.fn(),
    },
    messageAttachments: {
      listForMessages: vi.fn(async () =>
        overrides.historyAttachment
          ? [{ id: "attachment-1" }]
          : []
      ),
    },
    settings: {
      get: vi.fn(async () => ({
        persona: { name: "DigitalMate", style: "温暖" },
        proactivity: {
          quietStart: "23:00",
          quietEnd: "08:00",
          maxPerDay: 5,
        },
        modelRouting: { main: "mock", light: "mock" },
        cadence: {},
        search: { aggressiveness: "conservative" },
      })),
    },
    reflections: {
      create: vi.fn(),
      findAppliedSuggestions: vi.fn(async () => []),
    },
    skills: {
      findEnabledByName: vi.fn(async () => ({
        id: "skill-1",
        name: "weekly-review",
      })),
      findByIds: vi.fn(async () => [{
        id: "skill-1",
        name: "weekly-review",
        trigger: "每周复盘",
        content: "按周复盘",
      }]),
      recordUsage: vi.fn(),
      create: vi.fn(),
    },
    conversationSummaries: {
      latest: vi.fn(async () => null),
    },
    llmUsage: {
      create: vi.fn(),
    },
    toolLogs: {
      create: vi.fn(),
    },
  };
}

function memoryJournal(
  initial: Record<string, ExecutionStepAction> = {},
): ExecutionJournal {
  const states = new Map<
    string,
    { action: ExecutionStepAction; output?: unknown }
  >(
    Object.entries(initial).map(([key, action]) => [
      key,
      { action },
    ]),
  );
  return {
    async begin(step: ExecutionStep) {
      const existing = states.get(step.key);
      if (!existing) {
        states.set(step.key, { action: "run" });
        return "run";
      }
      if (existing.action === "run") return "ambiguous";
      return existing.action;
    },
    async complete(stepKey, output) {
      states.set(stepKey, { action: "reuse", output });
    },
    async fail(stepKey) {
      states.set(stepKey, { action: "ambiguous" });
    },
    async read<T>(stepKey: string) {
      return (states.get(stepKey)?.output as T | undefined) ?? null;
    },
  };
}

async function collect(
  stream: AsyncIterable<string>,
): Promise<string> {
  let output = "";
  for await (const chunk of stream) output += chunk;
  return output;
}
