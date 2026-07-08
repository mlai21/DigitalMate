import { NextResponse } from "next/server";
import { requireCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ conversationId: string }> }) {
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

  const messages = await repositories.messages.list(conversationId);
  return NextResponse.json({
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role === "user" ? "user" : "assistant",
      content: message.content,
      createdAt: message.createdAt.toISOString(),
    })),
  });
}
