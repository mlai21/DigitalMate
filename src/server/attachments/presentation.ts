import type { ChatAttachment } from "@/server/attachments/types";
import type { DbMessageAttachment } from "@/server/db/repositories";

type ChatMessageSource = {
  id: string;
  role: string;
  content: string;
  createdAt: Date;
};

export type PublicChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  attachments: ChatAttachment[];
};

type ListForMessages = (
  userId: string,
  messageIds: string[],
) => Promise<DbMessageAttachment[]>;

export function toChatAttachment(
  userId: string,
  attachment: DbMessageAttachment,
): ChatAttachment | null {
  if (
    attachment.userId !== userId
    || attachment.status !== "bound"
    || !attachment.messageId
  ) return null;

  return {
    id: attachment.id,
    kind: attachment.kind,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    status: attachment.status,
    downloadUrl: `/api/chat/attachments/${attachment.id}/download`,
  };
}

export async function serializeChatMessages(
  userId: string,
  messages: ChatMessageSource[],
  listForMessages: ListForMessages,
): Promise<PublicChatMessage[]> {
  const publicMessages: Array<Omit<PublicChatMessage, "attachments">> = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    publicMessages.push({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt.toISOString(),
    });
  }
  if (publicMessages.length === 0) return [];

  const messageIds = publicMessages.map((message) => message.id);
  const allowedMessageIds = new Set(messageIds);
  const attachments = await listForMessages(userId, messageIds);
  const byMessageId = new Map<string, ChatAttachment[]>();

  for (const attachment of attachments) {
    if (!attachment.messageId || !allowedMessageIds.has(attachment.messageId)) continue;
    const chatAttachment = toChatAttachment(userId, attachment);
    if (!chatAttachment) continue;
    const list = byMessageId.get(attachment.messageId) ?? [];
    list.push(chatAttachment);
    byMessageId.set(attachment.messageId, list);
  }

  return publicMessages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    attachments: byMessageId.get(message.id) ?? [],
  }));
}
