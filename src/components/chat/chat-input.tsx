"use client";

import { Send } from "lucide-react";
import { FormEvent, useRef } from "react";

export function ChatInput({
  disabled,
  onSubmit,
}: {
  disabled?: boolean;
  onSubmit: (value: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = ref.current?.value.trim() ?? "";
    if (!value || disabled) return;
    onSubmit(value);
    if (ref.current) ref.current.value = "";
  }

  return (
    <form className="chat-input-shell" onSubmit={submit}>
      <textarea
        ref={ref}
        aria-label="输入消息"
        placeholder="今天想聊点什么？"
        rows={1}
        disabled={disabled}
        onInput={(event) => {
          const element = event.currentTarget;
          element.style.height = "auto";
          element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
        }}
      />
      <button className="send-button" type="submit" disabled={disabled} aria-label="发送">
        <Send size={18} strokeWidth={2.2} />
      </button>
    </form>
  );
}
