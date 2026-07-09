"use client";

import { Send } from "lucide-react";
import { FormEvent, KeyboardEvent, Ref, useRef } from "react";

export function ChatInput({
  disabled,
  onSubmit,
  shellRef,
}: {
  disabled?: boolean;
  onSubmit: (value: string) => void;
  shellRef?: Ref<HTMLFormElement>;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = ref.current?.value.trim() ?? "";
    if (!value || disabled) return;
    onSubmit(value);
    if (ref.current) {
      ref.current.value = "";
      ref.current.style.height = "";
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <form ref={shellRef} className="chat-input-shell" onSubmit={submit}>
      <textarea
        ref={ref}
        aria-label="输入消息"
        placeholder="今天想聊点什么？"
        rows={1}
        disabled={disabled}
        onKeyDown={handleKeyDown}
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
