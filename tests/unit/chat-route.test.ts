import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/chat/route";
import { GET as pollMessages } from "@/app/api/messages/route";
import Home from "@/app/page";
import type { DbMessageAttachment } from "@/server/db/repositories";
import { AnthropicClient } from "@/server/llm/anthropic";
import type { AppEnv } from "@/server/config/env";
import type { LlmMessage } from "@/server/llm/types";

type HistoryRow = { id: string; role: "user" | "assistant"; content: string };
const DEFAULT_CLIENT_TURN_ID = "60000000-0000-4000-8000-000000000000";

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
  const messagesCreateIdempotentUserTurn = vi.fn(async (input: {
    userId: string;
    conversationId: string;
    content: string;
    attachmentIds: string[];
  }) => {
    if (input.attachmentIds.length > 0) {
      const result = await messagesCreateWithAttachments({
        content: input.content,
        attachmentIds: input.attachmentIds,
      });
      return { ...result, created: true };
    }
    const message = await messagesCreate({ role: "user", content: input.content });
    return { message, attachments: [], created: true };
  });
  const messagesCreateIdempotentAssistantTurn = vi.fn(async (input: {
    userId: string;
    conversationId: string;
    content: string;
  }) => ({
    message: await messagesCreate({ role: "assistant", content: input.content }),
    created: true,
  }));
  const findByClientTurn = vi.fn<(userId: string, clientTurnId: string, role: "user" | "assistant") => Promise<{
    id: string;
    userId: string;
    conversationId: string;
    role: "user" | "assistant";
    content: string;
    createdAt: Date;
  } | null>>(async () => null);
  const acquireClientTurnExecutionLock = vi.fn(async () => vi.fn(async () => undefined));
  const claimClientTurnExecution = vi.fn(async () => true);
  const proactiveTaskCreate = vi.fn(async () => undefined);
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
    messagesCreateIdempotentUserTurn,
    messagesCreateIdempotentAssistantTurn,
    findByClientTurn,
    acquireClientTurnExecutionLock,
    claimClientTurnExecution,
    proactiveTaskCreate,
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
        createIdempotentUserTurn: messagesCreateIdempotentUserTurn,
        createIdempotentAssistantTurn: messagesCreateIdempotentAssistantTurn,
        findByClientTurn,
        acquireClientTurnExecutionLock,
        claimClientTurnExecution,
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
        create: proactiveTaskCreate,
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
    mocks.runAgent.mockReset().mockImplementation(async function* () {
      yield "收到。";
    });
    mocks.getAttachmentForUser.mockReset().mockImplementation(async (_userId, attachmentId) =>
      attachmentId === mocks.readyImage.id
        ? mocks.readyImage
        : attachmentId === mocks.readyDocument.id
          ? mocks.readyDocument
          : null,
    );
    mocks.listAttachmentsForMessages.mockReset().mockResolvedValue([]);
    mocks.listMessages.mockReset().mockResolvedValue([]);
    mocks.listMessagesAfter.mockReset().mockResolvedValue([]);
    mocks.messagesCreateIdempotentUserTurn.mockReset().mockImplementation(async (input) => {
      if (input.attachmentIds.length > 0) {
        const result = await mocks.messagesCreateWithAttachments({
          content: input.content,
          attachmentIds: input.attachmentIds,
        });
        return { ...result, created: true };
      }
      const message = await mocks.messagesCreate({ role: "user", content: input.content });
      return { message, attachments: [], created: true };
    });
    mocks.messagesCreateIdempotentAssistantTurn.mockReset().mockImplementation(async (input) => ({
      message: await mocks.messagesCreate({ role: "assistant", content: input.content }),
      created: true,
    }));
    mocks.findByClientTurn.mockReset().mockResolvedValue(null);
    mocks.acquireClientTurnExecutionLock.mockReset().mockImplementation(async () => vi.fn(async () => undefined));
    mocks.claimClientTurnExecution.mockReset().mockResolvedValue(true);
    mocks.proactiveTaskCreate.mockReset().mockResolvedValue(undefined);
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
      internalSecret: "message-private-secret",
    };
    const internalMessage = {
      ...message,
      id: "20000000-0000-4000-8000-000000000098",
      role: "system",
      content: "internal system message",
    };
    mocks.listMessagesAfter.mockResolvedValueOnce([message, internalMessage] as never);
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
    expect(body.messages).toEqual([{
      id: message.id,
      role: "user",
      content: "看看附件",
      createdAt: "2026-07-14T00:01:00.000Z",
      attachments: [{
        id: mocks.readyDocument.id,
        kind: "document",
        fileName: "notes.md",
        mimeType: "text/markdown",
        sizeBytes: 12,
        status: "bound",
        downloadUrl: `/api/chat/attachments/${mocks.readyDocument.id}/download`,
      }],
    }]);
    expect(Object.keys(body.messages[0]).sort()).toEqual([
      "attachments",
      "content",
      "createdAt",
      "id",
      "role",
    ]);
    expect(mocks.listAttachmentsForMessages).toHaveBeenCalledTimes(1);
    expect(mocks.listAttachmentsForMessages).toHaveBeenCalledWith("user-1", [message.id]);
    expect(serialized).not.toContain("userId");
    expect(serialized).not.toContain("conversationId");
    expect(serialized).not.toContain("internalSecret");
    expect(serialized).not.toContain("message-private-secret");
    expect(serialized).not.toContain(internalMessage.id);
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

  it("returns a stable error when polling attachment loading fails", async () => {
    mocks.listMessagesAfter.mockResolvedValueOnce([{
      id: "20000000-0000-4000-8000-000000000097",
      role: "user",
      content: "附件",
      createdAt: new Date("2026-07-14T00:03:00Z"),
    }] as never);
    mocks.listAttachmentsForMessages.mockRejectedValueOnce(
      new Error("secret-token=abc /private/attachments/hidden"),
    );

    const response = await pollMessages(new Request(
      "http://localhost/api/messages?conversationId=conversation-1&after=2026-07-14T00%3A00%3A00.000Z",
    ));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "messages_load_failed" });
    expect(JSON.stringify(body)).not.toContain("secret-token");
    expect(JSON.stringify(body)).not.toContain("/private/attachments");
  });

  it("returns safe attachment card data in the initial chat page", async () => {
    const message = {
      id: "20000000-0000-4000-8000-000000000011",
      userId: "user-1",
      conversationId: "conversation-1",
      role: "user" as const,
      content: "首屏附件",
      createdAt: new Date("2026-07-14T00:02:00Z"),
      internalSecret: "message-private-secret",
    };
    const internalMessage = {
      ...message,
      id: "20000000-0000-4000-8000-000000000096",
      role: "tool",
      content: "internal tool message",
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
      messages: { list: vi.fn(async () => [message, internalMessage] as never) },
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

    expect(initialMessages).toEqual([{
      id: message.id,
      role: "user",
      content: "首屏附件",
      createdAt: "2026-07-14T00:02:00.000Z",
      attachments: [{
        id: mocks.readyDocument.id,
        kind: "document",
        fileName: "notes.md",
        mimeType: "text/markdown",
        sizeBytes: 12,
        status: "bound",
        downloadUrl: `/api/chat/attachments/${mocks.readyDocument.id}/download`,
      }],
    }]);
    expect(Object.keys(initialMessages[0] ?? {}).sort()).toEqual([
      "attachments",
      "content",
      "createdAt",
      "id",
      "role",
    ]);
    expect(mocks.listAttachmentsForMessages).toHaveBeenCalledTimes(1);
    expect(mocks.listAttachmentsForMessages).toHaveBeenCalledWith("user-1", [message.id]);
    expect(serialized).not.toContain("userId");
    expect(serialized).not.toContain("conversationId");
    expect(serialized).not.toContain("internalSecret");
    expect(serialized).not.toContain("message-private-secret");
    expect(serialized).not.toContain(internalMessage.id);
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

  it("does not initialize repositories or query attachments for a signed-out chat page", async () => {
    mocks.getCurrentUser.mockResolvedValueOnce(null as never);

    const page = await Home();
    const props = page.props as { loginRequired?: boolean; initialMessages: unknown[] };

    expect(props.loginRequired).toBe(true);
    expect(props.initialMessages).toEqual([]);
    expect(mocks.createRepositories).not.toHaveBeenCalled();
    expect(mocks.listAttachmentsForMessages).not.toHaveBeenCalled();
  });

  it("uses a safe chat-history notice when initial attachment loading fails", async () => {
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
      messages: {
        list: vi.fn(async () => [{
          id: "20000000-0000-4000-8000-000000000095",
          role: "user",
          content: "附件",
          createdAt: new Date("2026-07-14T00:02:00Z"),
        }]),
      },
      messageAttachments: {
        listForMessages: vi.fn(async () => {
          throw new Error("secret-token=abc /private/attachments/hidden");
        }),
      },
    });

    const page = await Home();
    const props = page.props as { setupNotice?: string; initialMessages: unknown[] };

    expect(props.initialMessages).toEqual([]);
    expect(props.setupNotice).toBe("聊天记录暂时加载失败，请稍后刷新。");
    expect(JSON.stringify(props)).not.toContain("secret-token");
    expect(JSON.stringify(props)).not.toContain("/private/attachments");
  });

  it("allows an attachment-only message and atomically binds it before running the agent", async () => {
    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(withClientTurn({ message: "", attachmentIds: [mocks.readyImage.id] })),
      }),
    );

    expect(response.status).toBe(200);
    const events = parseSseEvents(await response.text());
    expect(events[0]).toEqual({
      type: "accepted",
      conversationId: "conversation-1",
      userMessageId: "message-user",
      clientTurnId: DEFAULT_CLIENT_TURN_ID,
    });
    expect(events.at(-1)).toEqual({
      type: "done",
      conversationId: "conversation-1",
      assistantMessageId: "message-assistant",
      clientTurnId: DEFAULT_CLIENT_TURN_ID,
      userMessageId: "message-user",
    });
    expect(mocks.messagesCreateIdempotentUserTurn).toHaveBeenCalledWith({
      userId: "user-1",
      conversationId: "conversation-1",
      clientTurnId: DEFAULT_CLIENT_TURN_ID,
      payloadHash: expect.any(String),
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
        body: JSON.stringify(withClientTurn({ message: "   ", attachmentIds: [] })),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    expect(mocks.messagesCreate).not.toHaveBeenCalled();
    expect(mocks.messagesCreateWithAttachments).not.toHaveBeenCalled();
  });

  it("requires a client turn id for every chat request", async () => {
    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "缺少 turn id" }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    expect(mocks.messagesCreateIdempotentUserTurn).not.toHaveBeenCalled();
  });

  it("replays an existing assistant without running the agent again", async () => {
    mocks.messagesCreateIdempotentUserTurn.mockResolvedValueOnce({
      message: persistedMessage("user", "同一个 turn"),
      attachments: [],
      created: false,
    });
    mocks.findByClientTurn
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(persistedMessage("assistant", "已经保存的完整回复"));

    const response = await POST(new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(withClientTurn({ message: "同一个 turn" })),
    }));
    const events = parseSseEvents(await response.text());

    expect(events).toEqual([
      {
        type: "accepted",
        conversationId: "conversation-1",
        userMessageId: "message-user",
        clientTurnId: DEFAULT_CLIENT_TURN_ID,
      },
      { type: "chunk", content: "已经保存的完整回复" },
      {
        type: "done",
        conversationId: "conversation-1",
        userMessageId: "message-user",
        assistantMessageId: "message-assistant",
        clientTurnId: DEFAULT_CLIENT_TURN_ID,
      },
    ]);
    expect(mocks.runAgent).not.toHaveBeenCalled();
    expect(mocks.messagesCreateIdempotentAssistantTurn).not.toHaveBeenCalled();
    expect(mocks.proactiveTaskCreate).not.toHaveBeenCalled();
  });

  it("handles an accepted-event retry as two HTTP responses but one agent execution and one persisted turn", async () => {
    let storedUser: ReturnType<typeof persistedMessage> | null = null;
    let storedAssistant: ReturnType<typeof persistedMessage> | null = null;
    mocks.findByClientTurn.mockImplementation(async (_userId, _clientTurnId, role) =>
      role === "user" ? storedUser : storedAssistant,
    );
    mocks.messagesCreateIdempotentUserTurn.mockImplementation(async (input) => {
      if (storedUser) return { message: storedUser, attachments: [], created: false };
      storedUser = persistedMessage("user", input.content);
      return { message: storedUser, attachments: [], created: true };
    });
    mocks.messagesCreateIdempotentAssistantTurn.mockImplementation(async (input) => {
      if (storedAssistant) return { message: storedAssistant, created: false };
      storedAssistant = persistedMessage("assistant", input.content);
      return { message: storedAssistant, created: true };
    });

    const requestBody = JSON.stringify(withClientTurn({ message: "accepted 事件可能丢失" }));
    const first = await POST(new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
    }));
    const firstEvents = parseSseEvents(await first.text());
    const retry = await POST(new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
    }));
    const retryEvents = parseSseEvents(await retry.text());

    expect(firstEvents[0]).toMatchObject({ type: "accepted", clientTurnId: DEFAULT_CLIENT_TURN_ID });
    expect(retryEvents).toEqual([
      {
        type: "accepted",
        conversationId: "conversation-1",
        userMessageId: "message-user",
        clientTurnId: DEFAULT_CLIENT_TURN_ID,
      },
      { type: "chunk", content: "收到。" },
      {
        type: "done",
        conversationId: "conversation-1",
        userMessageId: "message-user",
        assistantMessageId: "message-assistant",
        clientTurnId: DEFAULT_CLIENT_TURN_ID,
      },
    ]);
    expect(mocks.runAgent).toHaveBeenCalledTimes(1);
    expect(mocks.claimClientTurnExecution).toHaveBeenCalledTimes(1);
    expect(mocks.messagesCreateIdempotentUserTurn).toHaveBeenCalledTimes(2);
    expect(mocks.messagesCreateIdempotentAssistantTurn).toHaveBeenCalledTimes(1);
  });

  it("serializes overlapping copies of one turn so the agent and tools execute once", async () => {
    let storedUser: ReturnType<typeof persistedMessage> | null = null;
    let storedAssistant: ReturnType<typeof persistedMessage> | null = null;
    let lockHeld = false;
    const lockWaiters: Array<() => void> = [];
    mocks.acquireClientTurnExecutionLock.mockImplementation(async () => {
      if (lockHeld) await new Promise<void>((resolve) => lockWaiters.push(resolve));
      lockHeld = true;
      return vi.fn(async () => {
        lockHeld = false;
        lockWaiters.shift()?.();
      });
    });
    mocks.findByClientTurn.mockImplementation(async (_userId, _clientTurnId, role) =>
      role === "user" ? storedUser : storedAssistant,
    );
    mocks.messagesCreateIdempotentUserTurn.mockImplementation(async (input) => {
      if (storedUser) return { message: storedUser, attachments: [], created: false };
      storedUser = persistedMessage("user", input.content);
      return { message: storedUser, attachments: [], created: true };
    });
    mocks.messagesCreateIdempotentAssistantTurn.mockImplementation(async (input) => {
      if (storedAssistant) return { message: storedAssistant, created: false };
      storedAssistant = persistedMessage("assistant", input.content);
      return { message: storedAssistant, created: true };
    });
    let releaseAgent: (() => void) | undefined;
    const agentGate = new Promise<void>((resolve) => {
      releaseAgent = resolve;
    });
    mocks.runAgent.mockImplementation(async function* () {
      await agentGate;
      yield "唯一执行";
    });

    const requestBody = JSON.stringify(withClientTurn({ message: "重叠重试" }));
    const first = await POST(new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
    }));
    const firstText = first.text();
    await waitForMockCalls(mocks.runAgent, 1);
    const second = await POST(new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
    }));
    const secondText = second.text();
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseAgent?.();
    await Promise.all([firstText, secondText]);

    expect(mocks.acquireClientTurnExecutionLock).toHaveBeenCalledTimes(2);
    expect(mocks.claimClientTurnExecution).toHaveBeenCalledTimes(1);
    expect(mocks.runAgent).toHaveBeenCalledTimes(1);
    expect(mocks.messagesCreateIdempotentAssistantTurn).toHaveBeenCalledTimes(1);
  });

  it("does not rerun the agent after a process restart interrupted an already claimed turn", async () => {
    mocks.messagesCreateIdempotentUserTurn.mockResolvedValueOnce({
      message: persistedMessage("user", "不要重复执行"),
      attachments: [],
      created: false,
    });
    mocks.claimClientTurnExecution.mockResolvedValueOnce(false);

    const response = await POST(new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(withClientTurn({ message: "不要重复执行" })),
    }));
    const events = parseSseEvents(await response.text());

    expect(events[0]).toMatchObject({
      type: "accepted",
      clientTurnId: DEFAULT_CLIENT_TURN_ID,
    });
    expect(events[1]).toEqual({
      type: "chunk",
      content: "刚才没能完整回复，你把那条消息再发一次，我重新接着看。",
    });
    expect(events.at(-1)).toMatchObject({ type: "done", degraded: true });
    expect(mocks.runAgent).not.toHaveBeenCalled();
    expect(mocks.proactiveTaskCreate).not.toHaveBeenCalled();
    expect(mocks.messagesCreateIdempotentAssistantTurn).toHaveBeenCalledTimes(1);
  });

  it("resumes an existing user without an assistant and excludes that turn from history", async () => {
    mocks.messagesCreateIdempotentUserTurn.mockResolvedValueOnce({
      message: persistedMessage("user", "恢复执行"),
      attachments: [],
      created: false,
    });
    mocks.findByClientTurn.mockResolvedValueOnce(null);

    const response = await POST(new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(withClientTurn({ message: "恢复执行" })),
    }));
    await response.text();

    expect(mocks.runAgent).toHaveBeenCalledTimes(1);
    expect(mocks.recentHistory).toHaveBeenCalledWith("conversation-1", 12, DEFAULT_CLIENT_TURN_ID);
    expect(mocks.messagesCreateIdempotentAssistantTurn).toHaveBeenCalledTimes(1);
  });

  it("returns a stable conflict when one client turn is reused for another payload", async () => {
    mocks.messagesCreateIdempotentUserTurn.mockRejectedValueOnce(new Error("client_turn_conflict"));

    const response = await POST(new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(withClientTurn({ message: "冲突正文" })),
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "client_turn_conflict" });
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it("does not disguise an unknown turn persistence failure as an attachment error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.messagesCreateIdempotentUserTurn.mockRejectedValueOnce(new Error("password=secret db unavailable"));

    const response = await POST(new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(withClientTurn({ message: "数据库异常" })),
    }));
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload).toEqual({ error: "chat_turn_create_failed" });
    expect(JSON.stringify(payload)).not.toContain("password");
    expect(consoleError).toHaveBeenCalledWith("chat_turn_create_failed", { code: "turn_persist_failed" });
    consoleError.mockRestore();
  });

  it("checks an existing turn conflict before rejecting a changed missing attachment", async () => {
    mocks.findByClientTurn.mockResolvedValueOnce(persistedMessage("user", "原始正文"));
    mocks.messagesCreateIdempotentUserTurn.mockRejectedValueOnce(new Error("client_turn_conflict"));

    const response = await POST(new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(withClientTurn({
        message: "被错误复用的新正文",
        attachmentIds: ["30000000-0000-4000-8000-000000000099"],
      })),
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "client_turn_conflict" });
    expect(mocks.getAttachmentForUser).not.toHaveBeenCalled();
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it("rechecks the user turn when an attachment becomes bound during preflight", async () => {
    const userMessage = { ...persistedMessage("user", "附件并发重试"), role: "user" as const };
    mocks.findByClientTurn
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(userMessage)
      .mockResolvedValue(null);
    mocks.getAttachmentForUser.mockResolvedValue({
      ...mocks.readyImage,
      messageId: userMessage.id,
      status: "bound",
    });
    mocks.messagesCreateIdempotentUserTurn.mockResolvedValueOnce({
      message: userMessage,
      attachments: [{ ...mocks.readyImage, messageId: userMessage.id, status: "bound" }],
      created: false,
    });

    const response = await POST(new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(withClientTurn({
        message: "附件并发重试",
        attachmentIds: [mocks.readyImage.id],
      })),
    }));
    await response.text();

    expect(response.status).toBe(200);
    expect(mocks.getAttachmentForUser).toHaveBeenCalledTimes(2);
    expect(mocks.messagesCreateIdempotentUserTurn).toHaveBeenCalledTimes(1);
    expect(mocks.runAgent).toHaveBeenCalledTimes(1);
  });

  it("does not create reminder side effects when another request already won the assistant row", async () => {
    mocks.messagesCreateIdempotentAssistantTurn.mockResolvedValueOnce({
      message: persistedMessage("assistant", "另一请求已保存"),
      created: false,
    });

    const response = await POST(new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(withClientTurn({ message: "10 分钟后提醒我吃药" })),
    }));
    await response.text();

    expect(mocks.messagesCreateIdempotentAssistantTurn).toHaveBeenCalledTimes(1);
    expect(mocks.proactiveTaskCreate).not.toHaveBeenCalled();
  });

  it("does not enter fallback when the reader cancels after the assistant is persisted", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let resolveAssistant: ((value: { message: ReturnType<typeof persistedMessage>; created: boolean }) => void) | undefined;
    mocks.messagesCreateIdempotentAssistantTurn.mockImplementationOnce(() => new Promise((resolve) => {
      resolveAssistant = resolve;
    }));

    const response = await POST(new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(withClientTurn({ message: "取消读取" })),
    }));
    const reader = response.body!.getReader();
    await reader.read();
    await reader.read();
    await reader.cancel();
    resolveAssistant?.({ message: persistedMessage("assistant", "收到。"), created: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.messagesCreateIdempotentAssistantTurn).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls.filter(([code]) => code === "chat_agent_failed")).toHaveLength(0);
    consoleError.mockRestore();
  });

  it("does not persist a fallback when the turn execution lock cannot be acquired", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.acquireClientTurnExecutionLock.mockRejectedValueOnce(new Error("lock_backend_unavailable"));

    const response = await POST(new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(withClientTurn({ message: "锁失败后重试" })),
    }));
    const events = parseSseEvents(await response.text());

    expect(events).toEqual([{ type: "error", message: "消息暂时没有受理，请重试。" }]);
    expect(mocks.claimClientTurnExecution).not.toHaveBeenCalled();
    expect(mocks.runAgent).not.toHaveBeenCalled();
    expect(mocks.messagesCreateIdempotentAssistantTurn).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith("chat_turn_lock_failed", { code: "turn_lock_acquire_failed" });
    consoleError.mockRestore();
  });

  it("does not accept or run a turn when its durable execution claim fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.claimClientTurnExecution.mockRejectedValueOnce(new Error("claim_backend_unavailable"));

    const response = await POST(new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(withClientTurn({ message: "持久化受理失败" })),
    }));
    const events = parseSseEvents(await response.text());

    expect(events).toEqual([{ type: "error", message: "消息暂时没有受理，请重试。" }]);
    expect(mocks.runAgent).not.toHaveBeenCalled();
    expect(mocks.messagesCreateIdempotentAssistantTurn).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith("chat_turn_admission_failed", {
      code: "turn_admission_failed",
      errorType: "Error",
    });
    consoleError.mockRestore();
  });

  it("returns the existing assistant when an agent failure loses the assistant race", async () => {
    mocks.runAgent.mockImplementationOnce(async function* () {
      throw new Error("agent_failed");
    });
    mocks.messagesCreateIdempotentAssistantTurn.mockResolvedValueOnce({
      message: persistedMessage("assistant", "并发请求保存的回复"),
      created: false,
    });

    const response = await POST(new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(withClientTurn({ message: "并发失败" })),
    }));
    const events = parseSseEvents(await response.text());

    expect(events.some((event) => event.type === "replace" && event.content === "并发请求保存的回复")).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      assistantMessageId: "message-assistant",
      clientTurnId: DEFAULT_CLIENT_TURN_ID,
      degraded: true,
    });
  });

  it("rejects unowned attachments before creating or binding a message", async () => {
    mocks.getAttachmentForUser.mockResolvedValueOnce(null);
    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(withClientTurn({ message: "看看", attachmentIds: [mocks.readyDocument.id] })),
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
        body: JSON.stringify(withClientTurn({ message: "看看", attachmentIds: [mocks.readyDocument.id] })),
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
        body: JSON.stringify(withClientTurn({ message: "看看", attachmentIds: [mocks.readyDocument.id] })),
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
        body: JSON.stringify(withClientTurn({ message: "看看", attachmentIds: [mocks.readyDocument.id] })),
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
        body: JSON.stringify(withClientTurn({ message: "看看", attachmentIds: [mocks.readyImage.id] })),
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
        body: JSON.stringify(withClientTurn({ message: "继续", attachmentIds: [mocks.readyImage.id] })),
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
        attachmentToolGuard: true,
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
        body: JSON.stringify(withClientTurn({ message: "继续一轮" }, "60000000-0000-4000-8000-000000000001")),
      }),
    );
    await first.text();
    const second = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(withClientTurn({ message: "再继续一轮" }, "60000000-0000-4000-8000-000000000002")),
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
    expect(agentCalls[0]?.[0].attachmentToolGuard).toBe(true);
    assertAnthropicHasNoEmptyUserContent(await captureAnthropicBody(firstHistory as LlmMessage[]));
    const secondHistory = agentCalls[1]?.[0].history as Array<{
      attachments?: Array<{ fileName: string }>;
    }>;
    expect(secondHistory.flatMap((message) => message.attachments ?? []).map((item) => item.fileName)).toEqual([
      "history-3.md",
      "history-4.md",
      "history-5.md",
    ]);
    expect(agentCalls[1]?.[0].attachmentToolGuard).toBe(true);
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
        body: JSON.stringify(withClientTurn({ message: "看新的", attachmentIds: [mocks.readyDocument.id] })),
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
        body: JSON.stringify(withClientTurn({ message: "分析这些文件", attachmentIds })),
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
        body: JSON.stringify(withClientTurn({ message: "继续纯文本聊天" })),
      }),
    );
    await response.text();

    expect(response.status).toBe(200);
    const input = (mocks.runAgent.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0];
    expect(input?.history).toEqual([{
      role: "user",
      content: "[该轮历史附件已从当前模型上下文中裁剪；这不是新的用户指令。]",
    }]);
    expect(input?.attachmentToolGuard).toBe(true);
    assertAnthropicHasNoEmptyUserContent(await captureAnthropicBody(input?.history as LlmMessage[]));
    expect(mocks.readAttachment).not.toHaveBeenCalled();
    expect(mocks.messagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ role: "user", content: "继续纯文本聊天" }),
    );
  });

  it("restores tools only after attachment messages leave recent history", async () => {
    mocks.recentHistory.mockResolvedValueOnce([
      { id: "24000000-0000-4000-8000-000000000001", role: "user", content: "最近已无附件" },
    ]);
    mocks.listAttachmentsForMessages.mockResolvedValueOnce([]);

    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(withClientTurn({ message: "现在帮我搜索" })),
      }),
    );
    await response.text();

    expect(response.status).toBe(200);
    const input = (mocks.runAgent.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0];
    expect(input?.attachmentToolGuard).toBe(false);
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
        body: JSON.stringify(withClientTurn({ message: "继续" })),
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

  it("persists one degraded fallback and finishes with done after an agent failure", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.runAgent.mockImplementationOnce(async function* () {
      yield "先收到半句";
      throw new Error("secret-token=abc /private/attachments/hidden");
    });

    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(withClientTurn({ message: "你好" })),
      }),
    );
    const body = await response.text();
    const events = parseSseEvents(body);

    expect(response.status).toBe(200);
    expect(events[0]).toEqual({
      type: "accepted",
      conversationId: "conversation-1",
      userMessageId: "message-user",
      clientTurnId: DEFAULT_CLIENT_TURN_ID,
    });
    expect(events.filter((event) => event.type === "error")).toEqual([]);
    expect(events.at(-1)).toEqual({
      type: "done",
      conversationId: "conversation-1",
      assistantMessageId: "message-assistant",
      degraded: true,
      clientTurnId: DEFAULT_CLIENT_TURN_ID,
      userMessageId: "message-user",
    });
    expect(mocks.messagesCreate).toHaveBeenCalledTimes(2);
    expect(mocks.messagesCreate).toHaveBeenLastCalledWith(expect.objectContaining({
      role: "assistant",
      content: "先收到半句\n\n我这边刚才有点卡住了，但不是你的问题。我们可以稍后再试一次。",
    }));
    expect(body).not.toContain("secret-token");
    expect(body).not.toContain("/private/attachments");
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("secret-token");
    consoleError.mockRestore();
  });

  it("ends an accepted stream without leaking when fallback persistence also fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.runAgent.mockImplementationOnce(async function* () {
      throw new Error("secret-agent-value");
    });
    mocks.messagesCreateIdempotentAssistantTurn.mockRejectedValueOnce(new Error("secret-database-value"));

    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(withClientTurn({ message: "你好" })),
      }),
    );
    const body = await response.text();
    const events = parseSseEvents(body);

    expect(events).toEqual([
      {
        type: "accepted",
        conversationId: "conversation-1",
        userMessageId: "message-user",
        clientTurnId: DEFAULT_CLIENT_TURN_ID,
      },
      {
        type: "done",
        conversationId: "conversation-1",
        clientTurnId: DEFAULT_CLIENT_TURN_ID,
        userMessageId: "message-user",
        degraded: true,
      },
    ]);
    expect(body).not.toContain("secret-agent-value");
    expect(body).not.toContain("secret-database-value");
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("secret-agent-value");
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("secret-database-value");
    consoleError.mockRestore();
  });

  it("leaves memory extraction to the async agent service", async () => {
    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(withClientTurn({ message: "我喜欢咖啡" })),
      }),
    );

    const body = await response.text();
    const events = parseSseEvents(body);

    expect(response.status).toBe(200);
    expect(events[0]).toEqual({
      type: "accepted",
      conversationId: "conversation-1",
      userMessageId: "message-user",
      clientTurnId: DEFAULT_CLIENT_TURN_ID,
    });
    expect(events.at(-1)).toEqual({
      type: "done",
      conversationId: "conversation-1",
      assistantMessageId: "message-assistant",
      clientTurnId: DEFAULT_CLIENT_TURN_ID,
      userMessageId: "message-user",
    });
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
        body: JSON.stringify(withClientTurn({
          message: "看看今天的新消息",
          attachmentIds: [mocks.readyDocument.id],
          searchEnabled: true,
        })),
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
        body: JSON.stringify(withClientTurn({
          message: "继续聊",
          conversationId: "00000000-0000-4000-8000-000000000999",
        })),
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
        findByClientTurn: vi.fn(async () => null),
        createIdempotentUserTurn: vi.fn(async (input: { content: string }) => ({
          message: await mocks.messagesCreate({ role: "user", content: input.content }),
          attachments: [],
          created: true,
        })),
        createIdempotentAssistantTurn: vi.fn(async (input: { content: string }) => ({
          message: await mocks.messagesCreate({ role: "assistant", content: input.content }),
          created: true,
        })),
        acquireClientTurnExecutionLock: vi.fn(async () => vi.fn(async () => undefined)),
        claimClientTurnExecution: vi.fn(async () => true),
      },
      messageAttachments: {
        listForMessages: vi.fn(async () => []),
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
        body: JSON.stringify(withClientTurn({ message: "10 分钟后紧急提醒我吃药" })),
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

function parseSseEvents(body: string): Array<Record<string, unknown>> {
  return body
    .split("\n\n")
    .map((event) => event.split("\n").find((line) => line.startsWith("data: ")))
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

function withClientTurn<T extends Record<string, unknown>>(
  body: T,
  clientTurnId = DEFAULT_CLIENT_TURN_ID,
): T & { clientTurnId: string } {
  return { ...body, clientTurnId };
}

function persistedMessage(role: "user" | "assistant", content: string) {
  return {
    id: role === "user" ? "message-user" : "message-assistant",
    userId: "user-1",
    conversationId: "conversation-1",
    role,
    content,
    createdAt: new Date("2026-07-14T00:00:00Z"),
  };
}

async function waitForMockCalls(mock: { mock: { calls: unknown[][] } }, count: number): Promise<void> {
  for (let attempt = 0; attempt < 50 && mock.mock.calls.length < count; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (mock.mock.calls.length < count) throw new Error(`mock_call_timeout:${count}`);
}
