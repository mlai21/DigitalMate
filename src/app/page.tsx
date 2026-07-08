import { ChatShell, type ChatMessage } from "@/components/chat/chat-shell";
import { getCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";

export const dynamic = "force-dynamic";

export default async function Home() {
  const data = await loadChatPageData();

  return (
    <ChatShell
      conversationId={data.conversationId}
      initialMessages={data.initialMessages}
      setupNotice={data.setupNotice}
    />
  );
}

async function loadChatPageData(): Promise<{
  conversationId?: string;
  initialMessages: ChatMessage[];
  setupNotice?: string;
}> {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return { initialMessages: [], setupNotice: "需要先登录后才能继续聊天。" };
    }

    const repositories = createRepositories();
    const conversation = await repositories.conversations.getOrCreateDefault(user.id);
    const messages = await repositories.messages.list(conversation.id);
    const initialMessages: ChatMessage[] = messages.map((message) => ({
      id: message.id,
      role: message.role === "user" ? "user" : "assistant",
      content: message.content,
      createdAt: message.createdAt.toISOString(),
    }));

    return { conversationId: conversation.id, initialMessages };
  } catch {
    return { initialMessages: [], setupNotice: "数据库还没连上。先运行迁移和种子数据后，就可以开始聊天。" };
  }
}
