import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ChatShell, type ChatMessage } from "@/components/chat/chat-shell";
import "@/app/globals.css";

const initialMessages: ChatMessage[] = Array.from({ length: 18 }, (_, index) => ({
  id: `history-${index + 1}`,
  role: index % 3 === 0 ? "user" : "assistant",
  content: `第 ${index + 1} 条历史消息：这是一段用于验证真实聊天滚动容器的内容，输入框增高或新消息到达时都不能打断阅读。`,
  createdAt: new Date(Date.UTC(2026, 6, 14, 0, 0, index)).toISOString(),
}));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ChatShell
      conversationId="conversation-e2e"
      initialMessages={initialMessages}
      initialConversations={[
        {
          id: "conversation-e2e",
          title: "滚动验收",
          channel: "web",
          projectId: null,
          pinned: false,
          updatedAt: "2026-07-14T00:00:17.000Z",
          messageCount: initialMessages.length,
        },
      ]}
    />
  </StrictMode>,
);
