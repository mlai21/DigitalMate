import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/chat/route";
import { GET as pollMessages } from "@/app/api/messages/route";
import Home from "@/app/page";
import type { DbMessageAttachment } from "@/server/db/repositories";
import { AnthropicClient } from "@/server/llm/anthropic";
import type { AppEnv } from "@/server/config/env";
import type { LlmMessage } from "@/server/llm/types";

type HistoryRow = { id: string; role: "user" | "assistant"; content: string };

const mocks = vi.hoisted(() => {
  const readyDocument = {
    id: "30000000-0000-4000-8000-000000000001",
    userId: "user-1",
    messageId: null,
    kind: "document" as const,
    fileName: "notes.md",
    mimeType: "text/markdown",
    sizeBytes: 12,
    storageKey: "40000000-0000-4000-8000-000000000001",
    extractedText: "附件正文",
    textTruncated: false,
    status: "ready" as const,
    errorCode: null,
    deletionClaimToken: null,
    createdAt: new Date("2026-07-14T00:00:00Z"),
    updatedAt: new Date("2026-07-14T00:00:00Z"),
  };
  const readyImage = {
    ...readyDocument,
    id: "30000000-0000-4000-8000-000000000002",
    kind: "image" as const,
    fileName: "cat.png",
    mimeType: "image/png",
    storageKey: "40000000-0000-4000-8000-000000000002",
    extractedText: null,
  };
  const extractAndSaveFromMessage = vi.fn(async () => undefined);
  const messagesCreate = vi.fn(async (input: { role: string; content: string }) => ({
    id: input.role === "user" ? "message-user" : "message-assistant",
    userId: "user-1",
    conversationId: "conversation-1",
    role: input.role,
    content: input.content,
    createdAt: new Date("2026-07-05T10:00:00+08:00"),
  }));

  const messagesCreateWithAttachments = vi.fn(async (input: { content: string; attachmentIds: string[] }) => ({
    message: {
      id: "message-user",
      userId: "user-1",
      conversationId: "conversation-1",
      role: "user" as const,
      content: input.content,
      createdAt: new Date("2026-07-05T10:00:00+08:00"),
    },
    attachments: input.attachmentIds.map((id) => ({
      ...(id === readyImage.id ? readyImage : readyDocument),
      id,
      messageId: "message-user",
      status: "bound" as const,
    })),
  }));
  const getAttachmentForUser = vi.fn<
    (userId: string, attachmentId: string) => Promise<DbMessageAttachment | null>
  >(async (_userId, attachmentId) =>
    attachmentId === readyImage.id ? readyImage : attachmentId === readyDocument.id ? readyDocument : null,
  );
  const listAttachmentsForMessages = vi.fn<() => Promise<DbMessageAttachment[]>>(async () => []);
  const recentHistory = vi.fn<() => Promise<HistoryRow[]>>(async () => []);
  const listMessages = vi.fn(async () => [] as HistoryRow[]);
  const listMessagesAfter = vi.fn(async () => [] as HistoryRow[]);
  const readAttachment = vi.fn(async () => Buffer.from("private-image"));

  return {
    readyDocument,
    readyImage,
    extractAndSaveFromMessage,
    messagesCreate,
    messagesCreateWithAttachments,
    getAttachmentForUser,
    listAttachmentsForMessages,
    recentHistory,
    listMessages,
    listMessagesAfter,
    readAttachment,
    createRepositories: vi.fn<() => Record<string, unknown>>(() => ({
      conversations: {
        getOrCreateDefault: vi.fn(async () => ({ id: "conversation-1" })),
        getForUser: vi.fn(async (): Promise<{ id: string } | null> => ({ id: "conversation-1" })),
      },
      messages: {
        create: messagesCreate,
        createWithAttachments: messagesCreateWithAttachments,
        recentHistory,
        list: listMessages,
        listAfter: listMessagesAfter,
      },
      messageAttachments: {
        getForUser: getAttachmentForUser,
        listForMessages: listAttachmentsForMessages,
      },
      memories: {
        extractAndSaveFromMessage,
      },
      proactiveTasks: {
        create: vi.fn(async () => undefined),
      },
      settings: {
        get: vi.fn(async () => ({
          persona: { name: "DigitalMate", style: "温暖、克制" },
          proactivity: { quietStart: "23:00", quietEnd: "08:00", maxPerDay: 3 },
          modelRouting: { main: "mock-main", light: "mock-light" },
          cadence: {},
        })),
      },
    })),
    requireCurrentUser: vi.fn(async () => ({ id: "user-1", displayName: "Tang" })),
    getCurrentUser: vi.fn(async () => ({ id: "user-1", displayName: "Tang" })),
    recordEventReflection: vi.fn(async () => undefined),
    getLlmClient: vi.fn(() => ({
      client: {
        stream: async function* () {
          yield { type: "text", text: "收到。" };
        },
        completeText: vi.fn(async () => "收到。"),
      },
      model: "mock-main",
    })),
    runAgent: vi.fn(async function* () {
      yield "收到。";
    }),
  };
});

vi.mock("@/server/auth/current-user", () => ({
  requireCurrentUser: mocks.requireCurrentUser,
  getCurrentUser: mocks.getCurrentUser,
}));

vi.mock("@/server/db/repositories", () => ({
  createRepositories: mocks.createRepositories,
}));

vi.mock("@/server/evolution/event-reflection", () => ({
  recordEventReflection: mocks.recordEventReflection,
}));

vi.mock("@/server/llm/router", () => ({
  getLlmClient: mocks.getLlmClient,
}));

vi.mock("@/server/config/env", () => ({
  readEnv: vi.fn(() => ({ attachmentStorageDir: "/private/attachments" })),
}));

vi.mock("@/server/attachments/storage", () => ({
  readAttachment: mocks.readAttachment,
}));

vi.mock("@/server/agent/run-agent", () => ({
  runAgent: mocks.runAgent,
}));

vi.mock("@/server/agent/tools/web-search", () => ({
  searchWeb: vi.fn(async () => []),
  summarizeSearchResults: vi.fn(() => ""),
}));

describe("chat route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAttachmentsForMessages.mockReset().mockResolvedValue([]);
    mocks.listMessages.mockReset().mockResolvedValue([]);
    mocks.listMessagesAfter.mockReset().mockResolvedValue([]);
    mocks.getLlmClient.mockReturnValue({
      client: {
        stream: async function* () {
          yield { type: "text", text: "收到。" };
        },
        completeText: vi.fn(async () => "收到。"),
      },
      model: "gemini-3-5-flash-openai",
    });
  });

  it("returns safe attachment card data from message polling with one batch query", async () => {
    const message = {
      id: "20000000-0000-4000-8000-000000000010",
      userId: "user-1",
      conversationId: "conversation-1",
      role: "user" as const,
      content: "看看附件",
      createdAt: new Date("2026-07-14T00:01:00Z"),
    };
    mocks.listMessagesAfter.mockResolvedValueOnce([message]);
    mocks.listAttachmentsForMessages.mockResolvedValueOnce([
      {
        ...mocks.readyDocument,
        messageId: message.id,
        status: "bound",
        storageKey: "private-storage-key",
        extractedText: "private extracted text",
        errorCode: "private_error",
        deletionClaimToken: "private-deletion-token",
      },
      {
        ...mocks.readyDocument,
        id: "30000000-0000-4000-8000-000000000091",
        userId: "other-user",
        messageId: message.id,
        status: "bound",
      },
      {
        ...mocks.readyDocument,
        id: "30000000-0000-4000-8000-000000000092",
        messageId: message.id,
        status: "ready",
      },
      {
        ...mocks.readyDocument,
        id: "30000000-0000-4000-8000-000000000093",
        messageId: "20000000-0000-4000-8000-000000000099",
        status: "bound",
      },
    ]);

    const response = await pollMessages(new Request(
      "http://localhost/api/messages?conversationId=conversation-1&after=2026-07-14T00%3A00%3A00.000Z",
    ));
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body.messages).toEqual([expect.objectContaining({
      id: message.id,
      attachments: [{
        id: mocks.readyDocument.id,
        kind: "document",
        fileName: "notes.md",
        mimeType: "text/markdown",
        sizeBytes: 12,
        status: "bound",
        downloadUrl: `/api/chat/attachments/${mocks.readyDocument.id}/download`,
      }],
    })]);
    expect(mocks.listAttachmentsForMessages).toHaveBeenCalledTimes(1);
    expect(mocks.listAttachmentsForMessages).toHaveBeenCalledWith("user-1", [message.id]);
    expect(serialized).not.toContain("000000000091");
    expect(serialized).not.toContain("000000000092");
    expect(serialized).not.toContain("000000000093");
    for (const secret of [
      "storageKey",
      "private-storage-key",
      "extractedText",
      "private extracted text",
      "textTruncated",
      "errorCode",
      "deletionClaimToken",
      "private-deletion-token",
    ]) expect(serialized).not.toContain(secret);
  });

  it("does not query attachments when message polling returns no messages", async () => {
    const response = await pollMessages(new Request(
      "http://localhost/api/messages?conversationId=conversation-1&after=2026-07-14T00%3A00%3A00.000Z",
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ messages: [] });
    expect(mocks.listAttachmentsForMessages).not.toHaveBeenCalled();
  });

  it("returns safe attachment card data in the initial chat page", async () => {
    const message = {
      id: "20000000-0000-4000-8000-000000000011",
      userId: "user-1",
      conversationId: "conversation-1",
      role: "user" as const,
      content: "首屏附件",
      createdAt: new Date("2026-07-14T00:02:00Z"),
    };
    const conversation = {
      id: "conversation-1",
      userId: "user-1",
      channel: "web",
      title: "附件会话",
      projectId: null,
      pinned: false,
      updatedAt: new Date("2026-07-14T00:02:00Z"),
      messageCount: 1,
      lastMessageAt: new Date("2026-07-14T00:02:00Z"),
    };
    mocks.createRepositories.mockReturnValueOnce({
      conversations: {
        listWithStats: vi.fn(async () => [conversation]),
        getOrCreateDefault: vi.fn(async () => conversation),
      },
      projects: { list: vi.fn(async () => []) },
      messages: { list: vi.fn(async () => [message]) },
      messageAttachments: {
        listForMessages: mocks.listAttachmentsForMessages.mockResolvedValueOnce([{
          ...mocks.readyDocument,
          messageId: message.id,
          status: "bound",
          storageKey: "private-storage-key",
          extractedText: "private extracted text",
          errorCode: "private_error",
          deletionClaimToken: "private-deletion-token",
        }]),
      },
    });

    const page = await Home();
    const initialMessages = (page.props as { initialMessages: Array<Record<string, unknown>> }).initialMessages;
    const serialized = JSON.stringify(initialMessages);

    expect(initialMessages).toEqual([expect.objectContaining({
      id: message.id,
      attachments: [{
        id: mocks.readyDocument.id,
        kind: "document",
        fileName: "notes.md",
        mimeType: "text/markdown",
        sizeBytes: 12,
        status: "bound",
        downloadUrl: `/api/chat/attachments/${mocks.readyDocument.id}/download`,
      }],
    })]);
    expect(mocks.listAttachmentsForMessages).toHaveBeenCalledTimes(1);
    expect(mocks.listAttachmentsForMessages).toHaveBeenCalledWith("user-1", [message.id]);
    for (const secret of [
      "storageKey",
      "private-storage-key",
      "extractedText",
      "private extracted text",
      "textTruncated",
      "errorCode",
      "deletionClaimToken",
      "private-deletion-token",
    ]) expect(serialized).not.toContain(secret);
  });

  it("allows an attachment-only message and atomically binds it before running the agent", async () => {
    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "", attachmentIds: [mocks.readyImage.id] }),
      }),
    );

    expect(response.status).toBe(200);
    await response.text();
    expect(mocks.messagesCreateWithAttachments).toHaveBeenCalledWith({
      userId: "user-1",
      conversationId: "conversation-1",
      content: "",
      attachmentIds: [mocks.readyImage.id],
    });
    expect(mocks.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "",
        attachments: [expect.objectContaining({ kind: "image", fileName: "cat.png" })],
      }),
    );
    expect(mocks.readAttachment).toHaveBeenCalledWith(
      "/private/attachments",
      mocks.readyImage.storageKey,
    );
  });

  it("rejects a request when both message and attachments are empty", async () => {
    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "   ", attachmentIds: [] }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    expect(mocks.messagesCreate).not.toHaveBeenCalled();
    expect(mocks.messagesCreateWithAttachments).not.toHaveBeenCalled();
  });

  it("rejects unowned attachments before creating or binding a message", async () => {
    mocks.getAttachmentForUser.mockResolvedValueOnce(null);
    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "看看", attachmentIds: [mocks.readyDocument.id] }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "attachment_not_bindable" });
    expect(mocks.messagesCreate).not.toHaveBeenCalled();
    expect(mocks.messagesCreateWithAttachments).not.toHaveBeenCalled();
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it("rejects failed or already-bound attachments before creating a message", async () => {
    mocks.getAttachmentForUser.mockResolvedValueOnce({
      ...mocks.readyDocument,
      status: "failed",
      errorCode: "attachment_parse_failed",
    });
    const failedResponse = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "看看", attachmentIds: [mocks.readyDocument.id] }),
      }),
    );
    expect(failedResponse.status).toBe(400);

    mocks.getAttachmentForUser.mockResolvedValueOnce({
      ...mocks.readyDocument,
      status: "bound",
      messageId: "20000000-0000-4000-8000-000000000099",
    });
    const boundResponse = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "看看", attachmentIds: [mocks.readyDocument.id] }),
      }),
    );
    expect(boundResponse.status).toBe(400);
    expect(mocks.messagesCreate).not.toHaveBeenCalled();
    expect(mocks.messagesCreateWithAttachments).not.toHaveBeenCalled();
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it("does not start the agent or create an assistant message when atomic binding loses a race", async () => {
    mocks.messagesCreateWithAttachments.mockRejectedValueOnce(new Error("attachment_not_bindable"));
    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "看看", attachmentIds: [mocks.readyDocument.id] }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "attachment_not_bindable" });
    expect(mocks.runAgent).not.toHaveBeenCalled();
    expect(mocks.messagesCreate).not.toHaveBeenCalled();
  });

  it("checks image capability before creating or binding the message", async () => {
    mocks.getLlmClient.mockReturnValueOnce({
      client: {
        stream: async function* () {
          yield { type: "text", text: "不应调用" };
        },
        completeText: vi.fn(async () => ""),
      },
      model: "claude-opus-4-8",
    });
    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "看看", attachmentIds: [mocks.readyImage.id] }),
      }),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "image_model_not_supported",
      message: "当前模型暂不支持图片理解，请切换到支持图片的模型后重试。",
    });
    expect(mocks.messagesCreate).not.toHaveBeenCalled();
    expect(mocks.messagesCreateWithAttachments).not.toHaveBeenCalled();
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it("loads recent history before creating the current message and keeps attachments on their original turns", async () => {
    const calls: string[] = [];
    mocks.recentHistory.mockImplementationOnce(async () => {
      calls.push("history");
      return [
        { id: "20000000-0000-4000-8000-000000000001", role: "user" as const, content: "上一轮" },
        { id: "20000000-0000-4000-8000-000000000002", role: "assistant" as const, content: "看过了" },
      ];
    });
    mocks.listAttachmentsForMessages.mockResolvedValueOnce([
      {
        ...mocks.readyDocument,
        messageId: "20000000-0000-4000-8000-000000000001",
        status: "bound",
      },
    ]);
    mocks.messagesCreateWithAttachments.mockImplementationOnce(async (input) => {
      calls.push("create");
      return {
        message: {
          id: "message-user",
          userId: "user-1",
          conversationId: "conversation-1",
          role: "user" as const,
          content: input.content,
          createdAt: new Date(),
        },
        attachments: [{ ...mocks.readyImage, messageId: "message-user", status: "bound" as const }],
      };
    });

    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "继续", attachmentIds: [mocks.readyImage.id] }),
      }),
    );
    await response.text();

    expect(response.status).toBe(200);
    expect(calls).toEqual(["history", "create"]);
    expect(mocks.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        history: [
          expect.objectContaining({
            role: "user",
            content: "上一轮",
            attachments: [expect.objectContaining({ kind: "document", fileName: "notes.md" })],
          }),
          { role: "assistant", content: "看过了" },
        ],
        attachments: [expect.objectContaining({ kind: "image", fileName: "cat.png" })],
      }),
    );
  });

  it("crops over-budget historical attachments newest-first so plain text turns can keep advancing", async () => {
    const historyRows = Array.from({ length: 5 }, (_, index) => ({
      id: `20000000-0000-4000-8000-00000000000${index + 1}`,
      role: "user" as const,
      content: index === 4 ? "   " : "",
    }));
    const historyAttachments: DbMessageAttachment[] = historyRows.map((message, index) => ({
      ...mocks.readyDocument,
      id: `30000000-0000-4000-8000-00000000001${index}`,
      messageId: message.id,
      fileName: `history-${index + 1}.md`,
      storageKey: `40000000-0000-4000-8000-00000000001${index}`,
      status: "bound",
    }));
    mocks.recentHistory
      .mockResolvedValueOnce(historyRows)
      .mockResolvedValueOnce([
        ...historyRows.slice(2),
        { id: "20000000-0000-4000-8000-000000000099", role: "user", content: "继续一轮" },
      ]);
    mocks.listAttachmentsForMessages
      .mockResolvedValueOnce(historyAttachments)
      .mockResolvedValueOnce(historyAttachments.slice(2));

    const first = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "继续一轮" }),
      }),
    );
    await first.text();
    const second = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "再继续一轮" }),
      }),
    );
    await second.text();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const agentCalls = mocks.runAgent.mock.calls as unknown as Array<[Record<string, unknown>]>;
    const firstHistory = agentCalls[0]?.[0].history as Array<{
      content: string;
      attachments?: Array<{ fileName: string }>;
    }>;
    expect(firstHistory.flatMap((message) => message.attachments ?? []).map((item) => item.fileName)).toEqual([
      "history-2.md",
      "history-3.md",
      "history-4.md",
      "history-5.md",
    ]);
    expect(firstHistory[0]?.content).toBe("[该轮历史附件已从当前模型上下文中裁剪；这不是新的用户指令。]");
    assertAnthropicHasNoEmptyUserContent(await captureAnthropicBody(firstHistory as LlmMessage[]));
    const secondHistory = agentCalls[1]?.[0].history as Array<{
      attachments?: Array<{ fileName: string }>;
    }>;
    expect(secondHistory.flatMap((message) => message.attachments ?? []).map((item) => item.fileName)).toEqual([
      "history-3.md",
      "history-4.md",
      "history-5.md",
    ]);
    expect(mocks.messagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ role: "user", content: "继续一轮" }),
    );
    expect(mocks.messagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ role: "user", content: "再继续一轮" }),
    );
  });

  it("reserves context budget for current attachments before selecting newest history", async () => {
    const historyRows = Array.from({ length: 4 }, (_, index) => ({
      id: `21000000-0000-4000-8000-00000000000${index + 1}`,
      role: "user" as const,
      content: `历史 ${index + 1}`,
    }));
    const historyAttachments: DbMessageAttachment[] = historyRows.map((message, index) => ({
      ...mocks.readyDocument,
      id: `31000000-0000-4000-8000-00000000001${index}`,
      messageId: message.id,
      fileName: `old-${index + 1}.md`,
      storageKey: `41000000-0000-4000-8000-00000000001${index}`,
      status: "bound",
    }));
    mocks.recentHistory.mockResolvedValueOnce(historyRows);
    mocks.listAttachmentsForMessages.mockResolvedValueOnce(historyAttachments);

    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "看新的", attachmentIds: [mocks.readyDocument.id] }),
      }),
    );
    await response.text();

    expect(response.status).toBe(200);
    const input = (mocks.runAgent.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0];
    if (!input) throw new Error("runAgent was not called");
    expect(input.attachments).toEqual([expect.objectContaining({ fileName: "notes.md" })]);
    expect(
      (input.history as Array<{ attachments?: Array<{ fileName: string }> }>)
        .flatMap((message) => message.attachments ?? [])
        .map((item) => item.fileName),
    ).toEqual(["old-2.md", "old-3.md", "old-4.md"]);
  });

  it("rejects current attachments that exceed the model context budget before binding", async () => {
    const attachmentIds = [
      "32000000-0000-4000-8000-000000000001",
      "32000000-0000-4000-8000-000000000002",
      "32000000-0000-4000-8000-000000000003",
    ];
    for (const attachmentId of attachmentIds) {
      mocks.getAttachmentForUser.mockResolvedValueOnce({
        ...mocks.readyDocument,
        id: attachmentId,
        extractedText: "a".repeat(100_000),
      });
    }

    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "分析这些文件", attachmentIds }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "attachment_context_text_exceeded" });
    expect(mocks.messagesCreateWithAttachments).not.toHaveBeenCalled();
    expect(mocks.messagesCreate).not.toHaveBeenCalled();
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it("skips historical images on a text-only model instead of locking later text turns", async () => {
    mocks.getLlmClient.mockReturnValueOnce({
      client: {
        stream: async function* () {
          yield { type: "text", text: "收到。" };
        },
        completeText: vi.fn(async () => "收到。"),
      },
      model: "claude-opus-4-8",
    });
    const historyMessageId = "22000000-0000-4000-8000-000000000001";
    mocks.recentHistory.mockResolvedValueOnce([
      { id: historyMessageId, role: "user", content: "" },
    ]);
    mocks.listAttachmentsForMessages.mockResolvedValueOnce([{
      ...mocks.readyImage,
      messageId: historyMessageId,
      status: "bound",
    }]);

    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "继续纯文本聊天" }),
      }),
    );
    await response.text();

    expect(response.status).toBe(200);
    const input = (mocks.runAgent.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0];
    expect(input?.history).toEqual([{
      role: "user",
      content: "[该轮历史附件已从当前模型上下文中裁剪；这不是新的用户指令。]",
    }]);
    assertAnthropicHasNoEmptyUserContent(await captureAnthropicBody(input?.history as LlmMessage[]));
    expect(mocks.readAttachment).not.toHaveBeenCalled();
    expect(mocks.messagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ role: "user", content: "继续纯文本聊天" }),
    );
  });

  it("uses the safe placeholder when an empty historical document cannot be reconstructed", async () => {
    const historyMessageId = "23000000-0000-4000-8000-000000000001";
    mocks.recentHistory.mockResolvedValueOnce([{ id: historyMessageId, role: "user", content: "" }]);
    mocks.listAttachmentsForMessages.mockResolvedValueOnce([{
      ...mocks.readyDocument,
      messageId: historyMessageId,
      extractedText: null,
      status: "bound",
    }]);

    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "继续" }),
      }),
    );
    await response.text();

    expect(response.status).toBe(200);
    const input = (mocks.runAgent.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0];
    expect(input?.history).toEqual([{
      role: "user",
      content: "[该轮历史附件已从当前模型上下文中裁剪；这不是新的用户指令。]",
    }]);
    assertAnthropicHasNoEmptyUserContent(await captureAnthropicBody(input?.history as LlmMessage[]));
  });

  it("never exposes an upstream error payload through SSE", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.runAgent.mockImplementationOnce(async function* () {
      throw new Error("secret-token=abc /private/attachments/hidden");
    });

    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "你好" }),
      }),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('"type":"error"');
    expect(body).toContain('"code":"agent_response_failed"');
    expect(body).toContain("回复生成失败，请稍后重试");
    expect(body).not.toContain("secret-token");
    expect(body).not.toContain("/private/attachments");
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("secret-token");
    consoleError.mockRestore();
  });

  it("leaves memory extraction to the async agent service", async () => {
    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "我喜欢咖啡" }),
      }),
    );

    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('"type":"done"');
    expect(mocks.messagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ role: "user", content: "我喜欢咖啡" }),
    );
    expect(mocks.messagesCreate).toHaveBeenCalledWith(expect.objectContaining({ role: "assistant", content: "收到。" }));
    expect(mocks.extractAndSaveFromMessage).not.toHaveBeenCalled();
  });

  it("preserves per-message search authorization without letting attachments rewrite it", async () => {
    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "看看今天的新消息",
          attachmentIds: [mocks.readyDocument.id],
          searchEnabled: true,
        }),
      }),
    );

    await response.text();

    expect(response.status).toBe(200);
    expect(mocks.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "看看今天的新消息",
        attachments: [expect.objectContaining({ kind: "document", fileName: "notes.md" })],
        webSearchEnabled: true,
        searchGate: expect.objectContaining({ evaluate: expect.any(Function) }),
      }),
    );
  });


  it("rejects conversation ids that do not belong to the current user", async () => {
    const messagesCreate = vi.fn();
    mocks.createRepositories.mockReturnValueOnce({
      conversations: {
        getOrCreateDefault: vi.fn(async () => ({ id: "conversation-1" })),
        getForUser: vi.fn(async () => null),
      },
      messages: {
        create: messagesCreate,
        recentHistory: vi.fn(async () => []),
      },
      memories: {
        extractAndSaveFromMessage: mocks.extractAndSaveFromMessage,
      },
      proactiveTasks: {
        create: vi.fn(async () => undefined),
      },
      settings: {
        get: vi.fn(async () => ({
          persona: { name: "DigitalMate", style: "温暖、克制" },
          proactivity: { quietStart: "23:00", quietEnd: "08:00", maxPerDay: 3 },
          modelRouting: { main: "mock-main", light: "mock-light" },
          cadence: {},
        })),
      },
    });

    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "继续聊",
          conversationId: "00000000-0000-4000-8000-000000000999",
        }),
      }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "conversation_not_found" });
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it("stores urgent reminder metadata for delivery policy", async () => {
    const createTask = vi.fn(async () => undefined);
    mocks.createRepositories.mockReturnValueOnce({
      conversations: {
        getOrCreateDefault: vi.fn(async () => ({ id: "conversation-1" })),
        getForUser: vi.fn(async () => ({ id: "conversation-1" })),
      },
      messages: {
        create: mocks.messagesCreate,
        recentHistory: vi.fn(async () => []),
      },
      memories: {
        extractAndSaveFromMessage: mocks.extractAndSaveFromMessage,
      },
      proactiveTasks: {
        create: createTask,
      },
      settings: {
        get: vi.fn(async () => ({
          persona: { name: "DigitalMate", style: "温暖、克制" },
          proactivity: { quietStart: "23:00", quietEnd: "08:00", maxPerDay: 3 },
          modelRouting: { main: "mock-main", light: "mock-light" },
          cadence: {},
        })),
      },
    });

    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "10 分钟后紧急提醒我吃药" }),
      }),
    );

    await response.text();

    expect(response.status).toBe(200);
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "reminder",
        content: "吃药",
        metadata: { urgent: true },
      }),
    );
  });
});

async function captureAnthropicBody(history: LlmMessage[]) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"好"}}\n', {
      headers: { "content-type": "text/event-stream" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const client = new AnthropicClient({
    kieAiBaseUrl: "https://api.kie.ai",
    claudeEndpoint: "/claude/v1/messages",
    kieAiApiKey: "test-key",
    anthropicVersion: "2023-06-01",
  } as AppEnv);
  try {
    for await (const event of client.stream({
      model: "claude-opus-4-8",
      messages: [{ role: "system", content: "系统规则" }, ...history, { role: "user", content: "继续" }],
    })) void event;
    return JSON.parse(fetchMock.mock.calls[0][1].body) as {
      messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
    };
  } finally {
    vi.unstubAllGlobals();
  }
}

function assertAnthropicHasNoEmptyUserContent(body: {
  messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
}) {
  for (const message of body.messages.filter((item) => item.role === "user")) {
    if (typeof message.content === "string") {
      expect(message.content.trim()).not.toBe("");
      continue;
    }
    for (const block of message.content) {
      if (block.type === "text") expect(block.text?.trim()).not.toBe("");
    }
  }
}
