import type { ChatAttachment } from "@/server/attachments/types";
import type { DbMessageAttachment } from "@/server/db/repositories";

type MessageWithId = { id: string };

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

export async function withChatAttachments<T extends MessageWithId>(
  userId: string,
  messages: T[],
  listForMessages: ListForMessages,
): Promise<Array<T & { attachments: ChatAttachment[] }>> {
  if (messages.length === 0) return [];

  const messageIds = messages.map((message) => message.id);
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

  return messages.map((message) => ({
    ...message,
    attachments: byMessageId.get(message.id) ?? [],
  }));
}
