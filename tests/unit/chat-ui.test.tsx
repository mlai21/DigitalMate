import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeMessages, type ChatMessage } from "@/components/chat/chat-shell";
import { ChatInput, filterSkillOptions } from "@/components/chat/chat-input";
import { MessageBubble } from "@/components/chat/message-bubble";
import { useChatScroll } from "@/components/chat/use-chat-scroll";

describe("useChatScroll", () => {
  let scrollIntoView: ReturnType<typeof vi.fn>;
  let animationFrames: Map<number, FrameRequestCallback>;
  let nextAnimationFrameId: number;

  beforeEach(() => {
    scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    animationFrames = new Map();
    nextAnimationFrameId = 1;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        const id = nextAnimationFrameId++;
        animationFrames.set(id, callback);
        return id;
      }),
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      vi.fn((id: number) => {
        animationFrames.delete(id);
      }),
    );
  });

  afterEach(() => {
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    vi.unstubAllGlobals();
  });

  function flushAnimationFrames() {
    const pending = [...animationFrames.values()];
    animationFrames.clear();
    act(() => {
      pending.forEach((callback) => callback(0));
    });
  }

  function setScrollMetrics(
    element: HTMLElement,
    metrics: { scrollHeight: number; scrollTop: number; clientHeight: number },
  ) {
    for (const [key, value] of Object.entries(metrics)) {
      Object.defineProperty(element, key, { configurable: true, value });
    }
  }

  it("首次挂载时无动画定位到底部且没有未读消息", () => {
    render(<ChatScrollHarness conversationId="conversation-a" messageIds={["history-1"]} />);

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "end" });
    expect(screen.getByTestId("unread-count")).toHaveTextContent("0");
  });

  it("离开底部后只按新增消息 ID 累计未读且不自动滚动", () => {
    const { rerender } = render(
      <ChatScrollHarness conversationId="conversation-a" messageIds={["history-1"]} />,
    );
    const container = screen.getByTestId("scroll-container");
    setScrollMetrics(container, { scrollHeight: 1_000, scrollTop: 0, clientHeight: 500 });
    fireEvent.scroll(container);
    scrollIntoView.mockClear();

    rerender(
      <ChatScrollHarness conversationId="conversation-a" messageIds={["history-1", "new-1"]} />,
    );
    expect(screen.getByTestId("unread-count")).toHaveTextContent("1");
    expect(scrollIntoView).not.toHaveBeenCalled();

    rerender(
      <ChatScrollHarness conversationId="conversation-a" messageIds={["history-1", "new-1"]} />,
    );
    expect(screen.getByTestId("unread-count")).toHaveTextContent("1");
    expect(scrollIntoView).not.toHaveBeenCalled();

    rerender(
      <ChatScrollHarness
        conversationId="conversation-a"
        messageIds={["history-1", "new-1", "new-2"]}
      />,
    );
    expect(screen.getByTestId("unread-count")).toHaveTextContent("2");
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("点击到最新时平滑滚动、清空未读并恢复跟随", () => {
    const { rerender } = render(
      <ChatScrollHarness conversationId="conversation-a" messageIds={["history-1"]} />,
    );
    const container = screen.getByTestId("scroll-container");
    setScrollMetrics(container, { scrollHeight: 1_000, scrollTop: 0, clientHeight: 500 });
    fireEvent.scroll(container);
    rerender(
      <ChatScrollHarness conversationId="conversation-a" messageIds={["history-1", "new-1"]} />,
    );
    scrollIntoView.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "到最新" }));

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "end" });
    expect(screen.getByTestId("unread-count")).toHaveTextContent("0");

    scrollIntoView.mockClear();
    rerender(
      <ChatScrollHarness
        conversationId="conversation-a"
        messageIds={["history-1", "new-1", "new-2"]}
      />,
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
    flushAnimationFrames();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("unread-count")).toHaveTextContent("0");
  });

  it("用户手动滚回底部附近时清空未读并恢复跟随", () => {
    const { rerender } = render(
      <ChatScrollHarness conversationId="conversation-a" messageIds={["history-1"]} />,
    );
    const container = screen.getByTestId("scroll-container");
    setScrollMetrics(container, { scrollHeight: 1_000, scrollTop: 0, clientHeight: 500 });
    fireEvent.scroll(container);
    rerender(
      <ChatScrollHarness conversationId="conversation-a" messageIds={["history-1", "new-1"]} />,
    );
    expect(screen.getByTestId("unread-count")).toHaveTextContent("1");

    setScrollMetrics(container, { scrollHeight: 1_000, scrollTop: 420, clientHeight: 500 });
    fireEvent.scroll(container);
    expect(screen.getByTestId("unread-count")).toHaveTextContent("0");

    scrollIntoView.mockClear();
    rerender(
      <ChatScrollHarness
        conversationId="conversation-a"
        messageIds={["history-1", "new-1", "new-2"]}
      />,
    );
    flushAnimationFrames();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("unread-count")).toHaveTextContent("0");
  });

  it("切换会话时重置状态、记录已有消息并无动画定位到底部", () => {
    const { rerender } = render(
      <ChatScrollHarness conversationId="conversation-a" messageIds={["a-history"]} />,
    );
    const container = screen.getByTestId("scroll-container");
    setScrollMetrics(container, { scrollHeight: 1_000, scrollTop: 0, clientHeight: 500 });
    fireEvent.scroll(container);
    rerender(
      <ChatScrollHarness conversationId="conversation-a" messageIds={["a-history", "a-new"]} />,
    );
    expect(screen.getByTestId("unread-count")).toHaveTextContent("1");
    scrollIntoView.mockClear();

    rerender(<ChatScrollHarness conversationId="conversation-b" messageIds={["b-history"]} />);

    expect(screen.getByTestId("unread-count")).toHaveTextContent("0");
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "end" });

    setScrollMetrics(container, { scrollHeight: 1_000, scrollTop: 0, clientHeight: 500 });
    fireEvent.scroll(container);
    rerender(<ChatScrollHarness conversationId="conversation-b" messageIds={["b-history"]} />);
    expect(screen.getByTestId("unread-count")).toHaveTextContent("0");
    rerender(
      <ChatScrollHarness conversationId="conversation-b" messageIds={["b-history", "b-new"]} />,
    );
    expect(screen.getByTestId("unread-count")).toHaveTextContent("1");
  });

  it("位于底部附近时在动画帧中持续跟随消息变化且不累计未读", () => {
    const { rerender } = render(
      <ChatScrollHarness conversationId="conversation-a" messageIds={["streaming-1"]} />,
    );
    scrollIntoView.mockClear();

    rerender(<ChatScrollHarness conversationId="conversation-a" messageIds={["streaming-1"]} />);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).not.toHaveBeenCalled();
    flushAnimationFrames();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("unread-count")).toHaveTextContent("0");

    scrollIntoView.mockClear();
    rerender(
      <ChatScrollHarness conversationId="conversation-a" messageIds={["streaming-1", "new-1"]} />,
    );
    flushAnimationFrames();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("unread-count")).toHaveTextContent("0");
  });
});

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
  it("requires an explicit per-message toggle for web search and resets it after sending", () => {
    const onSubmit = vi.fn();
    render(<ChatInput onSubmit={onSubmit} />);

    const searchButton = screen.getByRole("button", { name: "开启联网搜索" });
    expect(searchButton).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(searchButton);
    expect(screen.getByRole("button", { name: "关闭联网搜索" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("搜索")).toBeInTheDocument();

    const textarea = screen.getByRole("textbox", { name: "输入消息" }) as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "查查今天有什么新消息" } });
    fireEvent.submit(textarea.closest("form")!);

    expect(onSubmit).toHaveBeenCalledWith("查查今天有什么新消息", { searchEnabled: true });
    expect(screen.getByRole("button", { name: "开启联网搜索" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText("搜索")).toBeNull();
  });

  it("resets the search toggle when the active conversation changes", () => {
    const onSubmit = vi.fn();
    const { rerender } = render(<ChatInput key="conversation-a" onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("button", { name: "开启联网搜索" }));
    expect(screen.getByRole("button", { name: "关闭联网搜索" })).toHaveAttribute("aria-pressed", "true");

    rerender(<ChatInput key="conversation-b" onSubmit={onSubmit} />);

    expect(screen.getByRole("button", { name: "开启联网搜索" })).toHaveAttribute("aria-pressed", "false");
  });

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

describe("ChatInput skill picker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubSkillsApi() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          skills: [{ id: "00000000-0000-4000-8000-000000000001", name: "周报整理", trigger: "整理周报" }],
        }),
      })),
    );
  }

  it("opens the picker on '/' and submits the selected skill as structured skillIds", async () => {
    stubSkillsApi();
    const onSubmit = vi.fn();
    render(<ChatInput onSubmit={onSubmit} />);

    const textarea = screen.getByRole("textbox", { name: "输入消息" }) as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "/" } });

    const option = await screen.findByText("周报整理");
    expect(screen.getByText("/create-skill")).toBeInTheDocument();

    fireEvent.mouseDown(option);

    // picking a skill turns it into a removable card and clears the slash query
    expect(textarea.value).toBe("");
    expect(screen.getByLabelText("移除 Skill 周报整理")).toBeInTheDocument();

    fireEvent.input(textarea, { target: { value: "帮我整理这周的更新" } });
    fireEvent.submit(textarea.closest("form")!);

    expect(onSubmit).toHaveBeenCalledWith("帮我整理这周的更新", {
      skillIds: ["00000000-0000-4000-8000-000000000001"],
    });
    expect(screen.queryByLabelText("移除 Skill 周报整理")).toBeNull();
  });

  it("inserts the /create-skill command when the create entry is picked", async () => {
    stubSkillsApi();
    render(<ChatInput onSubmit={vi.fn()} />);

    const textarea = screen.getByRole("textbox", { name: "输入消息" }) as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "/" } });

    fireEvent.mouseDown(await screen.findByText("/create-skill"));

    expect(textarea.value).toBe("/create-skill ");
  });

  it("does not open the picker for plain text", () => {
    stubSkillsApi();
    render(<ChatInput onSubmit={vi.fn()} />);

    const textarea = screen.getByRole("textbox", { name: "输入消息" }) as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "随便聊聊" } });

    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("filterSkillOptions", () => {
  const options = [
    { id: "1", name: "周报整理", trigger: "整理周报" },
    { id: "2", name: "nuwa", trigger: "蒸馏思维方式" },
  ];

  it("matches by name or trigger, case-insensitively", () => {
    expect(filterSkillOptions(options, "周报").map((option) => option.id)).toEqual(["1"]);
    expect(filterSkillOptions(options, "NUWA").map((option) => option.id)).toEqual(["2"]);
    expect(filterSkillOptions(options, "思维").map((option) => option.id)).toEqual(["2"]);
    expect(filterSkillOptions(options, "")).toHaveLength(2);
    expect(filterSkillOptions(options, "没有的")).toHaveLength(0);
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

function ChatScrollHarness({
  conversationId,
  messageIds,
}: {
  conversationId?: string;
  messageIds: string[];
}) {
  const { containerRef, endRef, unreadCount, jumpToLatest } = useChatScroll({
    conversationId,
    messageIds,
  });

  return (
    <div ref={containerRef} data-testid="scroll-container">
      <span data-testid="unread-count">{unreadCount}</span>
      <button type="button" onClick={jumpToLatest}>
        到最新
      </button>
      <div ref={endRef} />
    </div>
  );
}
