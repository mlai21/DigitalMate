import { NextResponse } from "next/server";
import { z } from "zod";
import { requireCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";

export const runtime = "nodejs";

const createSchema = z.object({
  title: z.string().max(120).optional(),
  projectId: z.string().uuid().nullable().optional(),
});

export async function GET() {
  let user;
  try {
    user = await requireCurrentUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const repositories = createRepositories();
  const [conversations, projects] = await Promise.all([
    repositories.conversations.listWithStats(user.id),
    repositories.projects.list(user.id),
  ]);

  return NextResponse.json({
    conversations: conversations.map(serializeConversation),
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name,
      description: project.description,
      updatedAt: project.updatedAt.toISOString(),
    })),
  });
}

export async function POST(request: Request) {
  let user;
  try {
    user = await requireCurrentUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = createSchema.safeParse(await request.json().catch(() => ({})));
  if (!body.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repositories = createRepositories();
  if (body.data.projectId) {
    const project = await repositories.projects.getForUser(user.id, body.data.projectId);
    if (!project) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
  }

  const conversation = await repositories.conversations.create(user.id, {
    title: body.data.title,
    projectId: body.data.projectId ?? null,
  });
  return NextResponse.json({ conversation: serializeConversation({ ...conversation, messageCount: 0, lastMessageAt: null }) });
}

function serializeConversation(conversation: {
  id: string;
  channel: string;
  title: string;
  projectId: string | null;
  pinned: boolean;
  updatedAt: Date;
  messageCount: number;
  lastMessageAt: Date | null;
}) {
  return {
    id: conversation.id,
    channel: conversation.channel,
    title: conversation.title,
    projectId: conversation.projectId,
    pinned: conversation.pinned,
    updatedAt: conversation.updatedAt.toISOString(),
    messageCount: conversation.messageCount,
    lastMessageAt: conversation.lastMessageAt ? conversation.lastMessageAt.toISOString() : null,
  };
}
