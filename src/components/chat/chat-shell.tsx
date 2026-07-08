"use client";

import Link from "next/link";
import { Settings } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChatInput } from "@/components/chat/chat-input";
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
  setupNotice,
}: {
  conversationId?: string;
  initialMessages: ChatMessage[];
  setupNotice?: string;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [activeConversationId, setActiveConversationId] = useState(conversationId);
  const [isStreaming, setIsStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const latestMessageTime = useMemo(() => messages.at(-1)?.createdAt ?? new Date(0).toISOString(), [messages]);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isStreaming]);

  useEffect(() => {
    if (!activeConversationId) return;
    const timer = window.setInterval(async () => {
      const response = await fetch(`/api/messages?after=${encodeURIComponent(latestMessageTime)}`);
      if (!response.ok) return;
      const data = (await response.json()) as { messages?: ChatMessage[] };
      if (!data.messages?.length) return;
      setMessages((current) => mergeMessages(current, data.messages ?? []));
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [activeConversationId, latestMessageTime]);

  async function sendMessage(content: string) {
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
        body: JSON.stringify({ message: content, conversationId: activeConversationId }),
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

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">DigitalMate</p>
          <h1>数字伙伴</h1>
        </div>
        <nav className="side-nav">
          <Link href="/" className="active">
            当前对话
          </Link>
          <Link href="/admin">
            <Settings size={16} />
            后台
          </Link>
        </nav>
      </aside>

      <section className="chat-stage">
        <header className="mobile-header">
          <strong>DigitalMate</strong>
          <Link href="/admin" aria-label="打开后台">
            <Settings size={18} />
          </Link>
        </header>

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
