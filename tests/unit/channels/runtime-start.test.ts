import { describe, expect, it, vi } from "vitest";

import {
  createChannelDeliveryTransport,
  createLeasedChannelTurnExecutor,
  enqueueProactiveChannelDelivery,
} from "@/server/channels/runtime/start";
import {
  ChannelDeliveryDeferred,
  ChannelSendError,
} from "@/server/channels/runtime/delivery-worker";
import type {
  ClaimedChannelDelivery,
} from "@/server/channels/runtime/delivery-repository";

const delivery = {
  id: "delivery-1",
  scope: { userId: "user-1", agentId: "agent-1" },
  eventId: "event-1",
  sourceTaskId: null,
  connectionId: "connection-1",
  assistantMessageId: "message-1",
  replyHandleId: "reply-1",
  body: "完整回复",
  recipient: {
    externalConversationId: "conversation-1",
  },
  status: "running",
  claimOwner: "delivery-worker",
  claimExpiresAt: new Date("2026-07-26T00:01:00.000Z"),
  attempts: 1,
  attemptCycleBaseline: 0,
  nextAttemptAt: new Date("2026-07-26T00:00:00.000Z"),
  lastErrorCode: null,
  sentAt: null,
} satisfies ClaimedChannelDelivery;

describe("channel runtime start", () => {
  it("把 iMessage 节点投递冻结为一条消息并交给持久化节点桥接", async () => {
    const sendViaNode = vi.fn(async () => undefined);
    const connection = {
      id: "connection-1",
      scope: delivery.scope,
      channelType: "imessage" as const,
      enabled: true,
      revision: 1,
      runtimeNodeId: "node-1",
      config: {},
    };
    const transport = createChannelDeliveryTransport({
      loadConnection: vi.fn(async () => connection),
      createAdapter: vi.fn(),
      loadReplyHandle: vi.fn(async () => null),
      sendViaNode,
      now: () => new Date("2026-07-26T00:00:00.000Z"),
    });
    const signal = new AbortController().signal;

    await expect(
      transport.mode(delivery, signal),
    ).resolves.toBe("segmented");
    await expect(
      transport.segmentBodies!(delivery, signal),
    ).resolves.toEqual({
      segments: ["完整回复"],
      prefix: "",
    });
    await expect(transport.send({
      delivery: {
        ...delivery,
        recipient: {
          ...delivery.recipient,
          externalUserId: "+8613800000000",
          chatType: "direct",
        },
      },
      mode: "segmented",
      segmentNo: 1,
      segmentCount: 1,
      body: "完整回复",
      state: { sequence: 1, final: true },
      previousResult: null,
    }, signal)).rejects.toBeInstanceOf(
      ChannelDeliveryDeferred,
    );
    expect(sendViaNode).toHaveBeenCalledWith(
      expect.objectContaining({
        connection,
        delivery: expect.objectContaining({
          body: "完整回复",
          recipient: expect.objectContaining({
            chatType: "direct",
          }),
        }),
      }),
    );
  });

  it("在进入 Mac 节点前按真实 chatType 拒绝 iMessage 群聊发送", async () => {
    const sendViaNode = vi.fn();
    const transport = createChannelDeliveryTransport({
      loadConnection: vi.fn(async () => ({
        id: "connection-1",
        scope: delivery.scope,
        channelType: "imessage" as const,
        enabled: true,
        revision: 1,
        runtimeNodeId: "node-1",
        config: {},
      })),
      createAdapter: vi.fn(),
      loadReplyHandle: vi.fn(async () => null),
      sendViaNode,
    });

    await expect(transport.send({
      delivery: {
        ...delivery,
        recipient: {
          externalConversationId: "group-1",
          externalUserId: "member-1",
          chatType: "group",
        },
      },
      mode: "segmented",
      segmentNo: 1,
      segmentCount: 1,
      body: "不应发送",
      state: { sequence: 1, final: true },
      previousResult: null,
    }, new AbortController().signal)).rejects.toMatchObject({
      code: "imessage_group_unsupported",
      retryable: false,
    });
    expect(sendViaNode).not.toHaveBeenCalled();
  });

  it("拒绝缺少明确 direct 标记的 iMessage 收件人", async () => {
    const sendViaNode = vi.fn();
    const transport = createChannelDeliveryTransport({
      loadConnection: vi.fn(async () => ({
        id: "connection-1",
        scope: delivery.scope,
        channelType: "imessage" as const,
        enabled: true,
        revision: 1,
        runtimeNodeId: "node-1",
        config: {},
      })),
      createAdapter: vi.fn(),
      loadReplyHandle: vi.fn(async () => null),
      sendViaNode,
    });

    await expect(transport.send({
      delivery: {
        ...delivery,
        recipient: {
          externalConversationId: "chat-1",
          externalUserId: "member-1",
        },
      },
      mode: "segmented",
      segmentNo: 1,
      segmentCount: 1,
      body: "不应发送",
      state: { sequence: 1, final: true },
      previousResult: null,
    }, new AbortController().signal)).rejects.toMatchObject({
      code: "imessage_group_unsupported",
      retryable: false,
    });
    expect(sendViaNode).not.toHaveBeenCalled();
  });

  it("仅在连接显式开启时选择累计流式发送", async () => {
    const loadConnection = vi.fn(async () => ({
      id: "connection-1",
      scope: delivery.scope,
      channelType: "feishu" as const,
      enabled: true,
      revision: 1,
      config: { streaming_enabled: false },
    }));
    const transport = createChannelDeliveryTransport({
      loadConnection,
      createAdapter: () => ({
        streaming: vi.fn(),
        validateConfig: (config) =>
          config as Record<string, unknown>,
        send: vi.fn(),
      }),
      loadReplyHandle: vi.fn(),
    });
    const signal = new AbortController().signal;

    await expect(
      transport.mode(delivery, signal),
    ).resolves.toBe("segmented");
    loadConnection.mockResolvedValueOnce({
      id: "connection-1",
      scope: delivery.scope,
      channelType: "feishu" as const,
      enabled: true,
      revision: 1,
      config: { streaming_enabled: true },
    });
    await expect(
      transport.mode(delivery, signal),
    ).resolves.toBe("streaming");
  });

  it("小艺 A2A 固定使用可恢复的任务分片事务", async () => {
    const transport = createChannelDeliveryTransport({
      loadConnection: vi.fn(async () => ({
        id: "connection-1",
        scope: delivery.scope,
        channelType: "xiaoyi" as const,
        enabled: true,
        revision: 1,
        config: {
          ak: "ak",
          sk: "sk",
          agent_id: "agent-xiaoyi",
          task_timeout_ms: 3_600_000,
        },
      })),
      createAdapter: () => ({
        streaming: vi.fn(),
        validateConfig: (config) =>
          config as Record<string, unknown>,
        send: vi.fn(),
      }),
      loadReplyHandle: vi.fn(),
    });

    await expect(
      transport.mode(
        delivery,
        new AbortController().signal,
      ),
    ).resolves.toBe("task-streaming");
    await expect(
      transport.taskSegmentCodePointLimit!(
        delivery,
        new AbortController().signal,
      ),
    ).resolves.toBe(4_000);
  });

  it("腾讯元宝按首段前缀余量生成可恢复的 2800 字分片", async () => {
    const transport = createChannelDeliveryTransport({
      loadConnection: vi.fn(async () => ({
        id: "connection-1",
        scope: delivery.scope,
        channelType: "yuanbao" as const,
        enabled: true,
        revision: 1,
        config: {
          app_id: "app",
          app_secret: "secret",
          api_domain: "bot.yuanbao.tencent.com",
          bot_prefix: "前",
        },
      })),
      createAdapter: () => ({
        validateConfig: (config) =>
          config as Record<string, unknown>,
        send: vi.fn(),
      }),
      loadReplyHandle: vi.fn(),
    });

    const segments = await transport.segmentBodies!(
      {
        ...delivery,
        body: "😀".repeat(2_800),
      },
      new AbortController().signal,
    );
    expect(segments?.segments.map((segment) =>
      Array.from(segment).length
    )).toEqual([2_799, 1]);
    expect(segments?.prefix).toBe("前");
  });

  it("微信把一条已持久化回复和前缀冻结为一条平台消息", async () => {
    const send = vi.fn(async () => ({
      externalMessageId: "wechat-message",
      sentAt: new Date(),
      rawSummary: {},
    }));
    const transport = createChannelDeliveryTransport({
      loadConnection: vi.fn(async () => ({
        id: "connection-1",
        scope: delivery.scope,
        channelType: "wechat" as const,
        enabled: true,
        revision: 1,
        config: {
          bot_token: "secret",
          base_url: "https://ilinkai.weixin.qq.com",
          bot_prefix: "前",
        },
      })),
      createAdapter: () => ({
        validateConfig: (config) =>
          config as Record<string, unknown>,
        send,
      }),
      loadReplyHandle: vi.fn(async () => ({
        publicFields: {
          targetId: "alice@im.wechat",
        },
        secretFields: {
          contextToken: "wechat-context-token",
        },
        expiresAt: null,
      })),
    });
    const planned = await transport.segmentBodies!(
      {
        ...delivery,
        body: "第一段。\n\n第二段。",
      },
      new AbortController().signal,
    );
    expect(planned).toEqual({
      segments: ["第一段。\n\n第二段。"],
      prefix: "前",
    });

    await transport.send({
      delivery,
      mode: "segmented",
      segmentNo: 1,
      segmentCount: 1,
      body: "前第一段。\n\n第二段。",
      state: { sequence: 1, final: true },
      previousResult: null,
    }, new AbortController().signal);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "前第一段。\n\n第二段。",
      }),
      expect.objectContaining({
        config: expect.objectContaining({
          bot_prefix: "",
        }),
      }),
    );
  });

  it("微信拒绝上下文令牌后持久化失效回复句柄", async () => {
    const invalidateReplyHandle = vi.fn(
      async () => true,
    );
    const transport = createChannelDeliveryTransport({
      loadConnection: vi.fn(async () => ({
        id: "connection-1",
        scope: delivery.scope,
        channelType: "wechat" as const,
        enabled: true,
        revision: 1,
        config: {
          bot_token: "secret",
          base_url: "https://ilinkai.weixin.qq.com",
        },
      })),
      createAdapter: () => ({
        validateConfig: (config) =>
          config as Record<string, unknown>,
        send: vi.fn(async () => {
          throw Object.assign(
            new Error("reply_handle_invalid"),
            { retryable: false },
          );
        }),
      }),
      loadReplyHandle: vi.fn(async () => ({
        publicFields: {
          targetId: "alice@im.wechat",
        },
        secretFields: {
          contextToken: "expired-context-token",
        },
        expiresAt: null,
      })),
      invalidateReplyHandle,
    });

    await expect(transport.send({
      delivery,
      mode: "segmented",
      segmentNo: 1,
      segmentCount: 1,
      body: "不会重复发送",
      state: { sequence: 1, final: true },
      previousResult: null,
    }, new AbortController().signal)).rejects.toMatchObject({
      code: "reply_handle_invalid",
      retryable: false,
    });
    expect(invalidateReplyHandle).toHaveBeenCalledWith(
      delivery.scope,
      "reply-1",
      expect.any(Date),
    );
  });

  it("发送 Worker 从加密仓储加载配置和回复句柄", async () => {
    const send = vi.fn(async () => ({
      externalMessageId: "platform-1",
      sentAt: new Date("2026-07-26T00:00:01.000Z"),
      rawSummary: { ok: true },
    }));
    const validateConfig = vi.fn((config) => config);
    const transport = createChannelDeliveryTransport({
      loadConnection: vi.fn(async () => ({
        id: "connection-1",
        scope: delivery.scope,
        channelType: "dingtalk" as const,
        enabled: true,
        revision: 1,
        config: { robot_code: "robot-1" },
      })),
      createAdapter: () => ({
        streaming: undefined,
        validateConfig,
        send,
      }),
      loadReplyHandle: vi.fn(async () => ({
        publicFields: {
          conversationId: "conversation-1",
        },
        secretFields: {
          sessionWebhook:
            "https://oapi.dingtalk.com/robot/send?access_token=secret",
        },
        expiresAt: null,
      })),
      now: () => new Date("2026-07-26T00:00:01.000Z"),
    });

    const result = await transport.send({
      delivery,
      mode: "segmented",
      segmentNo: 1,
      segmentCount: 1,
      body: "分段回复",
      state: { sequence: 1, final: true },
      previousResult: null,
    }, new AbortController().signal);

    expect(validateConfig).toHaveBeenCalledWith({
      robot_code: "robot-1",
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "分段回复",
        deliverySequence: 1,
        replyHandle: expect.objectContaining({
          secretFields: expect.objectContaining({
            sessionWebhook: expect.stringContaining(
              "oapi.dingtalk.com",
            ),
          }),
        }),
      }),
      expect.objectContaining({
        config: { robot_code: "robot-1" },
      }),
    );
    expect(result.externalMessageId).toBe("platform-1");
  });

  it("连接已删除或禁用时不会触达平台", async () => {
    const transport = createChannelDeliveryTransport({
      loadConnection: vi.fn(async () => null),
      createAdapter: vi.fn(),
      loadReplyHandle: vi.fn(),
    });

    await expect(transport.send({
      delivery,
      mode: "segmented",
      segmentNo: 1,
      segmentCount: 1,
      body: "不应发送",
      state: { sequence: 1, final: true },
      previousResult: null,
    }, new AbortController().signal)).rejects.toMatchObject({
      code: "runtime_prerequisite_missing",
      retryable: false,
    } satisfies Partial<ChannelSendError>);
  });

  it("保留 Adapter 对平台错误的重试判定", async () => {
    const platformError = Object.assign(
      new Error("response_invalid"),
      { retryable: false },
    );
    const transport = createChannelDeliveryTransport({
      loadConnection: vi.fn(async () => ({
        id: "connection-1",
        scope: delivery.scope,
        channelType: "qq" as const,
        enabled: true,
        revision: 1,
        config: {},
      })),
      createAdapter: () => ({
        streaming: undefined,
        validateConfig: (config) =>
          config as Record<string, unknown>,
        send: vi.fn(async () => {
          throw platformError;
        }),
      }),
      loadReplyHandle: vi.fn(async () => ({
        publicFields: {},
        secretFields: {},
        expiresAt: null,
      })),
    });

    await expect(transport.send({
      delivery,
      mode: "segmented",
      segmentNo: 1,
      segmentCount: 1,
      body: "不应重试",
      state: { sequence: 1, final: true },
      previousResult: null,
    }, new AbortController().signal)).rejects.toMatchObject({
      code: "response_invalid",
      retryable: false,
    });
  });

  it("为 QQ 主动任务保留明确的会话类型和 OpenID", async () => {
    const enqueueProactive = vi.fn(async () => "delivery-qq-1");
    const result = await enqueueProactiveChannelDelivery({
      pool: {
        query: vi.fn(async () => ({
          rowCount: 1,
          rows: [{ id: "connection-qq" }],
        })),
      } as never,
      repositories: {
        channelDeliveries: { enqueueProactive },
      } as never,
      scope: delivery.scope,
      taskId: "task-qq-1",
      assistantMessageId: "assistant-qq-1",
      content: "主动提醒",
      target: {
        channel: "qq",
        externalConversationId: "c2c:user-open-1",
        externalMessageId: "message-qq-1",
        senderId: "user-open-1",
        chatType: "direct",
        text: "",
        occurredAt:
          new Date("2026-07-26T00:00:00.000Z"),
      },
    });

    expect(result).toEqual({ queued: true });
    expect(enqueueProactive).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "connection-qq",
        recipient: {
          externalConversationId: "c2c:user-open-1",
          externalUserId: "user-open-1",
          chatType: "direct",
        },
      }),
    );
  });

  it("允许企业微信已授权任务进入主动消息队列", async () => {
    const enqueueProactive = vi.fn(async () => "delivery-wecom-1");
    const result = await enqueueProactiveChannelDelivery({
      pool: {
        query: vi.fn(async () => ({
          rowCount: 1,
          rows: [{ id: "connection-wecom" }],
        })),
      } as never,
      repositories: {
        channelDeliveries: { enqueueProactive },
      } as never,
      scope: delivery.scope,
      taskId: "task-wecom-1",
      assistantMessageId: "assistant-wecom-1",
      content: "主动提醒",
      target: {
        channel: "wecom",
        externalConversationId: "group-product",
        externalMessageId: "message-wecom-1",
        senderId: "user-alice",
        chatType: "group",
        text: "",
        occurredAt:
          new Date("2026-07-26T00:00:00.000Z"),
      },
    });

    expect(result).toEqual({ queued: true });
    expect(enqueueProactive).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "connection-wecom",
        recipient: {
          externalConversationId: "group-product",
          externalUserId: "user-alice",
          chatType: "group",
        },
      }),
    );
  });

  it("允许腾讯元宝已授权任务复用原会话目标", async () => {
    const enqueueProactive = vi.fn(
      async () => "delivery-yuanbao-1",
    );
    const result = await enqueueProactiveChannelDelivery({
      pool: {
        query: vi.fn(async () => ({
          rowCount: 1,
          rows: [{ id: "connection-yuanbao" }],
        })),
      } as never,
      repositories: {
        channelDeliveries: { enqueueProactive },
      } as never,
      scope: delivery.scope,
      taskId: "task-yuanbao-1",
      assistantMessageId: "assistant-yuanbao-1",
      content: "主动提醒",
      target: {
        channel: "yuanbao",
        externalConversationId: "group-product",
        externalMessageId: "message-yuanbao-1",
        senderId: "user-alice",
        chatType: "group",
        text: "",
        occurredAt:
          new Date("2026-07-26T00:00:00.000Z"),
      },
    });

    expect(result).toEqual({ queued: true });
    expect(enqueueProactive).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "connection-yuanbao",
        recipient: {
          externalConversationId: "group-product",
          externalUserId: "user-alice",
          chatType: "group",
        },
      }),
    );
  });

  it("微信主动任务从数据库复用最近的加密回复句柄", async () => {
    const enqueueProactive = vi.fn(
      async () => "delivery-wechat-1",
    );
    const query = vi.fn()
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: "connection-wechat" }],
      })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: "reply-wechat" }],
      });
    const result = await enqueueProactiveChannelDelivery({
      pool: { query } as never,
      repositories: {
        channelDeliveries: { enqueueProactive },
      } as never,
      scope: delivery.scope,
      taskId: "task-wechat-1",
      assistantMessageId: "assistant-wechat-1",
      content: "主动提醒",
      target: {
        channel: "wechat",
        externalConversationId: "alice@im.wechat",
        externalMessageId: "message-wechat-1",
        senderId: "alice@im.wechat",
        chatType: "direct",
        text: "",
        occurredAt:
          new Date("2026-07-26T00:00:00.000Z"),
      },
    });

    expect(result).toEqual({ queued: true });
    expect(query).toHaveBeenCalledTimes(2);
    expect(enqueueProactive).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "connection-wechat",
        replyHandleId: "reply-wechat",
        recipient: {
          externalConversationId: "alice@im.wechat",
          externalUserId: "alice@im.wechat",
          chatType: "direct",
        },
      }),
    );
  });

  it("微信没有持久化回复句柄时不靠进程内缓存入队", async () => {
    const enqueueProactive = vi.fn();
    const query = vi.fn()
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: "connection-wechat" }],
      })
      .mockResolvedValueOnce({
        rowCount: 0,
        rows: [],
      });
    const result = await enqueueProactiveChannelDelivery({
      pool: { query } as never,
      repositories: {
        channelDeliveries: { enqueueProactive },
      } as never,
      scope: delivery.scope,
      taskId: "task-wechat-no-handle",
      assistantMessageId: "assistant-wechat-no-handle",
      content: "不应入队",
      target: {
        channel: "wechat",
        externalConversationId: "alice@im.wechat",
        externalMessageId: "message-wechat-no-handle",
        senderId: "alice@im.wechat",
        chatType: "direct",
        text: "",
        occurredAt:
          new Date("2026-07-26T00:00:00.000Z"),
      },
    });

    expect(result).toEqual({ queued: false });
    expect(enqueueProactive).not.toHaveBeenCalled();
  });

  it("小艺任务句柄过期后不允许退化为主动消息", async () => {
    const enqueueProactive = vi.fn();
    const result = await enqueueProactiveChannelDelivery({
      pool: {
        query: vi.fn(),
      } as never,
      repositories: {
        channelDeliveries: { enqueueProactive },
      } as never,
      scope: delivery.scope,
      taskId: "task-xiaoyi-1",
      assistantMessageId: "assistant-xiaoyi-1",
      content: "不应主动发送",
      target: {
        channel: "xiaoyi",
        externalConversationId: "session-alice",
        externalMessageId: "message-xiaoyi-1",
        senderId: "session-alice",
        chatType: "direct",
        text: "",
        occurredAt:
          new Date("2026-07-26T00:00:00.000Z"),
      },
    });

    expect(result).toEqual({ queued: false });
    expect(enqueueProactive).not.toHaveBeenCalled();
  });

  it("清空数据删除已 claim 事件后不会复活旧消息", async () => {
    const execute = vi.fn();
    const release = vi.fn();
    const repositories = {
      userDataMutations: {
        beginRequest: vi.fn(async () => ({
          userId: "user-1",
          epoch: "2",
        })),
        acquireSharedLease: vi.fn(async () => ({
          userId: "user-1",
          epoch: "2",
          mode: "shared" as const,
          release,
        })),
      },
    };
    const leased = createLeasedChannelTurnExecutor(
      repositories as never,
      {
        query: vi.fn(async () => ({
          rowCount: 0,
          rows: [],
        })) as never,
      },
      { execute } as never,
    );
    const claim = {
      id: "event-deleted-by-clear",
      scope: delivery.scope,
      connectionId: "connection-1",
      claimOwner: "event-worker",
    };

    await expect(
      leased.execute(claim as never),
    ).resolves.toMatchObject({
      skipped: true,
      reason: "event_no_longer_current",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
