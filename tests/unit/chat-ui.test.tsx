import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatInput } from "@/components/chat/chat-input";
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
});
