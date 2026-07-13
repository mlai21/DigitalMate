import { NextResponse } from "next/server";
import { serializeChatMessages } from "@/server/attachments/presentation";
import { requireCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";

export const runtime = "nodejs";

export async function GET(request: Request) {
  let user;
  try {
    user = await requireCurrentUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  try {
    const repositories = createRepositories();
    const conversationIdParam = url.searchParams.get("conversationId");
    const conversation = conversationIdParam
      ? await repositories.conversations.getForUser(user.id, conversationIdParam)
      : await repositories.conversations.getOrCreateDefault(user.id);
    if (!conversation) {
      return NextResponse.json({ error: "conversation_not_found" }, { status: 404 });
    }
    const after = url.searchParams.get("after") ? new Date(url.searchParams.get("after") as string) : new Date(0);
    const messages = await repositories.messages.listAfter(conversation.id, after);
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
