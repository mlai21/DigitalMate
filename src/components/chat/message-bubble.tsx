import { sanitizeAssistantText } from "@/server/agent/streaming";

export type MessageBubbleProps = {
  role: "user" | "assistant";
  content: string;
};

export function MessageBubble({ role, content }: MessageBubbleProps) {
  const visibleContent = role === "assistant" ? sanitizeAssistantText(content) : content;

  if (role === "assistant" && visibleContent.trim().length === 0) return null;

  return (
    <div className={`message-row ${role === "user" ? "message-row-user" : "message-row-assistant"}`}>
      {role === "assistant" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="mate-avatar" src="/mate-avatar.png" alt="" aria-hidden="true" />
      ) : null}
      <div className={`message-bubble ${role === "user" ? "message-bubble-user" : "message-bubble-assistant"}`}>
        {visibleContent}
      </div>
    </div>
  );
}
