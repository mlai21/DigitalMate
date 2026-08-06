import { describe, expect, it, vi } from "vitest";

import {
  createChannelAgentTurnRunner,
  stableTurnErrorCode,
  toLegacyChannelMessage,
} from "@/server/channels/runtime/agent-turn";
import { LlmProviderError } from "@/server/llm/errors";
import type { ClaimedChannelEvent } from "@/server/channels/runtime/event-repository";
import type {
  ExecutionJournal,
  ExecutionStep,
  ExecutionStepAction,
} from "@/server/channels/runtime/execution-journal";
import type { ChannelAgentTurnContext } from "@/server/channels/runtime/turn-executor";
import type { LlmClient, LlmStreamInput } from "@/server/llm/types";

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

function recordingLlm(reply: string) {
  const calls: LlmStreamInput[] = [];
  const client: LlmClient = {
    async *stream(input) {
      calls.push(input);
      yield { type: "text", text: reply };
    },
    async completeText() {
      return reply;
    },
  };
  return { calls, client };
}

function toolNames(calls: LlmStreamInput[]): string[] {
  return (calls[0]?.tools ?? []).map((tool) => tool.name);
}

function systemPrompt(calls: LlmStreamInput[]): string {
  return calls[0]?.messages[0]?.content ?? "";
}

describe("stableTurnErrorCode", () => {
  it("keeps the provider status instead of one generic failure bucket", () => {
    expect(stableTurnErrorCode(new LlmProviderError({
      provider: "anthropic",
      model: "claude-opus-4-8",
      status: 500,
      message: "Claude request failed with status 500: {\"type\":\"error\"}",
    }))).toBe("llm_http_500");
    expect(stableTurnErrorCode(new Error("attachment_download_aborted")))
      .toBe("attachment_download_aborted");
    expect(stableTurnErrorCode(new Error("boom with spaces")))
      .toBe("channel_turn_side_effect_failed");
  });
});

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

  it("群聊被 @ 时直接执行，不进入插话判断", async () => {
    const repositories = fakeRepositories({
      recentMessageCount: 8,
    });
    const runner = createRunner(repositories, textLlm("我在。"));
    const context = createContext({
      chatType: "group",
      mentioned: true,
      text: "@Alvin 帮我看下这个报价",
    });

    await expect(runner.decideTurn(context)).resolves.toEqual({
      kind: "proceed",
    });
    expect(repositories.channels.createDecision)
      .not.toHaveBeenCalled();
    expect(repositories.channels.createChannelMessage)
      .toHaveBeenCalledTimes(1);
  });

  it("群聊未被 @ 时仍按插话策略判断", async () => {
    const repositories = fakeRepositories();
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
      reason: "not_relevant",
    });
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

  it("渠道私聊用自然语言即可命中已启用 Skill，并留痕匹配依据", async () => {
    const repositories = fakeRepositories();
    const llm = recordingLlm("按周报流程来。");
    const runner = createRunner(
      repositories,
      llm.client,
      '{"skill":1,"reason":"用户要做的正是每周复盘"}',
    );

    await collect(runner.runAgentTurn(createContext({
      text: "帮我把这周的进展捋一下",
    })));

    expect(repositories.skills.listEnabledIndex).toHaveBeenCalledWith(scope);
    expect(repositories.skills.findByIds)
      .toHaveBeenCalledWith(scope, ["skill-1"]);
    expect(systemPrompt(llm.calls)).toContain("已启用 Skills");
    expect(systemPrompt(llm.calls)).toContain("weekly-review");
    expect(repositories.skills.recordUsage).toHaveBeenCalledWith(
      scope,
      ["skill-1"],
      "conversation-1",
      "auto",
      "用户要做的正是每周复盘",
    );
  });

  it("群聊被 @ 时同样走自然语言匹配", async () => {
    const repositories = fakeRepositories();
    const llm = recordingLlm("我按已批准的做法来。");
    const runner = createRunner(
      repositories,
      llm.client,
      '{"skill":1,"reason":"群里要的就是每周复盘"}',
    );

    await collect(runner.runAgentTurn(createContext({
      chatType: "group",
      mentioned: true,
      text: "@Alvin 把这周的进展捋一下",
    })));

    expect(repositories.skills.listEnabledIndex).toHaveBeenCalledWith(scope);
    expect(systemPrompt(llm.calls)).toContain("weekly-review");
  });

  it("群聊被 @ 且明确要求搜索时会执行联网搜索", async () => {
    const repositories = fakeRepositories();
    const search = vi.fn(async () => [{
      title: "官方定价",
      url: "https://example.com/pricing",
      snippet: "已核实的官方信息",
    }]);
    let round = 0;
    const llm: LlmClient = {
      async *stream() {
        if (round === 0) {
          round += 1;
          yield {
            type: "tool_call",
            toolCall: {
              id: "search-1",
              name: "web_search",
              arguments: JSON.stringify({ query: "qwen3-flash 官方定价" }),
            },
          };
          return;
        }
        yield { type: "text", text: "官方信息已核实。" };
      },
      async completeText() {
        return "";
      },
    };
    const runner = createChannelAgentTurnRunner({
      repositories: repositories as never,
      resolveMainModel: () => ({ client: llm, model: "mock-main" }),
      resolveLightModel: () => ({
        client: textLlm('{"skill":0,"reason":"不贴合"}'),
        model: "mock-light",
      }),
      search,
      now: () => now,
    });
    const context = createContext({
      chatType: "group",
      mentioned: true,
      text: "@Alvin 帮我查一下 qwen3-flash 的官方定价",
    });

    await expect(runner.decideTurn(context)).resolves.toEqual({
      kind: "proceed",
    });
    await expect(collect(runner.runAgentTurn(context)))
      .resolves.toBe("官方信息已核实。");

    expect(search).toHaveBeenCalledWith(
      "qwen3-flash 官方定价",
      undefined,
      undefined,
    );
    expect(repositories.toolLogs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "web_search_gate",
        outputSummary: expect.stringContaining("放行（explicit）"),
      }),
    );
    expect(repositories.toolLogs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "web_search",
        status: "success",
      }),
    );
  });

  it("路由模型判定都不贴合时不加载任何 Skill", async () => {
    const repositories = fakeRepositories();
    const llm = recordingLlm("在的，怎么了？");
    const runner = createRunner(repositories, llm.client);

    await collect(runner.runAgentTurn(createContext({ text: "在吗" })));

    expect(repositories.skills.listEnabledIndex).toHaveBeenCalledWith(scope);
    expect(repositories.skills.findByIds).not.toHaveBeenCalled();
    expect(systemPrompt(llm.calls)).not.toContain("已启用 Skills");
    expect(repositories.skills.recordUsage).not.toHaveBeenCalled();
  });

  it("显式指定 Skill 时不做自动匹配", async () => {
    const repositories = fakeRepositories();
    const llm = recordingLlm("按 weekly-review 执行。");
    const runner = createRunner(repositories, llm.client);

    await collect(runner.runAgentTurn(createContext({
      text: "/weekly-review 整理这一周",
      skillPermission: "explicit_slash",
    })));

    expect(repositories.skills.listEnabledIndex).not.toHaveBeenCalled();
    expect(repositories.skills.findByIds)
      .toHaveBeenCalledWith(scope, ["skill-1"]);
    expect(repositories.skills.recordUsage).toHaveBeenCalledWith(
      scope,
      ["skill-1"],
      "conversation-1",
      "explicit",
    );
  });

  it("附件在场时不自动匹配 Skill", async () => {
    const repositories = fakeRepositories();
    const llm = recordingLlm("我只看附件内容。");
    const runner = createRunner(repositories, llm.client);

    await collect(runner.runAgentTurn(createContext({
      text: "帮我整理周报",
      attachmentsPresent: true,
    })));

    expect(repositories.skills.listEnabledIndex).not.toHaveBeenCalled();
  });

  it("管理员私聊挂载 Skill 创建工具", async () => {
    const repositories = fakeRepositories();
    const llm = recordingLlm("我们先给它起个名字。");
    const runner = createRunner(repositories, llm.client);

    await collect(runner.runAgentTurn(createContext({
      manageGlobalAssets: true,
      text: "我想让你学会写周报",
    })));

    expect(toolNames(llm.calls)).toContain("create_skill");
    expect(toolNames(llm.calls)).toContain("save_skill");
    expect(systemPrompt(llm.calls)).toContain("create_skill");
  });

  it("非管理员私聊不挂载 Skill 创建工具也不提及它", async () => {
    const repositories = fakeRepositories();
    const llm = recordingLlm("这个我这边做不了。");
    const runner = createRunner(repositories, llm.client);

    await collect(runner.runAgentTurn(createContext({
      text: "我想让你学会写周报",
    })));

    expect(toolNames(llm.calls)).not.toContain("create_skill");
    expect(toolNames(llm.calls)).not.toContain("save_skill");
    expect(systemPrompt(llm.calls))
      .not.toMatch(/create_skill|save_skill/);
  });

  it("非管理员发起 /create-skill 时收到中立提示而非静默失败", async () => {
    const repositories = fakeRepositories();
    const llm = recordingLlm("这个得让管理员来。");
    const runner = createRunner(repositories, llm.client);

    await collect(runner.runAgentTurn(createContext({
      text: "/create-skill 报价评审",
      skillPermission: "explicit_slash",
    })));

    expect(systemPrompt(llm.calls))
      .toContain("本轮不具备创建或安装 Skill 的能力");
    expect(systemPrompt(llm.calls))
      .not.toMatch(/create_skill|save_skill/);
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
      resolveLightModel: () => ({ client: llm, model: "mock-light" }),
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
      resolveLightModel: () => ({
        client: textLlm('{"skill":0,"reason":"不贴合"}'),
        model: "mock-light",
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
      manageGlobalAssets: true,
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

  it("自动命中后被纠正会产出收紧适用场景的待确认草稿", async () => {
    const repositories = fakeRepositories();
    const tightened = [
      "---",
      "name: weekly-review",
      "description: 用户明确要按周复盘时（不适用于临时进度同步）",
      "---",
      "# weekly-review",
      "",
      "## 步骤",
      "1. 收集本周更新",
    ].join("\n");
    const runner = createRunner(
      repositories,
      textLlm("我重新按你的意思来。"),
      undefined,
      JSON.stringify({
        mismatched: true,
        reason: "用户只是要临时同步进度，不是周复盘",
        content: tightened,
      }),
    );

    await collect(runner.runAgentTurn(createContext({
      text: "你理解错了，我不是要周复盘",
    })));

    expect(repositories.skillUsageLogs.latestAutoMatch)
      .toHaveBeenCalledWith(scope, "conversation-1");
    expect(repositories.skillRevisions.create).toHaveBeenCalledWith({
      userId: scope.userId,
      skillId: "skill-1",
      proposedContent: tightened,
      reason: expect.stringContaining("以为用户要做周复盘"),
    });
  });

  it("销售的纠正同样算误匹配信号，草稿仍需管理员确认", async () => {
    const repositories = fakeRepositories();
    const runner = createRunner(
      repositories,
      textLlm("好，我换个说法。"),
      undefined,
      JSON.stringify({
        mismatched: true,
        reason: "问的是报价，不是周复盘",
        content: [
          "---",
          "name: weekly-review",
          "description: 用户明确要按周复盘时",
          "---",
          "# weekly-review",
          "",
          "## 步骤",
          "1. 收集本周更新",
        ].join("\n"),
      }),
    );

    await collect(runner.runAgentTurn(createContext({
      text: "你答错了，我问的是报价",
      externalSenderId: "sales-1",
      manageGlobalAssets: false,
    })));

    expect(repositories.skillRevisions.create).toHaveBeenCalledTimes(1);
    // The sales seat still must not write global reflections.
    expect(repositories.reflections.create).not.toHaveBeenCalled();
  });

  it("普通消息与没有自动命中记录时都不产出草稿", async () => {
    const plain = fakeRepositories();
    await collect(createRunner(plain, textLlm("你好呀。")).runAgentTurn(
      createContext({ text: "你好" }),
    ));
    expect(plain.skillUsageLogs.latestAutoMatch).not.toHaveBeenCalled();
    expect(plain.skillRevisions.create).not.toHaveBeenCalled();

    const noMatch = fakeRepositories({ latestAutoMatch: null });
    await collect(createRunner(noMatch, textLlm("我改一下。")).runAgentTurn(
      createContext({ text: "你理解错了" }),
    ));
    expect(noMatch.skillUsageLogs.latestAutoMatch).toHaveBeenCalled();
    expect(noMatch.skillRevisions.create).not.toHaveBeenCalled();
  });

  it("同一条纠正重放不会产出第二份草稿", async () => {
    const repositories = fakeRepositories();
    const tightened = [
      "---",
      "name: weekly-review",
      "description: 用户明确要按周复盘时",
      "---",
      "# weekly-review",
      "",
      "## 步骤",
      "1. 收集本周更新",
    ].join("\n");
    const runner = createRunner(
      repositories,
      textLlm("我重新按你的意思来。"),
      undefined,
      JSON.stringify({
        mismatched: true,
        reason: "不是周复盘",
        content: tightened,
      }),
    );
    const journal = memoryJournal();

    await collect(runner.runAgentTurn(createContext({
      text: "你理解错了，我不是要周复盘",
    }, journal)));
    await collect(runner.runAgentTurn(createContext({
      text: "你理解错了，我不是要周复盘",
    }, journal)));

    expect(repositories.skillRevisions.create).toHaveBeenCalledTimes(1);
  });

  it("销售私聊只检索当前发送者的记忆", async () => {
    const repositories = fakeRepositories();
    const runner = createRunner(
      repositories,
      textLlm("这是只属于你的上下文。"),
    );

    await collect(runner.runAgentTurn(createContext({
      externalSenderId: "sales-1",
    })));

    expect(repositories.memories.findRelevantInContext)
      .toHaveBeenCalledWith(
        scope,
        "direct:connection-1:sales-1",
        "你好",
        undefined,
      );
    expect(repositories.memories.findRelevant)
      .not.toHaveBeenCalled();
  });

  it("群聊不检索任何成员的私聊记忆", async () => {
    const repositories = fakeRepositories();
    const runner = createRunner(
      repositories,
      textLlm("只根据本群上下文回答。"),
    );
    const context = createContext({
      chatType: "group",
      externalSenderId: "sales-1",
    });

    await collect(runner.runAgentTurn(context));

    expect(repositories.memories.findRelevantInContext)
      .not.toHaveBeenCalled();
    expect(repositories.memories.findRelevant)
      .not.toHaveBeenCalled();
  });

  it("销售的纠正不会创建全局反思", async () => {
    const repositories = fakeRepositories();
    const runner = createRunner(
      repositories,
      textLlm("我重新回答。"),
    );

    await collect(runner.runAgentTurn(createContext({
      text: "你刚才理解错了，不是这个意思",
      externalSenderId: "sales-1",
      manageGlobalAssets: false,
    })));

    expect(repositories.reflections.create).not.toHaveBeenCalled();
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

  it("腾讯元宝事件复用唯一 DigitalMate Agent 与记忆", async () => {
    const repositories = fakeRepositories();
    const runner = createRunner(
      repositories,
      textLlm("元宝渠道回复"),
    );
    const context = createContext({
      channelType: "yuanbao",
    });

    await expect(runner.decideTurn(context))
      .resolves.toEqual({ kind: "proceed" });
    await expect(
      collect(runner.runAgentTurn(context)),
    ).resolves.toBe("元宝渠道回复");
    expect(repositories.channels.createChannelMessage)
      .toHaveBeenCalledWith(
        scope,
        expect.objectContaining({
          message: expect.objectContaining({
            channel: "yuanbao",
          }),
        }),
      );
  });
});

/**
 * One light client serves both Skill routing and the mismatch draft in a turn,
 * so it answers by which prompt it was handed.
 */
function lightLlm(skillRoute: string, mismatchReply: string): LlmClient {
  return {
    async *stream() {},
    async completeText(input) {
      const prompt = input.messages.map((message) => message.content).join("\n");
      return prompt.includes("把适用场景改窄") ? mismatchReply : skillRoute;
    },
  };
}

function createRunner(
  repositories: ReturnType<typeof fakeRepositories>,
  llm: LlmClient,
  skillRoute?: string,
  mismatchReply?: string,
) {
  return createChannelAgentTurnRunner({
    repositories: repositories as never,
    resolveMainModel: () => ({
      client: llm,
      model: "mock-main",
    }),
    resolveLightModel: () => ({
      client: lightLlm(
        skillRoute ?? '{"skill":0,"reason":"不贴合"}',
        mismatchReply ?? '{"mismatched":false,"reason":"与做法无关","content":null}',
      ),
      model: "mock-light",
    }),
    now: () => now,
  });
}

function createContext(
  overrides: {
    externalEventId?: string;
    text?: string;
    chatType?: "direct" | "group";
    mentioned?: boolean;
    skillPermission?: "none" | "explicit_slash";
    attachmentsPresent?: boolean;
    rawSummary?: Record<string, string>;
    channelType?: "telegram" | "xiaoyi" | "yuanbao";
    externalSenderId?: string;
    manageGlobalAssets?: boolean;
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
      externalSenderId:
        overrides.externalSenderId ?? "sender-1",
      chatType: overrides.chatType ?? "direct",
      mentioned: overrides.mentioned ?? false,
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
        manageGlobalAssets:
          overrides.manageGlobalAssets ?? false,
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
    latestAutoMatch?: null;
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
      findRelevantInContext: vi.fn(async () => [{
        id: "memory-context-1",
        content: "当前发送者的私有记忆",
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
      listEnabledIndex: vi.fn(async () => [{
        id: "skill-1",
        name: "weekly-review",
        trigger: "每周复盘",
      }]),
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
    skillUsageLogs: {
      latestAutoMatch: vi.fn(async () => (
        overrides.latestAutoMatch === undefined
          ? {
            skill: {
              id: "skill-1",
              name: "weekly-review",
              trigger: "每周复盘",
              content: [
                "---",
                "name: weekly-review",
                "description: 每周复盘",
                "---",
                "# weekly-review",
                "",
                "## 步骤",
                "1. 收集本周更新",
              ].join("\n"),
            },
            matchReason: "以为用户要做周复盘",
          }
          : overrides.latestAutoMatch
      )),
    },
    skillRevisions: {
      hasPendingForSkill: vi.fn(async () => false),
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
