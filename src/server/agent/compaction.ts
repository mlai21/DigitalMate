import type { DbMessage } from "@/server/db/repositories";

export type CompactionMessage = Pick<DbMessage, "id" | "role" | "content" | "createdAt">;

export function shouldCompactConversation(
  messages: CompactionMessage[],
  options: { threshold?: number } = {},
): boolean {
  return messages.length > (options.threshold ?? 40);
}

export function buildConversationSummary(
  messages: CompactionMessage[],
  options: { keepRecent?: number } = {},
): { text: string; messageCount: number } {
  const keepRecent = options.keepRecent ?? 12;
  const compacted = messages.slice(0, Math.max(0, messages.length - keepRecent));
  const lines = compacted
    .slice(-24)
    .map((message) => `${message.role === "user" ? "用户" : "助手"}：${message.content.slice(0, 160)}`);

  return {
    messageCount: compacted.length,
    text: ["长期会话摘要（由早期消息压缩而来）：", ...lines].join("\n"),
  };
}
