import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as listConversations, POST as createConversation } from "@/app/api/conversations/route";
import { DELETE as deleteConversation, PATCH as patchConversation } from "@/app/api/conversations/[conversationId]/route";
import { GET as listConversationMessages } from "@/app/api/conversations/[conversationId]/messages/route";
import { POST as createProject } from "@/app/api/projects/route";

const mocks = vi.hoisted(() => {
  const conversation = {
    id: "00000000-0000-4000-8000-000000000001",
    userId: "user-1",
    channel: "web",
    title: "新的对话",
    projectId: null,
    pinned: false,
    updatedAt: new Date("2026-07-08T10:00:00+08:00"),
  };
  const project = {
    id: "00000000-0000-4000-8000-000000000002",
    userId: "user-1",
    name: "AI 学习",
    description: "",
    updatedAt: new Date("2026-07-08T10:00:00+08:00"),
  };
  const message = {
    id: "00000000-0000-4000-8000-000000000003",
    userId: "user-1",
    conversationId: conversation.id,
    role: "user" as const,
    content: "看看附件",
    createdAt: new Date("2026-07-08T10:01:00+08:00"),
    internalSecret: "message-private-secret",
  };
  const internalMessage = {
    ...message,
    id: "00000000-0000-4000-8000-000000000099",
    role: "system" as const,
    content: "internal system message",
  };
  const boundAttachment = {
    id: "00000000-0000-4000-8000-000000000004",
    userId: "user-1",
    messageId: message.id,
    kind: "document" as const,
    fileName: "notes.md",
    mimeType: "text/markdown",
    sizeBytes: 12,
    storageKey: "private-storage-key",
    extractedText: "private extracted text",
    textTruncated: false,
    status: "bound" as const,
    errorCode: "private_error",
    deletionClaimToken: "private-deletion-token",
    createdAt: new Date("2026-07-08T10:00:30+08:00"),
    updatedAt: new Date("2026-07-08T10:01:00+08:00"),
  };
  const listAttachmentsForMessages = vi.fn(async () => [boundAttachment]);
  const repositories = {
    conversations: {
      listWithStats: vi.fn(async () => [{ ...conversation, messageCount: 3, lastMessageAt: conversation.updatedAt }]),
      create: vi.fn(async () => conversation),
      getForUser: vi.fn(async () => conversation),
      update: vi.fn(async () => ({ ...conversation, title: "改名后", pinned: true })),
      delete: vi.fn(async () => undefined),
    },
    projects: {
      list: vi.fn(async () => [project]),
      create: vi.fn(async () => project),
      getForUser: vi.fn(async () => project),
    },
    messages: {
      list: vi.fn(async () => [message, internalMessage]),
    },
    messageAttachments: {
      listForMessages: listAttachmentsForMessages,
    },
  };
  return {
    conversation,
    project,
    message,
    internalMessage,
    boundAttachment,
    listAttachmentsForMessages,
    repositories,
    createRepositories: vi.fn(() => repositories),
    requireCurrentUser: vi.fn(async () => ({ id: "user-1", displayName: "Tang" })),
  };
});

vi.mock("@/server/auth/current-user", () => ({
  requireCurrentUser: mocks.requireCurrentUser,
}));

vi.mock("@/server/db/repositories", () => ({
  createRepositories: mocks.createRepositories,
}));

describe("conversations API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists conversations with stats and projects", async () => {
    const response = await listConversations();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.conversations[0]).toMatchObject({
      id: mocks.conversation.id,
      title: "新的对话",
      pinned: false,
      messageCount: 3,
    });
    expect(body.projects[0]).toMatchObject({ id: mocks.project.id, name: "AI 学习" });
  });

  it("returns safe attachment card data when loading a conversation", async () => {
    const response = await listConversationMessages(
      new Request(`http://localhost/api/conversations/${mocks.conversation.id}/messages`),
      { params: Promise.resolve({ conversationId: mocks.conversation.id }) },
    );
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body.messages).toEqual([{
      id: mocks.message.id,
      role: "user",
      content: "看看附件",
      createdAt: "2026-07-08T02:01:00.000Z",
      attachments: [{
        id: mocks.boundAttachment.id,
        kind: "document",
        fileName: "notes.md",
        mimeType: "text/markdown",
        sizeBytes: 12,
        status: "bound",
        downloadUrl: `/api/chat/attachments/${mocks.boundAttachment.id}/download`,
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
    expect(mocks.listAttachmentsForMessages).toHaveBeenCalledWith("user-1", [mocks.message.id]);
    expect(serialized).not.toContain("userId");
    expect(serialized).not.toContain("conversationId");
    expect(serialized).not.toContain("internalSecret");
    expect(serialized).not.toContain("message-private-secret");
    expect(serialized).not.toContain(mocks.internalMessage.id);
    expect(serialized).not.toContain("storageKey");
    expect(serialized).not.toContain("private-storage-key");
    expect(serialized).not.toContain("extractedText");
    expect(serialized).not.toContain("private extracted text");
    expect(serialized).not.toContain("textTruncated");
    expect(serialized).not.toContain("errorCode");
    expect(serialized).not.toContain("deletionClaimToken");
    expect(serialized).not.toContain("private-deletion-token");
  });

  it("does not query attachments when a conversation has no messages", async () => {
    mocks.repositories.messages.list.mockResolvedValueOnce([]);

    const response = await listConversationMessages(
      new Request(`http://localhost/api/conversations/${mocks.conversation.id}/messages`),
      { params: Promise.resolve({ conversationId: mocks.conversation.id }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ messages: [] });
    expect(mocks.listAttachmentsForMessages).not.toHaveBeenCalled();
  });

  it("does not query messages or attachments for an unowned conversation", async () => {
    mocks.repositories.conversations.getForUser.mockResolvedValueOnce(null as never);

    const response = await listConversationMessages(
      new Request("http://localhost/api/conversations/unowned/messages"),
      { params: Promise.resolve({ conversationId: "unowned" }) },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "conversation_not_found" });
    expect(mocks.repositories.messages.list).not.toHaveBeenCalled();
    expect(mocks.listAttachmentsForMessages).not.toHaveBeenCalled();
  });

  it("returns a stable error when conversation attachment loading fails", async () => {
    mocks.listAttachmentsForMessages.mockRejectedValueOnce(
      new Error("secret-token=abc /private/attachments/hidden"),
    );

    const response = await listConversationMessages(
      new Request(`http://localhost/api/conversations/${mocks.conversation.id}/messages`),
      { params: Promise.resolve({ conversationId: mocks.conversation.id }) },
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "messages_load_failed" });
    expect(JSON.stringify(body)).not.toContain("secret-token");
    expect(JSON.stringify(body)).not.toContain("/private/attachments");
  });

  it("creates a conversation, optionally inside a project", async () => {
    const response = await createConversation(
      new Request("http://localhost/api/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: mocks.project.id }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.repositories.projects.getForUser).toHaveBeenCalledWith("user-1", mocks.project.id);
    expect(mocks.repositories.conversations.create).toHaveBeenCalledWith("user-1", {
      title: undefined,
      projectId: mocks.project.id,
    });
  });

  it("renames, pins and moves a conversation via PATCH", async () => {
    const response = await patchConversation(
      new Request("http://localhost/api/conversations/x", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "改名后", pinned: true, projectId: null }),
      }),
      { params: Promise.resolve({ conversationId: mocks.conversation.id }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.conversation.title).toBe("改名后");
    expect(mocks.repositories.conversations.update).toHaveBeenCalledWith("user-1", mocks.conversation.id, {
      title: "改名后",
      pinned: true,
      projectId: null,
    });
  });

  it("deletes a conversation owned by the current user", async () => {
    const response = await deleteConversation(new Request("http://localhost/api/conversations/x", { method: "DELETE" }), {
      params: Promise.resolve({ conversationId: mocks.conversation.id }),
    });

    expect(response.status).toBe(200);
    expect(mocks.repositories.conversations.delete).toHaveBeenCalledWith("user-1", mocks.conversation.id);
  });

  it("returns 404 when deleting a conversation that is not owned", async () => {
    mocks.repositories.conversations.getForUser.mockResolvedValueOnce(null as never);

    const response = await deleteConversation(new Request("http://localhost/api/conversations/x", { method: "DELETE" }), {
      params: Promise.resolve({ conversationId: mocks.conversation.id }),
    });

    expect(response.status).toBe(404);
    expect(mocks.repositories.conversations.delete).not.toHaveBeenCalled();
  });

  it("creates a project with a trimmed name", async () => {
    const response = await createProject(
      new Request("http://localhost/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "AI 学习" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.repositories.projects.create).toHaveBeenCalledWith("user-1", { name: "AI 学习" });
  });

  it("rejects invalid project payloads", async () => {
    const response = await createProject(
      new Request("http://localhost/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "" }),
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.repositories.projects.create).not.toHaveBeenCalled();
  });
});
