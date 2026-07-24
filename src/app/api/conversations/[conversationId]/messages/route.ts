import { NextResponse } from "next/server";
import { withFreshUserDataLease } from "@/server/admin/user-data-lease";
import { serializeChatMessages } from "@/server/attachments/presentation";
import { requireCurrentUser } from "@/server/auth/current-user";
import { resolveDefaultAgentScope } from "@/server/agents/service";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ conversationId: string }> }) {
  let user;
  try {
    user = await requireCurrentUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    return await withFreshUserDataLease(user.id, async (repositories) => {
      const { conversationId } = await context.params;
      const scope = await resolveDefaultAgentScope(user.id, repositories.agents);
      const conversation = await repositories.conversations.get(scope, conversationId);
      if (!conversation) {
        return NextResponse.json({ error: "conversation_not_found" }, { status: 404 });
      }

      const messages = await repositories.messages.list(scope, conversationId);
      const messagesWithAttachments = await serializeChatMessages(
        scope,
        messages,
        repositories.messageAttachments.listForMessages,
      );

      return NextResponse.json({ messages: messagesWithAttachments });
    });
  } catch {
    return NextResponse.json({ error: "messages_load_failed" }, { status: 500 });
  }
}
