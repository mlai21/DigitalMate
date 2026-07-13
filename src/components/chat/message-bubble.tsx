import { FileText } from "lucide-react";
import { sanitizeAssistantText } from "@/server/agent/streaming";
import type { ChatAttachment } from "@/server/attachments/types";

export type MessageBubbleProps = {
  role: "user" | "assistant";
  content: string;
  attachments?: ChatAttachment[];
};

export function MessageBubble({ role, content, attachments = [] }: MessageBubbleProps) {
  const visibleContent = role === "assistant" ? sanitizeAssistantText(content) : content;

  if (role === "assistant" && visibleContent.trim().length === 0 && attachments.length === 0) return null;

  return (
    <div className={`message-row ${role === "user" ? "message-row-user" : "message-row-assistant"}`}>
      {role === "assistant" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="mate-avatar" src="/mate-avatar.png" alt="" aria-hidden="true" />
      ) : null}
      <div className={`message-bubble ${role === "user" ? "message-bubble-user" : "message-bubble-assistant"}`}>
        {visibleContent ? <div className="message-text">{visibleContent}</div> : null}
        {attachments.length > 0 ? (
          <div className="message-attachment-list">
            {attachments.map((attachment) => {
              const downloadUrl = attachment.downloadUrl ?? `/api/chat/attachments/${attachment.id}/download`;
              return (
                <a
                  key={attachment.id}
                  className="message-attachment-card"
                  href={downloadUrl}
                  {...(attachment.kind === "image"
                    ? { target: "_blank", rel: "noopener" }
                    : { download: attachment.fileName })}
                >
                  {attachment.kind === "image" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      className="message-attachment-image"
                      src={downloadUrl}
                      alt={attachment.fileName}
                    />
                  ) : (
                    <span className="message-attachment-icon" aria-hidden="true">
                      <FileText size={22} />
                    </span>
                  )}
                  <span className="message-attachment-copy">
                    <span className="message-attachment-name">{attachment.fileName}</span>
                    <span className="message-attachment-meta">{formatFileSize(attachment.sizeBytes)}</span>
                  </span>
                </a>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${Math.ceil(sizeBytes / 1024)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}
