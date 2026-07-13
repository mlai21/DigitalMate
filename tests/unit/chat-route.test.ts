import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/chat/route";

const mocks = vi.hoisted(() => {
  const extractAndSaveFromMessage = vi.fn(async () => undefined);
  const messagesCreate = vi.fn(async (input: { role: string; content: string }) => ({
    id: input.role === "user" ? "message-user" : "message-assistant",
    userId: "user-1",
    conversationId: "conversation-1",
    role: input.role,
    content: input.content,
    createdAt: new Date("2026-07-05T10:00:00+08:00"),
  }));

  return {
    extractAndSaveFromMessage,
    messagesCreate,
    createRepositories: vi.fn(() => ({
      conversations: {
        getOrCreateDefault: vi.fn(async () => ({ id: "conversation-1" })),
        getForUser: vi.fn(async (): Promise<{ id: string } | null> => ({ id: "conversation-1" })),
      },
      messages: {
        create: messagesCreate,
        recentHistory: vi.fn(async () => []),
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
  readEnv: vi.fn(() => ({})),
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

  it("passes the per-message search authorization to the agent", async () => {
    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "看看今天的新消息", searchEnabled: true }),
      }),
    );

    await response.text();

    expect(response.status).toBe(200);
    expect(mocks.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "看看今天的新消息",
        webSearchEnabled: true,
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
