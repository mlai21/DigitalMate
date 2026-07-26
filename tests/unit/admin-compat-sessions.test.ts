import { describe, expect, it, vi } from "vitest";
import {
  createPostgresAdminSessionsService,
  projectAdminSessionDetail,
  projectAdminSessionPage,
} from "@/server/admin/views/sessions";
import {
  createDeleteSessionHandler,
  type AdminSessionsService,
} from "@/server/admin/compat/handlers/sessions";
import type { AdminCompatContext } from "@/server/admin/compat/types";

const scope = {
  userId: "10000000-0000-4000-8000-000000000001",
  agentId: "10000000-0000-4000-8000-000000000011",
};

describe("admin compatibility sessions", () => {
  it("详情区分可见消息和内部留痕且不返回原始载荷", () => {
    const detail = projectAdminSessionDetail(scope, {
      conversation: {
        id: "10000000-0000-4000-8000-000000000201",
        agentId: scope.agentId,
        channel: "telegram",
        title: "一次真实会话",
        pinned: false,
        archivedAt: null,
        createdAt: new Date("2026-07-27T01:00:00Z"),
        updatedAt: new Date("2026-07-27T01:10:00Z"),
      },
      messages: [
        {
          id: "m1",
          role: "user",
          content: "你好",
          visibleToUser: true,
          createdAt: new Date("2026-07-27T01:00:00Z"),
        },
        {
          id: "m2",
          role: "system",
          content: "系统提示：secret",
          visibleToUser: false,
          createdAt: new Date("2026-07-27T01:00:01Z"),
        },
        {
          id: "m3",
          role: "assistant",
          content: "你好呀",
          visibleToUser: true,
          createdAt: new Date("2026-07-27T01:00:02Z"),
        },
      ],
      toolLogs: [
        {
          id: "t1",
          toolName: "calendar",
          status: "success",
          durationMs: 20,
          errorCode: null,
          createdAt: new Date("2026-07-27T01:00:03Z"),
        },
      ],
      executionSteps: [
        {
          id: "s1",
          kind: "tool",
          status: "completed",
          errorCode: null,
          startedAt: new Date("2026-07-27T01:00:04Z"),
          completedAt: new Date("2026-07-27T01:00:05Z"),
        },
      ],
    });

    expect(detail.messages.map((message) => message.content)).toEqual([
      "你好",
      "你好呀",
    ]);
    expect(detail.internal_steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "tool",
          visible_to_user: false,
        }),
      ]),
    );
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain("系统提示");
    expect(serialized).not.toContain("input_summary");
    expect(serialized).not.toContain("output_summary");
    expect(serialized).not.toContain("output");
    expect(serialized).not.toContain("raw_payload");
  });

  it("列表按 updated_at,id 稳定分页并限制当前 agent", () => {
    const rows = [
      {
        id: "10000000-0000-4000-8000-000000000211",
        agentId: scope.agentId,
        channel: "web",
        title: "A",
        pinned: false,
        archivedAt: null,
        messageCount: 2,
        lastMessageAt: new Date("2026-07-27T03:00:00Z"),
        createdAt: new Date("2026-07-27T01:00:00Z"),
        updatedAt: new Date("2026-07-27T03:00:00Z"),
      },
      {
        id: "10000000-0000-4000-8000-000000000212",
        agentId: "10000000-0000-4000-8000-000000000012",
        channel: "web",
        title: "other agent",
        pinned: false,
        archivedAt: null,
        messageCount: 1,
        lastMessageAt: null,
        createdAt: new Date("2026-07-27T01:00:00Z"),
        updatedAt: new Date("2026-07-27T02:30:00Z"),
      },
      {
        id: "10000000-0000-4000-8000-000000000213",
        agentId: scope.agentId,
        channel: "telegram",
        title: "B",
        pinned: false,
        archivedAt: null,
        messageCount: 4,
        lastMessageAt: new Date("2026-07-27T02:00:00Z"),
        createdAt: new Date("2026-07-27T01:00:00Z"),
        updatedAt: new Date("2026-07-27T02:00:00Z"),
      },
    ];
    const first = projectAdminSessionPage(scope, rows, {
      cursor: null,
      limit: 1,
    });
    const second = projectAdminSessionPage(scope, rows, {
      cursor: first.next_cursor,
      limit: 1,
    });

    expect(first.items.map((item) => item.id)).toEqual([
      "10000000-0000-4000-8000-000000000211",
    ]);
    expect(second.items.map((item) => item.id)).toEqual([
      "10000000-0000-4000-8000-000000000213",
    ]);
  });

  it("删除会话始终携带当前 scope 并返回稳定 not found", async () => {
    const deleteSession = vi
      .fn<AdminSessionsService["deleteSession"]>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const handler = createDeleteSessionHandler({
      deleteSession,
    } as unknown as AdminSessionsService);
    const context = {
      request: new Request(
        "https://mate.example/api/admin/compat/chats/10000000-0000-4000-8000-000000000221",
        { method: "DELETE" },
      ),
      params: {
        chatId: "10000000-0000-4000-8000-000000000221",
      },
      scope,
      csrfVerified: true,
      resources: {},
      signal: new AbortController().signal,
    } as unknown as AdminCompatContext;

    await expect(handler(context)).resolves.toEqual({
      success: true,
      chat_id: context.params.chatId,
    });
    expect(deleteSession).toHaveBeenCalledWith(
      scope,
      context.params.chatId,
      context.signal,
    );
    await expect(handler(context)).rejects.toMatchObject({
      status: 404,
      code: "not_found",
      publicMessage: "session_not_found",
    });
  });

  it("物理附件全部删除成功后才删除会话记录", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          { storage_key: "attachment-a" },
          { storage_key: "attachment-b" },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ exists: 1 }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const removeAttachment = vi.fn().mockResolvedValue(undefined);
    const service = createPostgresAdminSessionsService(
      { query } as never,
      "/private/attachments",
      removeAttachment,
    );
    const deleted = await service.deleteSession(
      scope,
      "10000000-0000-4000-8000-000000000231",
      new AbortController().signal,
    );

    expect(deleted).toBe(true);
    expect(removeAttachment.mock.calls).toEqual([
      ["/private/attachments", "attachment-a"],
      ["/private/attachments", "attachment-b"],
    ]);
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.invocationCallOrder[2]).toBeGreaterThan(
      removeAttachment.mock.invocationCallOrder[1] ?? 0,
    );
  });
});
