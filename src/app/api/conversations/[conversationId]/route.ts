import { NextResponse } from "next/server";
import { z } from "zod";
import { requireCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";

export const runtime = "nodejs";

const updateSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  pinned: z.boolean().optional(),
  projectId: z.string().uuid().nullable().optional(),
});

type RouteContext = { params: Promise<{ conversationId: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  let user;
  try {
    user = await requireCurrentUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { conversationId } = await context.params;
  const body = updateSchema.safeParse(await request.json().catch(() => ({})));
  if (!body.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repositories = createRepositories();
  if (body.data.projectId) {
    const project = await repositories.projects.getForUser(user.id, body.data.projectId);
    if (!project) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
  }

  const conversation = await repositories.conversations.update(user.id, conversationId, body.data);
  if (!conversation) {
    return NextResponse.json({ error: "conversation_not_found" }, { status: 404 });
  }

  return NextResponse.json({
    conversation: {
      id: conversation.id,
      title: conversation.title,
      projectId: conversation.projectId,
      pinned: conversation.pinned,
    },
  });
}

export async function DELETE(_request: Request, context: RouteContext) {
  let user;
  try {
    user = await requireCurrentUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { conversationId } = await context.params;
  const repositories = createRepositories();
  const conversation = await repositories.conversations.getForUser(user.id, conversationId);
  if (!conversation) {
    return NextResponse.json({ error: "conversation_not_found" }, { status: 404 });
  }

  await repositories.conversations.delete(user.id, conversationId);
  return NextResponse.json({ ok: true });
}
