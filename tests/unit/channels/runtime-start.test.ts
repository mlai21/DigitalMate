import { describe, expect, it, vi } from "vitest";

import {
  createChannelDeliveryTransport,
  createLeasedChannelTurnExecutor,
  enqueueProactiveChannelDelivery,
} from "@/server/channels/runtime/start";
import {
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
