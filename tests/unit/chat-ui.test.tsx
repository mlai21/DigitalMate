import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeMessages, type ChatMessage } from "@/components/chat/chat-shell";
import { ChatInput, filterSkillOptions } from "@/components/chat/chat-input";
import { MessageBubble } from "@/components/chat/message-bubble";

describe("MessageBubble", () => {
  it("does not render internal tool details", () => {
    render(<MessageBubble role="assistant" content='{"tool_call":"web_search"}最后结果' />);

    expect(screen.queryByText(/tool_call/)).toBeNull();
    expect(screen.getByText(/最后结果/)).toBeInTheDocument();
  });

  it("does not render an empty assistant bubble after private reasoning is removed", () => {
    const { container } = render(<MessageBubble role="assistant" content="<thinking>先看一下。</thinking>" />);

    expect(container.querySelector(".message-bubble-assistant")).toBeNull();
  });
});

describe("ChatInput", () => {
  it("shrinks back after a tall draft is sent", () => {
    const onSubmit = vi.fn();
    render(<ChatInput onSubmit={onSubmit} />);

    const textarea = screen.getByRole("textbox", { name: "输入消息" }) as HTMLTextAreaElement;
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 160 });

    fireEvent.input(textarea, { target: { value: "这是一段很长的输入，发送后输入框应该回到单行高度。" } });
    expect(textarea.style.height).toBe("160px");

    fireEvent.submit(textarea.closest("form")!);

    expect(onSubmit).toHaveBeenCalledWith("这是一段很长的输入，发送后输入框应该回到单行高度。");
    expect(textarea.value).toBe("");
    expect(textarea.style.height).toBe("");
  });

  it("submits when Enter is pressed without Shift", () => {
    const onSubmit = vi.fn();
    render(<ChatInput onSubmit={onSubmit} />);

    const textarea = screen.getByRole("textbox", { name: "输入消息" }) as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "回车发送" } });

    const eventWasNotPrevented = fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });

    expect(eventWasNotPrevented).toBe(false);
    expect(onSubmit).toHaveBeenCalledWith("回车发送");
    expect(textarea.value).toBe("");
  });

  it("keeps Shift Enter available for line breaks", () => {
    const onSubmit = vi.fn();
    render(<ChatInput onSubmit={onSubmit} />);

    const textarea = screen.getByRole("textbox", { name: "输入消息" }) as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "第一行" } });

    const eventWasNotPrevented = fireEvent.keyDown(textarea, { key: "Enter", code: "Enter", shiftKey: true });

    expect(eventWasNotPrevented).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(textarea.value).toBe("第一行");
  });
});

describe("mergeMessages", () => {
  it("replaces optimistic turn messages when polling returns persisted messages", () => {
    const optimisticTime = "2026-07-09T04:00:00.000Z";
    const current: ChatMessage[] = [
      message("m-prev", "assistant", "之前的消息", "2026-07-09T03:59:00.000Z"),
      message(`local-user-${optimisticTime}`, "user", "在吗", optimisticTime),
      message(`assistant-${optimisticTime}`, "assistant", "在的在的～", optimisticTime),
    ];

    const incoming: ChatMessage[] = [
      message("persisted-user", "user", "在吗", "2026-07-09T04:00:01.000Z"),
      message("persisted-assistant", "assistant", "在的在的～", "2026-07-09T04:00:02.000Z"),
    ];

    expect(mergeMessages(current, incoming)).toEqual([
      message("m-prev", "assistant", "之前的消息", "2026-07-09T03:59:00.000Z"),
      message("persisted-user", "user", "在吗", "2026-07-09T04:00:01.000Z"),
      message("persisted-assistant", "assistant", "在的在的～", "2026-07-09T04:00:02.000Z"),
    ]);
  });
});

function message(id: string, role: ChatMessage["role"], content: string, createdAt: string): ChatMessage {
  return { id, role, content, createdAt };
}
