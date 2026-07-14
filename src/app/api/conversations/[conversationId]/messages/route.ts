import { NextResponse } from "next/server";
import { serializeChatMessages } from "@/server/attachments/presentation";
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
  try {
    const repositories = createRepositories();
    const conversation = await repositories.conversations.getForUser(user.id, conversationId);
    if (!conversation) {
      return NextResponse.json({ error: "conversation_not_found" }, { status: 404 });
    }

    const messages = await repositories.messages.list(conversationId);
    const messagesWithAttachments = await serializeChatMessages(
      user.id,
      messages,
      repositories.messageAttachments.listForMessages,
    );

    return NextResponse.json({ messages: messagesWithAttachments });
  } catch {
    return NextResponse.json({ error: "messages_load_failed" }, { status: 500 });
  }
}
