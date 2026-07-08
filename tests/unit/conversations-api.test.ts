import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as listConversations, POST as createConversation } from "@/app/api/conversations/route";
import { DELETE as deleteConversation, PATCH as patchConversation } from "@/app/api/conversations/[conversationId]/route";
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
  };
  return {
    conversation,
    project,
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
