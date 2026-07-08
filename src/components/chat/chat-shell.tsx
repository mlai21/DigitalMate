"use client";

import Link from "next/link";
import { Menu, Settings, SquarePen, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChatInput } from "@/components/chat/chat-input";
import { ChatSidebar, type ConversationItem, type ProjectItem } from "@/components/chat/chat-sidebar";
import { MessageBubble } from "@/components/chat/message-bubble";
import { TypingDots } from "@/components/chat/typing-dots";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

type SsePayload =
  | { type: "chunk"; content: string }
  | { type: "done"; conversationId: string }
  | { type: "error"; message: string };

export function ChatShell({
  conversationId,
  initialMessages,
  initialConversations = [],
  initialProjects = [],
  setupNotice,
}: {
  conversationId?: string;
  initialMessages: ChatMessage[];
  initialConversations?: ConversationItem[];
  initialProjects?: ProjectItem[];
  setupNotice?: string;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [conversations, setConversations] = useState<ConversationItem[]>(initialConversations);
  const [projects, setProjects] = useState<ProjectItem[]>(initialProjects);
  const [activeConversationId, setActiveConversationId] = useState(conversationId);
  const [isStreaming, setIsStreaming] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const latestMessageTime = useMemo(() => messages.at(-1)?.createdAt ?? new Date(0).toISOString(), [messages]);

  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isStreaming]);

  useEffect(() => {
    if (!activeConversationId) return;
    const timer = window.setInterval(async () => {
      const response = await fetch(
        `/api/messages?conversationId=${activeConversationId}&after=${encodeURIComponent(latestMessageTime)}`,
      );
      if (!response.ok) return;
      const data = (await response.json()) as { messages?: ChatMessage[] };
      if (!data.messages?.length) return;
      setMessages((current) => mergeMessages(current, data.messages ?? []));
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [activeConversationId, latestMessageTime]);

  async function refreshSidebar() {
    try {
      const response = await fetch("/api/conversations");
      if (!response.ok) return;
      const data = (await response.json()) as { conversations?: ConversationItem[]; projects?: ProjectItem[] };
      if (data.conversations) setConversations(data.conversations);
      if (data.projects) setProjects(data.projects);
    } catch {
      // sidebar refresh is best-effort
    }
  }

  async function selectConversation(id: string) {
    if (id === activeConversationId) {
      setMobileSidebarOpen(false);
      return;
    }
    setActiveConversationId(id);
    setMobileSidebarOpen(false);
    setMessages([]);
    try {
      const response = await fetch(`/api/conversations/${id}/messages`);
      if (!response.ok) return;
      const data = (await response.json()) as { messages?: ChatMessage[] };
      setMessages(data.messages ?? []);
    } catch {
      // keep the empty state; polling will backfill when possible
    }
  }

  async function newChat(projectId?: string) {
    try {
      const response = await fetch("/api/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(projectId ? { projectId } : {}),
      });
      if (!response.ok) return;
      const data = (await response.json()) as { conversation: ConversationItem };
      setConversations((current) => [data.conversation, ...current]);
      setActiveConversationId(data.conversation.id);
      setMessages([]);
      setMobileSidebarOpen(false);
    } catch {
      // ignore; user can retry
    }
  }

  async function createProject() {
    const name = window.prompt("项目名称");
    if (!name?.trim()) return;
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    if (response.ok) await refreshSidebar();
  }

  async function renameConversation(id: string) {
    const current = conversations.find((conversation) => conversation.id === id);
    const title = window.prompt("会话名称", current?.title ?? "");
    if (!title?.trim()) return;
    await patchConversation(id, { title: title.trim() });
  }

  async function togglePin(id: string, pinned: boolean) {
    await patchConversation(id, { pinned });
  }

  async function moveToProject(id: string, projectId: string | null) {
    await patchConversation(id, { projectId });
  }

  async function patchConversation(id: string, body: Record<string, unknown>) {
    const response = await fetch(`/api/conversations/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) await refreshSidebar();
  }

  async function deleteConversation(id: string) {
    const target = conversations.find((conversation) => conversation.id === id);
    if (!window.confirm(`确定删除会话「${target?.title ?? ""}」吗？删除后消息记录不可恢复。`)) return;
    const response = await fetch(`/api/conversations/${id}`, { method: "DELETE" });
    if (!response.ok) return;
    const remaining = conversations.filter((conversation) => conversation.id !== id);
    setConversations(remaining);
    if (id === activeConversationId) {
      const next = remaining.find((conversation) => conversation.channel === "web");
      if (next) {
        await selectConversation(next.id);
      } else {
        setActiveConversationId(undefined);
        setMessages([]);
      }
    }
  }

  async function renameProject(id: string) {
    const current = projects.find((project) => project.id === id);
    const name = window.prompt("项目名称", current?.name ?? "");
    if (!name?.trim()) return;
    const response = await fetch(`/api/projects/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    if (response.ok) await refreshSidebar();
  }

  async function deleteProject(id: string) {
    const target = projects.find((project) => project.id === id);
    if (!window.confirm(`确定删除项目「${target?.name ?? ""}」吗？项目内的会话会保留并移出项目。`)) return;
    const response = await fetch(`/api/projects/${id}`, { method: "DELETE" });
    if (response.ok) await refreshSidebar();
  }

  async function sendMessage(content: string) {
    let targetConversationId = activeConversationId;
    if (!targetConversationId) {
      try {
        const response = await fetch("/api/conversations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        if (!response.ok) return;
        const data = (await response.json()) as { conversation: ConversationItem };
        targetConversationId = data.conversation.id;
        setConversations((current) => [data.conversation, ...current]);
        setActiveConversationId(targetConversationId);
      } catch {
        return;
      }
    }

    const now = new Date().toISOString();
    const userMessage: ChatMessage = { id: `local-user-${now}`, role: "user", content, createdAt: now };
    const draftId = `assistant-${now}`;
    setMessages((current) => [
      ...current,
      userMessage,
      { id: draftId, role: "assistant", content: "", createdAt: now },
    ]);
    setIsStreaming(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: content, conversationId: targetConversationId }),
      });
      if (!response.ok || !response.body) throw new Error("chat_request_failed");

      for await (const payload of readSse(response.body)) {
        if (payload.type === "chunk") {
          setMessages((current) =>
            current.map((message) =>
              message.id === draftId ? { ...message, content: `${message.content}${payload.content}` } : message,
            ),
          );
        }
        if (payload.type === "done") {
          setActiveConversationId(payload.conversationId);
        }
      }
      // pick up auto-generated titles and reordering after the turn
      void refreshSidebar();
      window.setTimeout(() => void refreshSidebar(), 6_000);
    } catch {
      setMessages((current) =>
        current.map((message) =>
          message.id === draftId
            ? { ...message, content: "我这边刚才没连上。等你把服务和数据库都启动好，我们再继续。" }
            : message,
        ),
      );
    } finally {
      setIsStreaming(false);
    }
  }

  const sidebar = (
    <ChatSidebar
      conversations={conversations}
      projects={projects}
      activeConversationId={activeConversationId}
      onSelectConversation={selectConversation}
      onNewChat={newChat}
      onCreateProject={createProject}
      onRenameConversation={renameConversation}
      onTogglePin={togglePin}
      onMoveToProject={moveToProject}
      onDeleteConversation={deleteConversation}
      onRenameProject={renameProject}
      onDeleteProject={deleteProject}
    />
  );

  return (
    <main className="app-shell">
      {sidebar}

      {mobileSidebarOpen ? (
        <div className="mobile-sidebar-overlay">
          <div className="mobile-sidebar-panel">
            <button
              className="icon-button mobile-sidebar-close"
              type="button"
              aria-label="关闭会话列表"
              onClick={() => setMobileSidebarOpen(false)}
            >
              <X size={18} />
            </button>
            {sidebar}
          </div>
          <button className="mobile-sidebar-backdrop" type="button" aria-label="关闭" onClick={() => setMobileSidebarOpen(false)} />
        </div>
      ) : null}

      <section className="chat-stage">
        <header className="mobile-header">
          <button className="icon-button" type="button" aria-label="打开会话列表" onClick={() => setMobileSidebarOpen(true)}>
            <Menu size={18} />
          </button>
          <strong>{activeConversation?.title ?? "DigitalMate"}</strong>
          <div className="mobile-header-actions">
            <button className="icon-button" type="button" aria-label="新建会话" onClick={() => newChat()}>
              <SquarePen size={17} />
            </button>
            <Link href="/admin" aria-label="打开后台">
              <Settings size={18} />
            </Link>
          </div>
        </header>

        {activeConversation ? (
          <header className="chat-header">
            <strong>{activeConversation.title}</strong>
          </header>
        ) : (
          <div />
        )}

        <div className="messages">
          {setupNotice ? <div className="setup-notice">{setupNotice}</div> : null}
          {messages.length === 0 ? (
            <div className="empty-state">
              <p>今天想聊点什么？</p>
              <span>我在这儿，慢慢说。</span>
            </div>
          ) : null}
          {messages.map((message) => (
            <MessageBubble key={message.id} role={message.role} content={message.content} />
          ))}
          {isStreaming ? <TypingDots /> : null}
          <div ref={scrollRef} />
        </div>

        <ChatInput disabled={Boolean(setupNotice) || isStreaming} onSubmit={sendMessage} />
      </section>
    </main>
  );
}

async function* readSse(stream: ReadableStream<Uint8Array>): AsyncIterable<SsePayload> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const event of events) {
      const line = event.split("\n").find((item) => item.startsWith("data: "));
      if (!line) continue;
      yield JSON.parse(line.slice(6)) as SsePayload;
    }
  }
}

function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const seen = new Set(current.map((message) => message.id));
  const next = [...current];
  for (const message of incoming) {
    if (!seen.has(message.id)) next.push(message);
  }
  return next;
}
