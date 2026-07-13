"use client";

import Link from "next/link";
import { Menu, Settings, SquarePen, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatInput, type ChatInputSubmitOptions } from "@/components/chat/chat-input";
import { ChatSidebar, type ConversationItem, type ProjectItem } from "@/components/chat/chat-sidebar";
import { MessageBubble } from "@/components/chat/message-bubble";
import { TypingDots } from "@/components/chat/typing-dots";
import { useChatScroll } from "@/components/chat/use-chat-scroll";
import type { ChatAttachment } from "@/server/attachments/types";

export type ChatMessage = {
  id: string;
  uiId?: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  attachments?: ChatAttachment[];
};

type SsePayload =
  | { type: "accepted"; conversationId: string; clientTurnId: string; userMessageId: string }
  | { type: "chunk"; content: string }
  | { type: "replace"; content: string }
  | {
      type: "done";
      conversationId: string;
      clientTurnId: string;
      userMessageId: string;
      assistantMessageId?: string;
      degraded?: boolean;
    }
  | { type: "error"; message: string };

export function ChatShell({
  conversationId,
  initialMessages,
  initialConversations = [],
  initialProjects = [],
  setupNotice,
  loginRequired = false,
}: {
  conversationId?: string;
  initialMessages: ChatMessage[];
  initialConversations?: ConversationItem[];
  initialProjects?: ProjectItem[];
  setupNotice?: string;
  loginRequired?: boolean;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [conversations, setConversations] = useState<ConversationItem[]>(initialConversations);
  const [projects, setProjects] = useState<ProjectItem[]>(initialProjects);
  const [activeConversationId, setActiveConversationId] = useState(conversationId);
  const [streamingConversationIds, setStreamingConversationIds] = useState<Set<string>>(() => new Set());
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [inputShellNode, setInputShellNode] = useState<HTMLFormElement | null>(null);
  const [composerVersion, setComposerVersion] = useState(0);
  const stageRef = useRef<HTMLElement>(null);
  const activeConversationIdRef = useRef(conversationId);
  const inputShellRef = useCallback((node: HTMLFormElement | null) => setInputShellNode(node), []);
  const messageIds = useMemo(() => messages.map(getChatMessageUiId), [messages]);
  const chatScroll = useChatScroll({ conversationId: activeConversationId, messageIds });
  const { containerRef, endRef, unreadCount, jumpToLatest } = chatScroll;
  const latestMessageTime = useMemo(() => messages.at(-1)?.createdAt ?? new Date(0).toISOString(), [messages]);
  const isActiveConversationStreaming = Boolean(
    activeConversationId && streamingConversationIds.has(activeConversationId),
  );

  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId);

  function activateConversation(nextConversationId: string | undefined) {
    activeConversationIdRef.current = nextConversationId;
    setActiveConversationId(nextConversationId);
  }

  function updateActiveConversationMessages(
    targetConversationId: string,
    update: (current: ChatMessage[]) => ChatMessage[],
  ) {
    if (activeConversationIdRef.current !== targetConversationId) return;
    setMessages((current) =>
      activeConversationIdRef.current === targetConversationId ? update(current) : current,
    );
  }

  useEffect(() => {
    const stage = stageRef.current;
    const input = inputShellNode;
    if (!stage || !input) return;

    const updateInputClearance = () => {
      const inputBox = input.getBoundingClientRect();
      const bottom = Number.parseFloat(window.getComputedStyle(input).bottom);
      const bottomOffset = Number.isFinite(bottom) ? bottom : 0;
      stage.style.setProperty("--chat-input-clearance", `${Math.ceil(inputBox.height + bottomOffset + 24)}px`);
    };

    updateInputClearance();
    const observer = "ResizeObserver" in window ? new ResizeObserver(updateInputClearance) : undefined;
    observer?.observe(input);
    window.addEventListener("resize", updateInputClearance);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateInputClearance);
    };
  }, [inputShellNode]);

  useEffect(() => {
    if (!activeConversationId) return;
    const pollingConversationId = activeConversationId;
    const timer = window.setInterval(async () => {
      const response = await fetch(
        `/api/messages?conversationId=${pollingConversationId}&after=${encodeURIComponent(latestMessageTime)}`,
      );
      if (!response.ok) return;
      const data = (await response.json()) as { messages?: ChatMessage[] };
      if (!data.messages?.length) return;
      updateActiveConversationMessages(
        pollingConversationId,
        (current) => mergeMessages(current, data.messages ?? []),
      );
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
    activateConversation(id);
    setComposerVersion((version) => version + 1);
    setMobileSidebarOpen(false);
    setMessages([]);
    try {
      const response = await fetch(`/api/conversations/${id}/messages`);
      if (!response.ok) return;
      const data = (await response.json()) as { messages?: ChatMessage[] };
      updateActiveConversationMessages(id, () => data.messages ?? []);
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
      activateConversation(data.conversation.id);
      setMessages([]);
      setComposerVersion((version) => version + 1);
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
        activateConversation(undefined);
        setMessages([]);
        setComposerVersion((version) => version + 1);
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

  async function sendMessage(content: string, options: ChatInputSubmitOptions): Promise<boolean> {
    const activeConversationIdAtSubmit = activeConversationIdRef.current;
    let targetConversationId = activeConversationIdAtSubmit;
    if (!targetConversationId) {
      try {
        const response = await fetch("/api/conversations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        if (!response.ok) return false;
        const data = (await response.json()) as { conversation: ConversationItem };
        targetConversationId = data.conversation.id;
        setConversations((current) => [data.conversation, ...current]);
        if (activeConversationIdRef.current === activeConversationIdAtSubmit) {
          activateConversation(targetConversationId);
        }
      } catch {
        return false;
      }
    }
    const turnConversationId = targetConversationId;

    const now = new Date().toISOString();
    const clientTurnId = options.clientTurnId;
    const userMessage: ChatMessage = {
      id: `local-user-${clientTurnId}`,
      role: "user",
      content,
      createdAt: now,
      ...(options.attachments?.length ? { attachments: options.attachments } : {}),
    };
    const draftId = `assistant-${clientTurnId}`;
    updateActiveConversationMessages(turnConversationId, (current) => [
      ...current,
      userMessage,
      { id: draftId, role: "assistant", content: "", createdAt: now },
    ]);
    setStreamingConversationIds((current) => {
      const next = new Set(current);
      next.add(turnConversationId);
      return next;
    });

    let completed = false;
    let accepted = false;
    let assistantMessageId: string | undefined;
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: content,
          conversationId: turnConversationId,
          clientTurnId,
          ...(options.attachmentIds?.length ? { attachmentIds: options.attachmentIds } : {}),
          ...(options.skillIds?.length ? { skillIds: options.skillIds } : {}),
          ...(options.searchEnabled ? { searchEnabled: true } : {}),
        }),
      });
      if (!response.ok) throw new ChatSubmitError(await readChatError(response));
      if (!response.body) throw new ChatSubmitError("回复暂时没有送达，请稍后重试。");

      for await (const payload of readSse(response.body)) {
        if (payload.type === "accepted") {
          accepted = true;
          updateActiveConversationMessages(turnConversationId, (current) => reconcileOptimisticMessageId(
            current,
            userMessage.id,
            payload.userMessageId,
            (message) => ({
              ...message,
              attachments: message.attachments?.map((attachment) => ({ ...attachment, status: "bound" })),
            }),
          ));
        }
        if (payload.type === "chunk") {
          updateActiveConversationMessages(turnConversationId, (current) =>
            current.map((message) =>
              getChatMessageUiId(message) === draftId
                ? { ...message, content: `${message.content}${payload.content}` }
                : message,
            ),
          );
        }
        if (payload.type === "replace") {
          updateActiveConversationMessages(turnConversationId, (current) => current.map((message) =>
            getChatMessageUiId(message) === draftId
              ? { ...message, content: payload.content }
              : message,
          ));
        }
        if (payload.type === "done") {
          completed = true;
          assistantMessageId = payload.assistantMessageId;
          if (payload.assistantMessageId) {
            const persistedAssistantId = payload.assistantMessageId;
            updateActiveConversationMessages(turnConversationId, (current) => reconcileOptimisticMessageId(
              current,
              draftId,
              persistedAssistantId,
              (message) => message,
            ));
          }
        }
        if (payload.type === "error") throw new ChatSubmitError(payload.message);
      }
      if (!accepted) throw new ChatSubmitError("回复暂时没有送达，请稍后重试。");
      if (!completed || !assistantMessageId) {
        await reconcileAcceptedTurn(turnConversationId, draftId);
      }
      // pick up auto-generated titles and reordering after the turn
      void refreshSidebar();
      window.setTimeout(() => void refreshSidebar(), 6_000);
      return true;
    } catch {
      if (accepted) {
        await reconcileAcceptedTurn(turnConversationId, draftId);
        void refreshSidebar();
        window.setTimeout(() => void refreshSidebar(), 6_000);
        return true;
      }
      updateActiveConversationMessages(turnConversationId, (current) => current.filter((message) => {
        const uiId = getChatMessageUiId(message);
        return uiId !== userMessage.id && uiId !== draftId;
      }));
      return false;
    } finally {
      setStreamingConversationIds((current) => {
        const next = new Set(current);
        next.delete(turnConversationId);
        return next;
      });
    }

    async function reconcileAcceptedTurn(
      targetConversationId: string,
      assistantDraftId: string,
    ) {
      updateActiveConversationMessages(
        targetConversationId,
        (current) => current.filter((message) => getChatMessageUiId(message) !== assistantDraftId),
      );
      try {
        const response = await fetch(`/api/conversations/${targetConversationId}/messages`);
        if (!response.ok) return;
        const data = (await response.json()) as { messages?: ChatMessage[] };
        updateActiveConversationMessages(
          targetConversationId,
          (current) => mergeMessages(current, data.messages ?? []),
        );
      } catch {
        // Polling will retry reconciliation without resubmitting the accepted turn.
      }
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

      <section ref={stageRef} className="chat-stage">
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

        <div ref={containerRef} className="messages">
          {setupNotice ? (
            <div className="setup-notice">
              <span>{setupNotice}</span>
              {loginRequired ? (
                <Link className="setup-notice-action" href="/login">
                  去登录
                </Link>
              ) : null}
            </div>
          ) : null}
          {messages.length === 0 ? (
            <div className="empty-state">
              <p>今天想聊点什么？</p>
              <span>我在这儿，慢慢说。</span>
            </div>
          ) : null}
          {messages.map((message) => (
            <MessageBubble
              key={getChatMessageUiId(message)}
              role={message.role}
              content={message.content}
              attachments={message.attachments}
            />
          ))}
          {isActiveConversationStreaming ? <TypingDots /> : null}
          <div ref={endRef} className="chat-scroll-anchor" aria-hidden="true" />
        </div>

        <div className="chat-new-message-status" role="status" aria-live="polite" aria-atomic="true">
          {unreadCount > 0 ? `${unreadCount} 条新消息` : ""}
        </div>

        {unreadCount > 0 ? (
          <button
            className="new-message-button"
            type="button"
            aria-label={`查看 ${unreadCount} 条新消息`}
            onClick={jumpToLatest}
          >
            ↓ {unreadCount} 条新消息
          </button>
        ) : null}

        <ChatInput
          key={`composer-${composerVersion}`}
          shellRef={inputShellRef}
          disabled={Boolean(setupNotice) || isActiveConversationStreaming}
          onSubmit={sendMessage}
        />
      </section>
    </main>
  );
}

class ChatSubmitError extends Error {}

async function readChatError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { message?: unknown };
    if (typeof data.message === "string" && data.message.trim()) return data.message;
  } catch {
    // Fall through to the stable user-facing message.
  }
  return "消息发送失败，请稍后重试。";
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

export function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const next = dedupeMessagesById(current);
  const seen = new Set(next.map((message) => message.id));
  for (const message of incoming) {
    if (seen.has(message.id)) continue;
    const optimisticIndex = next.findIndex((candidate) => isMatchingOptimisticMessage(candidate, message));
    if (optimisticIndex >= 0) {
      const candidate = next[optimisticIndex];
      seen.delete(candidate.id);
      next[optimisticIndex] = { ...message, uiId: getChatMessageUiId(candidate) };
      seen.add(message.id);
      continue;
    }
    next.push(message);
    seen.add(message.id);
  }
  return next;
}

function reconcileOptimisticMessageId(
  current: ChatMessage[],
  optimisticUiId: string,
  persistedId: string,
  update: (message: ChatMessage) => ChatMessage,
): ChatMessage[] {
  const optimistic = current.find((message) => getChatMessageUiId(message) === optimisticUiId);
  const stableUiId = optimistic ? getChatMessageUiId(optimistic) : optimisticUiId;
  const reconciled = current.map((message) => {
    if (getChatMessageUiId(message) !== optimisticUiId && message.id !== persistedId) return message;
    return update({ ...message, id: persistedId, uiId: stableUiId });
  });
  return dedupeMessagesById(reconciled);
}

function dedupeMessagesById(messages: ChatMessage[]): ChatMessage[] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

function getChatMessageUiId(message: ChatMessage): string {
  return message.uiId ?? message.id;
}

function isMatchingOptimisticMessage(candidate: ChatMessage, persisted: ChatMessage): boolean {
  if (!isOptimisticMessage(candidate)) return false;
  return candidate.role === persisted.role && candidate.content === persisted.content;
}

function isOptimisticMessage(message: ChatMessage): boolean {
  if (message.role === "user") return message.id.startsWith("local-user-");
  return message.id.startsWith("assistant-");
}
