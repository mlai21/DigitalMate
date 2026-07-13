import { ChatShell, type ChatMessage } from "@/components/chat/chat-shell";
import type { ConversationItem, ProjectItem } from "@/components/chat/chat-sidebar";
import { serializeChatMessages } from "@/server/attachments/presentation";
import { getCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";

export const dynamic = "force-dynamic";

export default async function Home() {
  const data = await loadChatPageData();

  return (
    <ChatShell
      conversationId={data.conversationId}
      initialMessages={data.initialMessages}
      initialConversations={data.initialConversations}
      initialProjects={data.initialProjects}
      setupNotice={data.setupNotice}
      loginRequired={data.loginRequired}
    />
  );
}

async function loadChatPageData(): Promise<{
  conversationId?: string;
  initialMessages: ChatMessage[];
  initialConversations: ConversationItem[];
  initialProjects: ProjectItem[];
  setupNotice?: string;
  loginRequired?: boolean;
}> {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return {
        initialMessages: [],
        initialConversations: [],
        initialProjects: [],
        setupNotice: "需要先登录后才能继续聊天。",
        loginRequired: true,
      };
    }

    const repositories = createRepositories();
    const [conversations, projects] = await Promise.all([
      repositories.conversations.listWithStats(user.id),
      repositories.projects.list(user.id),
    ]);

    const initialConversations: ConversationItem[] = conversations.map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      channel: conversation.channel,
      projectId: conversation.projectId,
      pinned: conversation.pinned,
      updatedAt: conversation.updatedAt.toISOString(),
      messageCount: conversation.messageCount,
    }));
    const initialProjects: ProjectItem[] = projects.map((project) => ({
      id: project.id,
      name: project.name,
      description: project.description,
    }));

    const active =
      conversations.find((conversation) => conversation.channel === "web") ??
      (conversations.length === 0 ? await repositories.conversations.getOrCreateDefault(user.id) : undefined);

    if (!active) {
      return { initialMessages: [], initialConversations, initialProjects };
    }

    let initialMessages: ChatMessage[];
    try {
      const messages = await repositories.messages.list(active.id);
      initialMessages = await serializeChatMessages(
        user.id,
        messages,
        repositories.messageAttachments.listForMessages,
      );
    } catch {
      return {
        conversationId: active.id,
        initialMessages: [],
        initialConversations,
        initialProjects,
        setupNotice: "聊天记录暂时加载失败，请稍后刷新。",
      };
    }

    if (!initialConversations.some((conversation) => conversation.id === active.id)) {
      initialConversations.unshift({
        id: active.id,
        title: active.title,
        channel: active.channel,
        projectId: active.projectId,
        pinned: active.pinned,
        updatedAt: active.updatedAt.toISOString(),
        messageCount: initialMessages.length,
      });
    }

    return { conversationId: active.id, initialMessages, initialConversations, initialProjects };
  } catch {
    return {
      initialMessages: [],
      initialConversations: [],
      initialProjects: [],
      setupNotice: "数据库还没连上。先运行迁移和种子数据后，就可以开始聊天。",
    };
  }
}
