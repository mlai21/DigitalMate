import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/chat/route";
import type { DbMessageAttachment } from "@/server/db/repositories";

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
