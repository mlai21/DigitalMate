import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatShell, mergeMessages, type ChatMessage } from "@/components/chat/chat-shell";
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

  it("消息再次变化时取消尚未执行的旧滚动帧", () => {
    const { rerender } = render(
      <ChatScrollHarness conversationId="conversation-a" messageIds={["streaming-1"]} />,
    );
    scrollIntoView.mockClear();

    rerender(<ChatScrollHarness conversationId="conversation-a" messageIds={["streaming-1"]} />);
    const oldFrameId = vi.mocked(requestAnimationFrame).mock.results[0]?.value;

    rerender(
      <ChatScrollHarness conversationId="conversation-a" messageIds={["streaming-1", "new-1"]} />,
    );
    const newFrameId = vi.mocked(requestAnimationFrame).mock.results[1]?.value;

    expect(oldFrameId).toBeTypeOf("number");
    expect(newFrameId).toBeTypeOf("number");
    expect(newFrameId).not.toBe(oldFrameId);
    flushAnimationFrames();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(oldFrameId);
  });

  it("用户在滚动帧执行前离开底部时取消待执行帧", () => {
    const { rerender } = render(
      <ChatScrollHarness conversationId="conversation-a" messageIds={["streaming-1"]} />,
    );
    const container = screen.getByTestId("scroll-container");
    scrollIntoView.mockClear();

    rerender(<ChatScrollHarness conversationId="conversation-a" messageIds={["streaming-1"]} />);
    const pendingFrameId = vi.mocked(requestAnimationFrame).mock.results[0]?.value;
    expect(pendingFrameId).toBeTypeOf("number");

    setScrollMetrics(container, { scrollHeight: 1_000, scrollTop: 0, clientHeight: 500 });
    fireEvent.scroll(container);
    flushAnimationFrames();

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(pendingFrameId);
  });

  it("清空未读引发内部重渲染时只执行手动平滑滚动", () => {
    const { rerender } = render(
      <FreshArrayChatScrollHarness conversationId="conversation-a" messageIds={["history-1"]} />,
    );
    const container = screen.getByTestId("scroll-container");
    setScrollMetrics(container, { scrollHeight: 1_000, scrollTop: 0, clientHeight: 500 });
    fireEvent.scroll(container);
    rerender(
      <FreshArrayChatScrollHarness
        conversationId="conversation-a"
        messageIds={["history-1", "new-1"]}
      />,
    );
    expect(screen.getByTestId("unread-count")).toHaveTextContent("1");
    scrollIntoView.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "到最新" }));
    flushAnimationFrames();

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "end" });
  });

  it("没有未读时点击到最新不会跳过下一次流式跟随", () => {
    const { rerender } = render(
      <FreshArrayChatScrollHarness conversationId="conversation-a" messageIds={["streaming-1"]} />,
    );
    scrollIntoView.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "到最新" }));
    flushAnimationFrames();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "end" });

    scrollIntoView.mockClear();
    rerender(
      <FreshArrayChatScrollHarness conversationId="conversation-a" messageIds={["streaming-1"]} />,
    );
    flushAnimationFrames();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "end" });
  });

  it("卸载时取消尚未执行的滚动帧", () => {
    const { rerender, unmount } = render(
      <ChatScrollHarness conversationId="conversation-a" messageIds={["streaming-1"]} />,
    );
    scrollIntoView.mockClear();
    rerender(<ChatScrollHarness conversationId="conversation-a" messageIds={["streaming-1"]} />);
    const pendingFrameId = vi.mocked(requestAnimationFrame).mock.results[0]?.value;
    expect(pendingFrameId).toBeTypeOf("number");

    unmount();
    flushAnimationFrames();

    expect(cancelAnimationFrame).toHaveBeenCalledWith(pendingFrameId);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

describe("ChatShell scroll behavior", () => {
  let scrollIntoView: ReturnType<typeof vi.fn>;
  let pollMessages: ChatMessage[];

  beforeEach(() => {
    vi.useFakeTimers();
    scrollIntoView = vi.fn();
    pollMessages = [
      message(
        "assistant-new",
        "assistant",
        "轮询带来的新消息",
        "2026-07-14T10:00:05.000Z",
      ),
    ];
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/messages?conversationId=conversation-a")) {
          return {
            ok: true,
            json: async () => ({ messages: pollMessages }),
          };
        }
        return { ok: true, json: async () => ({}) };
      }),
    );
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  });

  it("历史阅读位置收到轮询新消息时提示未读，点击后再平滑滚到底部", async () => {
    render(
      <ChatShell
        conversationId="conversation-a"
        initialMessages={[
          message(
            "history-1",
            "assistant",
            "已有历史消息",
            "2026-07-14T10:00:00.000Z",
          ),
        ]}
        initialConversations={[
          {
            id: "conversation-a",
            title: "测试会话",
            channel: "web",
            projectId: null,
            pinned: false,
            updatedAt: "2026-07-14T10:00:00.000Z",
            messageCount: 1,
          },
        ]}
      />,
    );
    const container = document.querySelector<HTMLElement>(".messages");
    expect(container).not.toBeNull();
    const liveStatus = screen.getByRole("status");
    expect(liveStatus).toBeEmptyDOMElement();
    setElementScrollMetrics(container!, {
      scrollHeight: 1_000,
      scrollTop: 0,
      clientHeight: 500,
    });
    fireEvent.scroll(container!);
    scrollIntoView.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(screen.getByText("轮询带来的新消息")).toBeInTheDocument();
    const newMessageButton = screen.getByRole("button", { name: "查看 1 条新消息" });
    expect(liveStatus).toHaveTextContent("1 条新消息");
    expect(container!.scrollTop).toBe(0);
    expect(scrollIntoView).not.toHaveBeenCalled();

    fireEvent.click(newMessageButton);

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "end" });
    expect(screen.queryByRole("button", { name: "查看 1 条新消息" })).toBeNull();
    expect(liveStatus).toBeEmptyDOMElement();
  });

  it("乐观消息被轮询结果持久化时保持同一气泡且不累计未读", async () => {
    const optimisticId = "assistant-2026-07-14T10:00:00.000Z";
    pollMessages = [
      message(
        "persisted-assistant",
        "assistant",
        "已经显示的乐观回复",
        "2026-07-14T10:00:05.000Z",
      ),
    ];
    render(
      <ChatShell
        conversationId="conversation-a"
        initialMessages={[
          message(
            optimisticId,
            "assistant",
            "已经显示的乐观回复",
            "2026-07-14T10:00:00.000Z",
          ),
        ]}
        initialConversations={[
          {
            id: "conversation-a",
            title: "测试会话",
            channel: "web",
            projectId: null,
            pinned: false,
            updatedAt: "2026-07-14T10:00:00.000Z",
            messageCount: 1,
          },
        ]}
      />,
    );
    const optimisticRow = screen.getByText("已经显示的乐观回复").closest(".message-row");
    expect(optimisticRow).not.toBeNull();
    const container = document.querySelector<HTMLElement>(".messages");
    expect(container).not.toBeNull();
    setElementScrollMetrics(container!, {
      scrollHeight: 1_000,
      scrollTop: 0,
      clientHeight: 500,
    });
    fireEvent.scroll(container!);
    scrollIntoView.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(screen.getByText("已经显示的乐观回复").closest(".message-row")).toBe(optimisticRow);
    expect(screen.queryByRole("button", { name: /条新消息/ })).toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("切换会话后继续观察新的输入框高度并更新消息留白", async () => {
    const observers: ResizeObserverStub[] = [];

    class ResizeObserverStub {
      readonly observed: Element[] = [];
      disconnected = false;

      constructor(private readonly callback: ResizeObserverCallback) {
        observers.push(this);
      }

      observe(target: Element) {
        this.observed.push(target);
      }

      unobserve() {}

      disconnect() {
        this.disconnected = true;
      }

      trigger() {
        this.callback([], this as unknown as ResizeObserver);
      }
    }

    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    render(
      <ChatShell
        conversationId="conversation-a"
        initialMessages={[]}
        initialConversations={[
          {
            id: "conversation-a",
            title: "会话 A",
            channel: "web",
            projectId: null,
            pinned: false,
            updatedAt: "2026-07-14T10:00:00.000Z",
            messageCount: 0,
          },
          {
            id: "conversation-b",
            title: "会话 B",
            channel: "web",
            projectId: null,
            pinned: false,
            updatedAt: "2026-07-14T10:00:01.000Z",
            messageCount: 0,
          },
        ]}
      />,
    );
    const firstComposer = document.querySelector<HTMLFormElement>(".chat-input-shell");
    expect(firstComposer).not.toBeNull();
    expect(observers).toHaveLength(1);
    expect(observers[0].observed).toEqual([firstComposer]);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "会话 B" }));
      await Promise.resolve();
    });

    const nextComposer = document.querySelector<HTMLFormElement>(".chat-input-shell");
    expect(nextComposer).not.toBeNull();
    expect(nextComposer).not.toBe(firstComposer);
    expect(observers).toHaveLength(2);
    expect(observers[0].disconnected).toBe(true);
    expect(observers[1].observed).toEqual([nextComposer]);

    Object.defineProperty(nextComposer, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ height: 180 }),
    });
    observers[1].trigger();

    const stage = document.querySelector<HTMLElement>(".chat-stage");
    expect(stage?.style.getPropertyValue("--chat-input-clearance")).toBe("204px");
  });
});

describe("ChatShell attachment submit", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn((file: File) => `blob:${file.name}`),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  });

  it("sends only attachment IDs to chat while the optimistic message uses safe display metadata", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = String(input);
      if (url === "/api/chat/attachments") return uploadResponse(imageAttachment());
      if (url === "/api/chat") {
        return sseResponse([
          {
            type: "accepted",
            conversationId: "00000000-0000-4000-8000-000000000010",
            userMessageId: "message-user",
          },
          {
            type: "done",
            conversationId: "00000000-0000-4000-8000-000000000010",
            assistantMessageId: "message-assistant",
          },
        ]);
      }
      if (url === "/api/conversations") {
        return new Response(JSON.stringify({ conversations: [], projects: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ChatShell
        conversationId="00000000-0000-4000-8000-000000000010"
        initialMessages={[]}
        initialConversations={[conversationItem()]}
      />,
    );

    fireEvent.change(screen.getByLabelText("选择图片"), {
      target: { files: [new File(["png"], "cat.png", { type: "image/png" })] },
    });
    await screen.findByText("cat.png");
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/chat")).toBe(true));
    const chatCall = fetchMock.mock.calls.find(([input]) => String(input) === "/api/chat");
    const body = JSON.parse(String(chatCall?.[1]?.body));
    expect(body).toEqual({
      message: "",
      conversationId: "00000000-0000-4000-8000-000000000010",
      attachmentIds: ["00000000-0000-4000-8000-000000000001"],
      clientTurnId: expect.any(String),
    });
    expect(JSON.stringify(body)).not.toMatch(/attachments|base64|blob:|cat\.png/);
    expect(await screen.findByRole("link", { name: /cat\.png/ })).toHaveAttribute(
      "href",
      "/api/chat/attachments/00000000-0000-4000-8000-000000000001/download",
    );
  });

  it("shows the model capability error and keeps the image draft for retry", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/chat/attachments") return uploadResponse(imageAttachment());
      if (url === "/api/chat") {
        return new Response(
          JSON.stringify({
            error: "image_model_not_supported",
            message: "当前模型暂不支持图片理解，请切换到支持图片的模型后重试。",
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ChatShell
        conversationId="00000000-0000-4000-8000-000000000010"
        initialMessages={[]}
        initialConversations={[conversationItem()]}
      />,
    );

    const textarea = screen.getByRole("textbox", { name: "输入消息" });
    fireEvent.input(textarea, { target: { value: "看看这张图" } });
    fireEvent.change(screen.getByLabelText("选择图片"), {
      target: { files: [new File(["png"], "cat.png", { type: "image/png" })] },
    });
    await screen.findByText("cat.png");
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByText("发送失败，请重试。")).toBeInTheDocument();
    expect(textarea).toHaveValue("看看这张图");
    expect(screen.getAllByText("cat.png")).toHaveLength(1);
  });

  it("commits an accepted attachment turn after an SSE error and reconciles one fallback", async () => {
    const conversationId = "00000000-0000-4000-8000-000000000010";
    const fallback = "服务端已经保存的降级回复";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/chat/attachments") return uploadResponse(imageAttachment());
      if (url === "/api/chat") {
        return sseResponse([
          { type: "accepted", conversationId, userMessageId: "message-user" },
          { type: "chunk", content: fallback },
          { type: "error", message: "不应覆盖服务端回复" },
        ]);
      }
      if (url === `/api/conversations/${conversationId}/messages`) {
        return new Response(JSON.stringify({
          messages: [
            {
              id: "message-user",
              role: "user",
              content: "看看这张图",
              createdAt: "2026-07-14T10:00:00.000Z",
              attachments: [{
                ...imageAttachment(),
                status: "bound",
                downloadUrl: "/api/chat/attachments/00000000-0000-4000-8000-000000000001/download",
              }],
            },
            {
              id: "message-assistant",
              role: "assistant",
              content: fallback,
              createdAt: "2026-07-14T10:00:01.000Z",
              attachments: [],
            },
          ],
        }), { status: 200 });
      }
      if (url === "/api/conversations") {
        return new Response(JSON.stringify({ conversations: [], projects: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ChatShell
        conversationId={conversationId}
        initialMessages={[]}
        initialConversations={[conversationItem()]}
      />,
    );

    const textarea = screen.getByRole("textbox", { name: "输入消息" });
    fireEvent.input(textarea, { target: { value: "看看这张图" } });
    fireEvent.change(screen.getByLabelText("选择图片"), {
      target: { files: [new File(["png"], "cat.png", { type: "image/png" })] },
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue(""));
    expect(screen.queryByRole("button", { name: "移除 cat.png" })).toBeNull();
    expect(screen.getAllByText(fallback)).toHaveLength(1);
    expect(screen.queryByText("不应覆盖服务端回复")).toBeNull();
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/chat")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(`/api/conversations/${conversationId}/messages`);
    expect(screen.getAllByRole("link", { name: /cat\.png/ })).toHaveLength(1);
  });

  it("retries an interrupted accepted stream once with the identical turn body and without re-uploading", async () => {
    const conversationId = "00000000-0000-4000-8000-000000000010";
    const chatBodies: string[] = [];
    let pullCount = 0;
    const interruptedStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        if (pullCount === 1) {
          controller.enqueue(new TextEncoder().encode(
            [
              `data: ${JSON.stringify({ type: "accepted", conversationId, userMessageId: "message-user" })}`,
              `data: ${JSON.stringify({ type: "chunk", content: "未完成" })}`,
              "",
            ].join("\n\n"),
          ));
          return;
        }
        controller.error(new Error("connection_lost"));
      },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/chat/attachments") return uploadResponse(imageAttachment());
      if (url === "/api/chat") {
        chatBodies.push(String(init?.body));
        if (chatBodies.length === 1) {
          return new Response(interruptedStream, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        const clientTurnId = String((JSON.parse(chatBodies[0]) as { clientTurnId: string }).clientTurnId);
        return sseResponse([
          { type: "accepted", conversationId, clientTurnId, userMessageId: "message-user" },
          { type: "chunk", content: "恢复后的唯一回复" },
          {
            type: "done",
            conversationId,
            clientTurnId,
            userMessageId: "message-user",
            assistantMessageId: "message-assistant",
          },
        ]);
      }
      return new Response(JSON.stringify({ conversations: [], projects: [], messages: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ChatShell
        conversationId={conversationId}
        initialMessages={[]}
        initialConversations={[conversationItem()]}
      />,
    );

    fireEvent.input(screen.getByRole("textbox", { name: "输入消息" }), {
      target: { value: "断线后恢复原事务" },
    });
    fireEvent.change(screen.getByLabelText("选择图片"), {
      target: { files: [new File(["png"], "cat.png", { type: "image/png" })] },
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue(""));
    expect(chatBodies).toHaveLength(2);
    expect(chatBodies[1]).toBe(chatBodies[0]);
    expect(JSON.parse(chatBodies[0])).toMatchObject({
      message: "断线后恢复原事务",
      conversationId,
      clientTurnId: expect.any(String),
      attachmentIds: ["00000000-0000-4000-8000-000000000001"],
    });
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/chat/attachments")).toHaveLength(1);
    expect(messageTexts("断线后恢复原事务")).toHaveLength(1);
    expect(messageTexts("恢复后的唯一回复")).toHaveLength(1);
    expect(screen.queryByText("未完成恢复后的唯一回复")).toBeNull();
    expect(screen.getAllByRole("link", { name: /cat\.png/ })).toHaveLength(1);
  });

  it("keeps a new-conversation draft mounted when the chat request fails before accepted", async () => {
    const createdConversation = conversationItem();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/chat/attachments") return uploadResponse(imageAttachment());
      if (url === "/api/conversations" && init?.method === "POST") {
        return new Response(JSON.stringify({ conversation: createdConversation }), { status: 201 });
      }
      if (url === "/api/chat") {
        return new Response(JSON.stringify({ message: "发送前失败" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ conversations: [], projects: [], messages: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ChatShell initialMessages={[]} initialConversations={[]} />);

    fireEvent.input(screen.getByRole("textbox", { name: "输入消息" }), { target: { value: "新会话草稿" } });
    fireEvent.change(screen.getByLabelText("选择图片"), {
      target: { files: [new File(["png"], "cat.png", { type: "image/png" })] },
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
    const composer = document.querySelector(".chat-input-shell");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await screen.findByText("发送失败，请重试。");
    expect(document.querySelector(".chat-input-shell")).toBe(composer);
    expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("新会话草稿");
    expect(screen.getByRole("button", { name: "移除 cat.png" })).toBeInTheDocument();
    expect(document.querySelectorAll(".message-row")).toHaveLength(0);
    expect(screen.queryByText("发送前失败")).toBeNull();
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/chat")).toHaveLength(1);
  });

  it("retries a lost accepted event with one client turn and renders one persisted source", async () => {
    const conversationId = "00000000-0000-4000-8000-000000000010";
    const chatBodies: Array<Record<string, unknown>> = [];
    let chatAttempt = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/chat/attachments") return uploadResponse(imageAttachment());
      if (url === "/api/chat") {
        chatAttempt += 1;
        chatBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (chatAttempt === 1) return sseResponse([{ type: "chunk", content: "客户端没收到 accepted" }]);
        const clientTurnId = String(chatBodies[0].clientTurnId);
        return sseResponse([
          { type: "accepted", conversationId, clientTurnId, userMessageId: "message-user" },
          { type: "chunk", content: "唯一回复" },
          {
            type: "done",
            conversationId,
            clientTurnId,
            userMessageId: "message-user",
            assistantMessageId: "message-assistant",
          },
        ]);
      }
      return new Response(JSON.stringify({ conversations: [], projects: [], messages: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ChatShell
        conversationId={conversationId}
        initialMessages={[]}
        initialConversations={[conversationItem()]}
      />,
    );
    fireEvent.input(screen.getByRole("textbox", { name: "输入消息" }), { target: { value: "同一个 turn" } });
    fireEvent.change(screen.getByLabelText("选择图片"), {
      target: { files: [new File(["png"], "cat.png", { type: "image/png" })] },
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByText("发送失败，请重试。");
    expect(document.querySelectorAll(".message-row")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "移除 cat.png" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue(""));

    expect(chatBodies).toHaveLength(2);
    expect(chatBodies[0].clientTurnId).toBe(chatBodies[1].clientTurnId);
    expect(messageTexts("同一个 turn")).toHaveLength(1);
    expect(messageTexts("唯一回复")).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: /cat\.png/ })).toHaveLength(1);
  });

  it("folds a replay into messages already restored by polling before the retry", async () => {
    const conversationId = "00000000-0000-4000-8000-000000000010";
    const restoredUser: ChatMessage = {
      id: "message-user-restored",
      role: "user",
      content: "轮询已恢复",
      createdAt: "2026-07-14T10:00:00.000Z",
    };
    const restoredAssistant: ChatMessage = {
      id: "message-assistant-restored",
      role: "assistant",
      content: "唯一持久化回复",
      createdAt: "2026-07-14T10:00:01.000Z",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/chat") {
        const clientTurnId = String((JSON.parse(String(init?.body)) as { clientTurnId: string }).clientTurnId);
        return sseResponse([
          { type: "accepted", conversationId, clientTurnId, userMessageId: restoredUser.id },
          { type: "chunk", content: restoredAssistant.content },
          {
            type: "done",
            conversationId,
            clientTurnId,
            userMessageId: restoredUser.id,
            assistantMessageId: restoredAssistant.id,
          },
        ]);
      }
      return new Response(JSON.stringify({ conversations: [], projects: [], messages: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ChatShell
        conversationId={conversationId}
        initialMessages={[restoredUser, restoredAssistant]}
        initialConversations={[conversationItem()]}
      />,
    );

    fireEvent.input(screen.getByRole("textbox", { name: "输入消息" }), { target: { value: restoredUser.content } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue(""));

    expect(messageTexts(restoredUser.content)).toHaveLength(1);
    expect(messageTexts(restoredAssistant.content)).toHaveLength(1);
    expect(new Set(Array.from(document.querySelectorAll(".message-row")).map((row) => row.textContent)).size).toBe(2);
  });

  it("keeps the original turn retryable when both automatic recovery attempts miss a restarting service", async () => {
    const conversation = conversationItem();
    const chatBodies: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/conversations" && init?.method === "POST") {
        return new Response(JSON.stringify({ conversation }), { status: 201 });
      }
      if (url === "/api/chat") {
        chatBodies.push(String(init?.body));
        const body = JSON.parse(chatBodies.at(-1)!) as { clientTurnId: string };
        if (chatBodies.length <= 2) {
          let pullCount = 0;
          const interruptedStream = new ReadableStream<Uint8Array>({
            pull(controller) {
              pullCount += 1;
              if (pullCount === 1) {
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
                  type: "accepted",
                  conversationId: conversation.id,
                  clientTurnId: body.clientTurnId,
                  userMessageId: "message-user-auto",
                })}\n\n`));
                return;
              }
              controller.error(new Error("service_restarting"));
            },
          });
          return new Response(interruptedStream, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return sseResponse([
          {
            type: "accepted",
            conversationId: conversation.id,
            clientTurnId: body.clientTurnId,
            userMessageId: "message-user-auto",
          },
          { type: "chunk", content: "刚才中断了，请再发一次。" },
          {
            type: "done",
            conversationId: conversation.id,
            clientTurnId: body.clientTurnId,
            userMessageId: "message-user-auto",
            assistantMessageId: "message-assistant-recovery",
            degraded: true,
          },
        ]);
      }
      if (url === `/api/conversations/${conversation.id}/messages`) {
        return new Response(JSON.stringify({ messages: [{
          id: "message-user-auto",
          role: "user",
          content: "自动会话断流",
          createdAt: "2026-07-14T10:00:00.000Z",
          attachments: [],
        }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ conversations: [], projects: [], messages: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ChatShell initialMessages={[]} initialConversations={[]} />);

    fireEvent.input(screen.getByRole("textbox", { name: "输入消息" }), { target: { value: "自动会话断流" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await screen.findByText("发送失败，请重试。");
    expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("自动会话断流");
    expect(messageTexts("自动会话断流")).toHaveLength(1);
    expect(document.querySelector(".message-row-assistant")).toBeNull();
    expect(chatBodies).toHaveLength(2);
    expect(chatBodies[1]).toBe(chatBodies[0]);
    expect(fetchMock.mock.calls.filter(([input, init]) =>
      String(input) === "/api/conversations" && init?.method === "POST",
    )).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue(""));
    expect(chatBodies).toHaveLength(3);
    expect(chatBodies[2]).toBe(chatBodies[0]);
    expect(messageTexts("自动会话断流")).toHaveLength(1);
    expect(messageTexts("刚才中断了，请再发一次。")).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([input, init]) =>
      String(input) === "/api/conversations" && init?.method === "POST",
    )).toHaveLength(1);
  });

  it("keeps the original turn when degraded done has no durable assistant", async () => {
    const conversationId = "00000000-0000-4000-8000-000000000010";
    const chatBodies: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/chat") {
        chatBodies.push(String(init?.body));
        const { clientTurnId } = JSON.parse(chatBodies[0]) as { clientTurnId: string };
        return sseResponse([
          { type: "accepted", conversationId, clientTurnId, userMessageId: "message-user-degraded" },
          { type: "done", conversationId, clientTurnId, userMessageId: "message-user-degraded", degraded: true },
        ]);
      }
      if (url === `/api/conversations/${conversationId}/messages`) {
        return new Response(JSON.stringify({
          messages: [{
            id: "message-user-degraded",
            role: "user",
            content: "降级也没有落库",
            createdAt: "2026-07-14T10:00:00.000Z",
            attachments: [],
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ conversations: [], projects: [], messages: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ChatShell
        conversationId={conversationId}
        initialMessages={[]}
        initialConversations={[conversationItem()]}
      />,
    );

    fireEvent.input(screen.getByRole("textbox", { name: "输入消息" }), {
      target: { value: "降级也没有落库" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await screen.findByText("发送失败，请重试。");
    expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("降级也没有落库");
    expect(chatBodies).toHaveLength(1);
    expect(messageTexts("降级也没有落库")).toHaveLength(1);
    expect(document.querySelector(".message-row-assistant")).toBeNull();
  });

  it("does not duplicate an accepted turn when polling wins the race with done", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const conversationId = "00000000-0000-4000-8000-000000000010";
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(new TextEncoder().encode([
          `data: ${JSON.stringify({ type: "accepted", conversationId, userMessageId: "message-user" })}`,
          `data: ${JSON.stringify({ type: "chunk", content: "即时助手" })}`,
          "",
        ].join("\n\n")));
      },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/chat") {
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      if (url.startsWith("/api/messages?")) {
        return new Response(JSON.stringify({ messages: [
          {
            id: "message-user",
            role: "user",
            content: "即时用户",
            createdAt: "2026-07-14T10:00:00.000Z",
            attachments: [],
          },
          {
            id: "message-assistant",
            role: "assistant",
            content: "即时助手",
            createdAt: "2026-07-14T10:00:01.000Z",
            attachments: [],
          },
        ] }), { status: 200 });
      }
      return new Response(JSON.stringify({ conversations: [], projects: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ChatShell
        conversationId={conversationId}
        initialMessages={[]}
        initialConversations={[conversationItem()]}
      />,
    );

    fireEvent.input(screen.getByRole("textbox", { name: "输入消息" }), { target: { value: "即时用户" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    await waitFor(() => expect(messageTexts("即时用户")).toHaveLength(1));
    expect(messageTexts("即时助手")).toHaveLength(1);

    await act(async () => {
      streamController.enqueue(new TextEncoder().encode(
        `data: ${JSON.stringify({
          type: "done",
          conversationId,
          assistantMessageId: "message-assistant",
        })}\n\n`,
      ));
      streamController.close();
    });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue(""));
    expect(messageTexts("即时用户")).toHaveLength(1);
    expect(messageTexts("即时助手")).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/chat")).toHaveLength(1);
    vi.useRealTimers();
  });

  it("does not let late accepted and done events take over a conversation selected during streaming", async () => {
    const firstConversation = conversationItem();
    const secondConversation = {
      ...conversationItem(),
      id: "00000000-0000-4000-8000-000000000020",
      title: "切换后的会话",
    };
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/chat") {
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      if (url === `/api/conversations/${secondConversation.id}/messages`) {
        return new Response(JSON.stringify({ messages: [{
          id: "second-message",
          role: "user",
          content: "切换后的历史",
          createdAt: "2026-07-14T10:01:00.000Z",
        }] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        conversations: [firstConversation, secondConversation],
        projects: [],
        messages: [],
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ChatShell
        conversationId={firstConversation.id}
        initialMessages={[]}
        initialConversations={[firstConversation, secondConversation]}
      />,
    );

    fireEvent.input(screen.getByRole("textbox", { name: "输入消息" }), { target: { value: "旧会话请求" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/chat", expect.any(Object)));
    fireEvent.click(screen.getByText(secondConversation.title));
    await screen.findByText("切换后的历史");

    await act(async () => {
      const clientTurnId = "70000000-0000-4000-8000-000000000070";
      streamController.enqueue(new TextEncoder().encode([
        `data: ${JSON.stringify({
          type: "accepted",
          conversationId: firstConversation.id,
          clientTurnId,
          userMessageId: "first-user",
        })}`,
        `data: ${JSON.stringify({ type: "chunk", content: "旧会话回复" })}`,
        `data: ${JSON.stringify({ type: "replace", content: "旧会话替换回复" })}`,
        `data: ${JSON.stringify({
          type: "done",
          conversationId: firstConversation.id,
          clientTurnId,
          userMessageId: "first-user",
          assistantMessageId: "first-assistant",
        })}`,
        "",
      ].join("\n\n")));
      streamController.close();
    });

    await waitFor(() => expect(document.querySelector(".sidebar-conversation-row.active .sidebar-row-label"))
      .toHaveTextContent(secondConversation.title));
    expect(messageTexts("切换后的历史")).toHaveLength(1);
    expect(screen.queryByText("旧会话请求")).toBeNull();
    expect(screen.queryByText("旧会话回复")).toBeNull();
    expect(screen.queryByText("旧会话替换回复")).toBeNull();
  });

  it("does not merge an accepted old turn into the current conversation after a switched-away disconnect", async () => {
    const firstConversation = conversationItem();
    const secondConversation = {
      ...conversationItem(),
      id: "00000000-0000-4000-8000-000000000021",
      title: "断流时的当前会话",
    };
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/chat") {
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      if (url === `/api/conversations/${secondConversation.id}/messages`) {
        return new Response(JSON.stringify({ messages: [{
          id: "second-only-message",
          role: "user",
          content: "只属于当前会话",
          createdAt: "2026-07-14T10:02:00.000Z",
        }] }), { status: 200 });
      }
      if (url === `/api/conversations/${firstConversation.id}/messages`) {
        return new Response(JSON.stringify({ messages: [{
          id: "first-persisted-message",
          role: "assistant",
          content: "旧会话断流恢复内容",
          createdAt: "2026-07-14T10:01:00.000Z",
        }] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        conversations: [firstConversation, secondConversation],
        projects: [],
        messages: [],
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ChatShell
        conversationId={firstConversation.id}
        initialMessages={[]}
        initialConversations={[firstConversation, secondConversation]}
      />,
    );

    fireEvent.input(screen.getByRole("textbox", { name: "输入消息" }), { target: { value: "会断流的旧请求" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/chat", expect.any(Object)));
    await act(async () => {
      streamController.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
        type: "accepted",
        conversationId: firstConversation.id,
        clientTurnId: "70000000-0000-4000-8000-000000000071",
        userMessageId: "first-user-disconnect",
      })}\n\n`));
    });
    fireEvent.click(screen.getByText(secondConversation.title));
    await screen.findByText("只属于当前会话");

    await act(async () => {
      streamController.error(new Error("disconnect_after_switch"));
    });

    await waitFor(() => expect(fetchMock)
      .toHaveBeenCalledWith(`/api/conversations/${firstConversation.id}/messages`));
    expect(document.querySelector(".sidebar-conversation-row.active .sidebar-row-label"))
      .toHaveTextContent(secondConversation.title);
    expect(messageTexts("只属于当前会话")).toHaveLength(1);
    expect(screen.queryByText("旧会话断流恢复内容")).toBeNull();
  });

  it("does not let an old stream take over a conversation created during streaming", async () => {
    const firstConversation = conversationItem();
    const createdConversation = {
      ...conversationItem(),
      id: "00000000-0000-4000-8000-000000000022",
      title: "流式中新建的会话",
    };
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/chat") {
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      if (url === "/api/conversations" && init?.method === "POST") {
        return new Response(JSON.stringify({ conversation: createdConversation }), { status: 201 });
      }
      return new Response(JSON.stringify({
        conversations: [firstConversation, createdConversation],
        projects: [],
        messages: [],
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ChatShell
        conversationId={firstConversation.id}
        initialMessages={[]}
        initialConversations={[firstConversation]}
      />,
    );

    fireEvent.input(screen.getByRole("textbox", { name: "输入消息" }), { target: { value: "新建前的旧请求" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/chat", expect.any(Object)));
    fireEvent.click(screen.getAllByRole("button", { name: "新建会话" })[0]);
    await waitFor(() => expect(document.querySelector(".sidebar-conversation-row.active .sidebar-row-label"))
      .toHaveTextContent(createdConversation.title));
    expect(screen.getByRole("textbox", { name: "输入消息" })).toBeEnabled();

    await act(async () => {
      const clientTurnId = "70000000-0000-4000-8000-000000000072";
      streamController.enqueue(new TextEncoder().encode([
        `data: ${JSON.stringify({
          type: "accepted",
          conversationId: firstConversation.id,
          clientTurnId,
          userMessageId: "first-user-before-create",
        })}`,
        `data: ${JSON.stringify({ type: "chunk", content: "不应进入新会话" })}`,
        `data: ${JSON.stringify({
          type: "done",
          conversationId: firstConversation.id,
          clientTurnId,
          userMessageId: "first-user-before-create",
          assistantMessageId: "first-assistant-before-create",
        })}`,
        "",
      ].join("\n\n")));
      streamController.close();
    });

    await waitFor(() => expect(document.querySelector(".sidebar-conversation-row.active .sidebar-row-label"))
      .toHaveTextContent(createdConversation.title));
    expect(screen.queryByText("新建前的旧请求")).toBeNull();
    expect(screen.queryByText("不应进入新会话")).toBeNull();
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

  it("renders downloadable image and document cards even when the message has no text", () => {
    render(
      <MessageBubble
        role="user"
        content=""
        attachments={[
          {
            id: "00000000-0000-4000-8000-000000000001",
            kind: "image",
            fileName: "cat.png",
            mimeType: "image/png",
            sizeBytes: 1_024,
            status: "bound",
            downloadUrl: "/api/chat/attachments/00000000-0000-4000-8000-000000000001/download",
          },
          {
            id: "00000000-0000-4000-8000-000000000002",
            kind: "document",
            fileName: "notes.md",
            mimeType: "text/markdown",
            sizeBytes: 2_048,
            status: "bound",
            downloadUrl: "/api/chat/attachments/00000000-0000-4000-8000-000000000002/download",
          },
        ]}
      />,
    );

    expect(screen.getByRole("img", { name: "cat.png" })).toHaveAttribute(
      "src",
      "/api/chat/attachments/00000000-0000-4000-8000-000000000001/download",
    );
    expect(screen.getByRole("link", { name: /cat\.png/ })).toHaveAttribute(
      "href",
      "/api/chat/attachments/00000000-0000-4000-8000-000000000001/download",
    );
    expect(screen.getByRole("link", { name: /cat\.png/ })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: /cat\.png/ })).toHaveAttribute("rel", "noopener");
    expect(screen.getByRole("link", { name: /cat\.png/ })).not.toHaveAttribute("download");
    const documentLink = screen.getByRole("link", { name: /notes\.md/ });
    expect(documentLink).toHaveAttribute(
      "href",
      "/api/chat/attachments/00000000-0000-4000-8000-000000000002/download",
    );
    expect(documentLink).toHaveAttribute("download", "notes.md");
    expect(documentLink).not.toHaveAttribute("target");
  });
});

describe("ChatInput", () => {
  it("reuses one client turn id for an unchanged failed draft and rotates it after text edits", async () => {
    const onSubmit = vi.fn().mockResolvedValue(false);
    render(<ChatInput onSubmit={onSubmit} />);
    const textarea = screen.getByRole("textbox", { name: "输入消息" });

    fireEvent.input(textarea, { target: { value: "失败后重试" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const firstTurnId = (onSubmit.mock.calls[0][1] as { clientTurnId: string }).clientTurnId;
    expect(firstTurnId).toMatch(/^[0-9a-f-]{36}$/);

    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect((onSubmit.mock.calls[1][1] as { clientTurnId: string }).clientTurnId).toBe(firstTurnId);

    fireEvent.input(textarea, { target: { value: "编辑后的新草稿" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(3));
    expect((onSubmit.mock.calls[2][1] as { clientTurnId: string }).clientTurnId).not.toBe(firstTurnId);
    expect(screen.getByRole("alert")).toHaveTextContent("发送失败，请重试。");
  });

  it("rotates the client turn id when search authorization changes", async () => {
    const onSubmit = vi.fn().mockResolvedValue(false);
    render(<ChatInput onSubmit={onSubmit} />);
    fireEvent.input(screen.getByRole("textbox", { name: "输入消息" }), { target: { value: "联网草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const firstTurnId = (onSubmit.mock.calls[0][1] as { clientTurnId: string }).clientTurnId;

    fireEvent.click(screen.getByRole("button", { name: "开启联网搜索" }));
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));

    expect((onSubmit.mock.calls[1][1] as { clientTurnId: string }).clientTurnId).not.toBe(firstTurnId);
  });

  it("requires an explicit per-message toggle for web search and resets it after sending", async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(<ChatInput onSubmit={onSubmit} />);

    const searchButton = screen.getByRole("button", { name: "开启联网搜索" });
    expect(searchButton).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(searchButton);
    expect(screen.getByRole("button", { name: "关闭联网搜索" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("搜索")).toBeInTheDocument();

    const textarea = screen.getByRole("textbox", { name: "输入消息" }) as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "查查今天有什么新消息" } });
    fireEvent.submit(textarea.closest("form")!);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("查查今天有什么新消息", {
      clientTurnId: expect.any(String),
      searchEnabled: true,
    }));
    expect(screen.getByRole("button", { name: "开启联网搜索" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText("搜索")).toBeNull();
  });

  it("resets the search toggle when the active conversation changes", () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    const { rerender } = render(<ChatInput key="conversation-a" onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("button", { name: "开启联网搜索" }));
    expect(screen.getByRole("button", { name: "关闭联网搜索" })).toHaveAttribute("aria-pressed", "true");

    rerender(<ChatInput key="conversation-b" onSubmit={onSubmit} />);

    expect(screen.getByRole("button", { name: "开启联网搜索" })).toHaveAttribute("aria-pressed", "false");
  });

  it("shrinks back after a tall draft is sent", async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(<ChatInput onSubmit={onSubmit} />);

    const textarea = screen.getByRole("textbox", { name: "输入消息" }) as HTMLTextAreaElement;
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 160 });

    fireEvent.input(textarea, { target: { value: "这是一段很长的输入，发送后输入框应该回到单行高度。" } });
    expect(textarea.style.height).toBe("160px");

    fireEvent.submit(textarea.closest("form")!);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(
      "这是一段很长的输入，发送后输入框应该回到单行高度。",
      { clientTurnId: expect.any(String) },
    ));
    await waitFor(() => expect(textarea.value).toBe(""));
    expect(textarea.style.height).toBe("");
  });

  it("submits when Enter is pressed without Shift", async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(<ChatInput onSubmit={onSubmit} />);

    const textarea = screen.getByRole("textbox", { name: "输入消息" }) as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "回车发送" } });

    const eventWasNotPrevented = fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });

    expect(eventWasNotPrevented).toBe(false);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(
      "回车发送",
      { clientTurnId: expect.any(String) },
    ));
    await waitFor(() => expect(textarea.value).toBe(""));
  });

  it("keeps Shift Enter available for line breaks", () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(<ChatInput onSubmit={onSubmit} />);

    const textarea = screen.getByRole("textbox", { name: "输入消息" }) as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "第一行" } });

    const eventWasNotPrevented = fireEvent.keyDown(textarea, { key: "Enter", code: "Enter", shiftKey: true });

    expect(eventWasNotPrevented).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(textarea.value).toBe("第一行");
  });
});

describe("ChatInput attachments", () => {
  const IMAGE_ACCEPT = ".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp";
  const DOCUMENT_ACCEPT = ".pdf,.txt,.md,.json,.csv,application/pdf,text/plain,text/markdown,application/json,text/csv";
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createObjectURL = vi.fn((file: File) => `blob:${file.name}`);
    revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens an accessible attachment disclosure and restores focus after Escape", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => uploadResponse(imageAttachment())));
    render(<ChatInput onSubmit={vi.fn().mockResolvedValue(true)} />);

    const trigger = screen.getByRole("button", { name: "添加附件" });
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    const disclosure = screen.getByRole("dialog", { name: "添加附件" });
    expect(disclosure).toHaveAttribute("id", trigger.getAttribute("aria-controls"));
    const fileButton = screen.getByRole("button", { name: "上传文件" });
    const imageButton = screen.getByRole("button", { name: "上传图片" });
    await waitFor(() => expect(fileButton).toHaveFocus());
    await user.tab();
    expect(imageButton).toHaveFocus();
    expect(screen.getByLabelText("选择图片")).toHaveAttribute("accept", IMAGE_ACCEPT);
    expect(screen.getByLabelText("选择文件")).toHaveAttribute("accept", DOCUMENT_ACCEPT);

    await user.keyboard("{Escape}");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    fireEvent.mouseDown(document.body);
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "上传图片" }));
    fireEvent.change(screen.getByLabelText("选择图片"), {
      target: { files: [new File(["png"], "cat.png", { type: "image/png" })] },
    });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
    expect(await screen.findByText("cat.png")).toBeInTheDocument();
  });

  it("rotates the client turn id when attachments change", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => uploadResponse(imageAttachment())));
    const onSubmit = vi.fn().mockResolvedValue(false);
    render(<ChatInput onSubmit={onSubmit} />);
    const textarea = screen.getByRole("textbox", { name: "输入消息" });
    fireEvent.input(textarea, { target: { value: "附件草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const firstTurnId = (onSubmit.mock.calls[0][1] as { clientTurnId: string }).clientTurnId;

    fireEvent.change(screen.getByLabelText("选择图片"), {
      target: { files: [new File(["png"], "cat.png", { type: "image/png" })] },
    });
    await screen.findByText("cat.png");
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));

    expect((onSubmit.mock.calls[1][1] as { clientTurnId: string }).clientTurnId).not.toBe(firstTurnId);
  });

  it("rotates the client turn id when a Skill selection changes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      skills: [{ id: "00000000-0000-4000-8000-000000000099", name: "周报整理", trigger: "整理周报" }],
    }), { status: 200 })));
    const onSubmit = vi.fn().mockResolvedValue(false);
    render(<ChatInput onSubmit={onSubmit} />);
    const textarea = screen.getByRole("textbox", { name: "输入消息" });
    fireEvent.input(textarea, { target: { value: "/" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const firstTurnId = (onSubmit.mock.calls[0][1] as { clientTurnId: string }).clientTurnId;

    fireEvent.mouseDown(await screen.findByText("周报整理"));
    fireEvent.input(textarea, { target: { value: "整理它" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));

    expect((onSubmit.mock.calls[1][1] as { clientTurnId: string }).clientTurnId).not.toBe(firstTurnId);
  });

  it("keeps the attachment menu and Skill picker mutually exclusive", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ skills: [] }), { status: 200 })),
    );
    render(<ChatInput onSubmit={vi.fn().mockResolvedValue(true)} />);
    const textarea = screen.getByRole("textbox", { name: "输入消息" });
    const attachmentTrigger = screen.getByRole("button", { name: "添加附件" });

    fireEvent.input(textarea, { target: { value: "/" } });
    expect(await screen.findByRole("listbox", { name: "Skill 列表" })).toBeInTheDocument();
    fireEvent.click(attachmentTrigger);
    expect(screen.queryByRole("listbox", { name: "Skill 列表" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "添加附件" })).toBeInTheDocument();

    fireEvent.input(textarea, { target: { value: "普通文字" } });
    fireEvent.input(textarea, { target: { value: "/" } });

    expect(await screen.findByRole("listbox", { name: "Skill 列表" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "添加附件" })).toBeNull();
  });

  it("uploads every selected file independently and disables send while uploads are pending", async () => {
    const resolvers: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(
      () => new Promise<Response>((resolve) => resolvers.push(resolve)),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<ChatInput onSubmit={vi.fn().mockResolvedValue(true)} />);

    fireEvent.change(screen.getByLabelText("选择文件"), {
      target: {
        files: [
          new File(["one"], "one.txt", { type: "text/plain" }),
          new File(["two"], "two.md", { type: "text/markdown" }),
        ],
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(screen.getAllByText(/上传中/)).toHaveLength(2);

    await act(async () => {
      resolvers[0](uploadResponse(documentAttachment("00000000-0000-4000-8000-000000000001", "one.txt", "text/plain")));
      resolvers[1](uploadResponse(documentAttachment("00000000-0000-4000-8000-000000000002", "two.md", "text/markdown")));
    });
    await waitFor(() => expect(screen.queryByText(/上传中/)).toBeNull());
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
  });

  it("aborts a pending upload when its card is removed without showing a failure", async () => {
    let uploadSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      uploadSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        uploadSignal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ChatInput onSubmit={vi.fn().mockResolvedValue(true)} />);

    fireEvent.change(screen.getByLabelText("选择文件"), {
      target: { files: [new File(["pending"], "pending.txt", { type: "text/plain" })] },
    });
    fireEvent.click(await screen.findByRole("button", { name: "移除 pending.txt" }));

    expect(uploadSignal?.aborted).toBe(true);
    expect(screen.queryByText("pending.txt")).toBeNull();
    expect(screen.queryByText("上传失败，请重试。")).toBeNull();
    expect(screen.queryByText("请先重试或移除上传失败的附件。")).toBeNull();
  });

  it("aborts every pending upload when the composer unmounts", async () => {
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      if (signal) signals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(<ChatInput onSubmit={vi.fn().mockResolvedValue(true)} />);

    fireEvent.change(screen.getByLabelText("选择文件"), {
      target: {
        files: [
          new File(["one"], "one.txt", { type: "text/plain" }),
          new File(["two"], "two.md", { type: "text/markdown" }),
        ],
      },
    });
    await waitFor(() => expect(signals).toHaveLength(2));
    unmount();

    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("shows a readable upload error and retries the same file", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "attachment_no_extractable_text" }), { status: 422 }))
      .mockResolvedValueOnce(uploadResponse(documentAttachment("00000000-0000-4000-8000-000000000001", "blank.pdf", "application/pdf")));
    vi.stubGlobal("fetch", fetchMock);
    render(<ChatInput onSubmit={vi.fn().mockResolvedValue(true)} />);

    fireEvent.change(screen.getByLabelText("选择文件"), {
      target: { files: [new File(["%PDF-"], "blank.pdf", { type: "application/pdf" })] },
    });

    expect(await screen.findByText("无法读取此文件，请重试或移除。" )).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试 blank.pdf" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("button", { name: "重试 blank.pdf" })).toBeNull());
  });

  it("deletes a ready draft when it is removed and revokes its image preview URL", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(uploadResponse(imageAttachment()))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ChatInput onSubmit={vi.fn().mockResolvedValue(true)} />);

    fireEvent.change(screen.getByLabelText("选择图片"), {
      target: { files: [new File(["png"], "cat.png", { type: "image/png" })] },
    });
    await screen.findByText("cat.png");
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "移除 cat.png" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        "/api/chat/attachments/00000000-0000-4000-8000-000000000001",
        { method: "DELETE" },
      ),
    );
    expect(screen.queryByText("cat.png")).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:cat.png");
  });

  it("supports a pure attachment message and clears only after a successful submit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => uploadResponse(imageAttachment())));
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(<ChatInput onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText("选择图片"), {
      target: { files: [new File(["png"], "cat.png", { type: "image/png" })] },
    });
    await screen.findByText("cat.png");
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith("", {
        attachmentIds: ["00000000-0000-4000-8000-000000000001"],
        attachments: [expect.objectContaining({ fileName: "cat.png", status: "ready" })],
        clientTurnId: expect.any(String),
      }),
    );
    await waitFor(() => expect(screen.queryByText("cat.png")).toBeNull());
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:cat.png");
  });

  it("preserves text, skill, search authorization and attachments after submit returns false", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/skills") {
        return new Response(JSON.stringify({
          skills: [{ id: "00000000-0000-4000-8000-000000000099", name: "周报整理", trigger: "整理周报" }],
        }), { status: 200 });
      }
      return uploadResponse(imageAttachment());
    });
    vi.stubGlobal("fetch", fetchMock);
    const onSubmit = vi.fn().mockResolvedValue(false);
    render(<ChatInput onSubmit={onSubmit} />);

    const textarea = screen.getByRole("textbox", { name: "输入消息" }) as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "/" } });
    fireEvent.mouseDown(await screen.findByText("周报整理"));
    fireEvent.click(screen.getByRole("button", { name: "开启联网搜索" }));
    fireEvent.change(screen.getByLabelText("选择图片"), {
      target: { files: [new File(["png"], "cat.png", { type: "image/png" })] },
    });
    await screen.findByText("cat.png");
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
    fireEvent.input(textarea, { target: { value: "分析一下" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(textarea).toHaveValue("分析一下");
    expect(screen.getByLabelText("移除 Skill 周报整理")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭联网搜索" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("cat.png")).toBeInTheDocument();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("uses the same allowlist and size limits for file selection and composer drops", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => uploadResponse(imageAttachment())));
    render(<ChatInput onSubmit={vi.fn().mockResolvedValue(true)} />);
    const form = screen.getByRole("textbox", { name: "输入消息" }).closest("form")!;

    fireEvent.change(screen.getByLabelText("选择文件"), {
      target: { files: [new File(["svg"], "logo.svg", { type: "image/svg+xml" })] },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("仅支持 JPEG、PNG、WebP、PDF、TXT、MD、JSON、CSV");

    const oversized = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.pdf", { type: "application/pdf" });
    fireEvent.drop(form, { dataTransfer: { files: [oversized] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("单个附件不能超过 10 MB");
  });

  it("enforces count and aggregate-size limits for dropped files", async () => {
    let uploadIndex = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      uploadIndex += 1;
      return uploadResponse(documentAttachment(
        `00000000-0000-4000-8000-${String(uploadIndex).padStart(12, "0")}`,
        `part-${uploadIndex}.txt`,
        "text/plain",
        6 * 1024 * 1024,
      ));
    }));
    render(<ChatInput onSubmit={vi.fn().mockResolvedValue(true)} />);
    const form = screen.getByRole("textbox", { name: "输入消息" }).closest("form")!;
    const sixMiB = () => new Uint8Array(6 * 1024 * 1024);

    fireEvent.drop(form, {
      dataTransfer: {
        files: [
          new File([sixMiB()], "part-1.txt", { type: "text/plain" }),
          new File([sixMiB()], "part-2.txt", { type: "text/plain" }),
          new File([sixMiB()], "part-3.txt", { type: "text/plain" }),
          new File([sixMiB()], "part-4.txt", { type: "text/plain" }),
        ],
      },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("附件总大小不能超过 20 MB");
    await waitFor(() => expect(screen.getAllByText(/part-[123]\.txt/)).toHaveLength(3));

    fireEvent.drop(form, {
      dataTransfer: { files: [new File(["four"], "part-4.txt", { type: "text/plain" })] },
    });
    await waitFor(() => expect(screen.getAllByText(/part-[1-4]\.txt/)).toHaveLength(4));
    fireEvent.drop(form, {
      dataTransfer: { files: [new File(["five"], "part-5.txt", { type: "text/plain" })] },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("每条消息最多 4 个附件");
  });

  it("revokes image object URLs when the composer unmounts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => uploadResponse(imageAttachment())));
    const { unmount } = render(<ChatInput onSubmit={vi.fn().mockResolvedValue(true)} />);
    fireEvent.change(screen.getByLabelText("选择图片"), {
      target: { files: [new File(["png"], "cat.png", { type: "image/png" })] },
    });
    await screen.findByText("cat.png");

    unmount();

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:cat.png");
  });

  it("keeps repeated selections of the same file independently removable", async () => {
    let uploadIndex = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/chat/attachments/")) {
        return new Response(null, { status: 204 });
      }
      uploadIndex += 1;
      return uploadResponse(documentAttachment(
        `00000000-0000-4000-8000-${String(uploadIndex).padStart(12, "0")}`,
        "same.txt",
        "text/plain",
      ));
    }));
    render(<ChatInput onSubmit={vi.fn().mockResolvedValue(true)} />);
    const input = screen.getByLabelText("选择文件");
    const sameFile = () => new File(["same"], "same.txt", { type: "text/plain", lastModified: 1 });

    fireEvent.change(input, { target: { files: [sameFile(), sameFile()] } });
    await waitFor(() => expect(screen.getAllByRole("button", { name: "移除 same.txt" })).toHaveLength(2));
    fireEvent.click(screen.getAllByRole("button", { name: "移除 same.txt" })[0]);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "移除 same.txt" })).toHaveLength(1));

    fireEvent.change(input, { target: { files: [sameFile()] } });
    await waitFor(() => expect(screen.getAllByRole("button", { name: "移除 same.txt" })).toHaveLength(2));
    fireEvent.click(screen.getAllByRole("button", { name: "移除 same.txt" })[0]);

    await waitFor(() => expect(screen.getAllByRole("button", { name: "移除 same.txt" })).toHaveLength(1));
  });

  it("recovers its mounted state after the StrictMode effect probe", async () => {
    let resolveUpload!: (response: Response) => void;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/chat/attachments") {
        return new Promise<Response>((resolve) => {
          resolveUpload = resolve;
        });
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <StrictMode>
        <ChatInput onSubmit={vi.fn().mockResolvedValue(true)} />
      </StrictMode>,
    );

    fireEvent.change(screen.getByLabelText("选择图片"), {
      target: { files: [new File(["png"], "cat.png", { type: "image/png" })] },
    });
    await act(async () => resolveUpload(uploadResponse(imageAttachment())));

    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/00000000-"))).toHaveLength(0);
  });

  it("deletes a late successful upload exactly once after the card is removed", async () => {
    let resolveUpload!: (response: Response) => void;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/chat/attachments") {
        return new Promise<Response>((resolve) => {
          resolveUpload = resolve;
        });
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ChatInput onSubmit={vi.fn().mockResolvedValue(true)} />);

    fireEvent.change(screen.getByLabelText("选择图片"), {
      target: { files: [new File(["png"], "cat.png", { type: "image/png" })] },
    });
    fireEvent.click(await screen.findByRole("button", { name: "移除 cat.png" }));
    await act(async () => resolveUpload(uploadResponse(imageAttachment())));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([input]) => String(input) === "/api/chat/attachments/00000000-0000-4000-8000-000000000001",
        ),
      ).toHaveLength(1),
    );
  });

  it("deletes a late successful upload exactly once after a real unmount", async () => {
    let resolveUpload!: (response: Response) => void;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/chat/attachments") {
        return new Promise<Response>((resolve) => {
          resolveUpload = resolve;
        });
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(<ChatInput onSubmit={vi.fn().mockResolvedValue(true)} />);

    fireEvent.change(screen.getByLabelText("选择图片"), {
      target: { files: [new File(["png"], "cat.png", { type: "image/png" })] },
    });
    await screen.findByText("cat.png");
    unmount();
    await act(async () => resolveUpload(uploadResponse(imageAttachment())));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([input]) => String(input) === "/api/chat/attachments/00000000-0000-4000-8000-000000000001",
        ),
      ).toHaveLength(1),
    );
  });

  it("blocks a text message while any attachment has failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "attachment_upload_failed" }), { status: 500 })),
    );
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(<ChatInput onSubmit={onSubmit} />);

    const textarea = screen.getByRole("textbox", { name: "输入消息" });
    fireEvent.input(textarea, { target: { value: "不要静默丢掉失败附件" } });
    fireEvent.change(screen.getByLabelText("选择文件"), {
      target: { files: [new File(["bad"], "bad.txt", { type: "text/plain" })] },
    });

    expect(await screen.findByText("请先重试或移除上传失败的附件。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    fireEvent.submit(textarea.closest("form")!);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("blocks ready attachments while another attachment has failed", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const file = (init?.body as FormData).get("file") as File;
      if (file.name === "bad.txt") {
        return new Response(JSON.stringify({ error: "attachment_upload_failed" }), { status: 500 });
      }
      return uploadResponse(documentAttachment(
        "00000000-0000-4000-8000-000000000001",
        "good.txt",
        "text/plain",
      ));
    });
    vi.stubGlobal("fetch", fetchMock);
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(<ChatInput onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText("选择文件"), {
      target: {
        files: [
          new File(["good"], "good.txt", { type: "text/plain" }),
          new File(["bad"], "bad.txt", { type: "text/plain" }),
        ],
      },
    });

    expect(await screen.findByText("请先重试或移除上传失败的附件。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("textbox", { name: "输入消息" }).closest("form")!);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("disables retry and remove actions when the composer becomes disabled", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const file = init?.body instanceof FormData ? init.body.get("file") as File : null;
      if (file?.name === "bad.txt") {
        return new Response(JSON.stringify({ error: "attachment_upload_failed" }), { status: 500 });
      }
      return uploadResponse(documentAttachment(
        "00000000-0000-4000-8000-000000000001",
        "good.txt",
        "text/plain",
      ));
    });
    vi.stubGlobal("fetch", fetchMock);
    const onSubmit = vi.fn().mockResolvedValue(true);
    const { rerender } = render(<ChatInput onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText("选择文件"), {
      target: {
        files: [
          new File(["good"], "good.txt", { type: "text/plain" }),
          new File(["bad"], "bad.txt", { type: "text/plain" }),
        ],
      },
    });
    await screen.findByRole("button", { name: "重试 bad.txt" });

    rerender(<ChatInput disabled onSubmit={onSubmit} />);
    const retry = screen.getByRole("button", { name: "重试 bad.txt" });
    const removes = screen.getAllByRole("button", { name: /移除 (good|bad)\.txt/ });
    expect(retry).toBeDisabled();
    removes.forEach((button) => expect(button).toBeDisabled());
    const requestCount = fetchMock.mock.calls.length;
    fireEvent.click(retry);
    removes.forEach((button) => fireEvent.click(button));

    expect(fetchMock).toHaveBeenCalledTimes(requestCount);
    expect(screen.getByText("good.txt")).toBeInTheDocument();
    expect(screen.getByText("bad.txt")).toBeInTheDocument();
  });

  it("does not delete an attachment during an in-flight send", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => uploadResponse(imageAttachment())));
    let resolveSubmit!: (success: boolean) => void;
    const onSubmit = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveSubmit = resolve;
    }));
    render(<ChatInput onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText("选择图片"), {
      target: { files: [new File(["png"], "cat.png", { type: "image/png" })] },
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    const remove = screen.getByRole("button", { name: "移除 cat.png" });
    expect(remove).toBeDisabled();
    fireEvent.click(remove);
    expect(screen.getByText("cat.png")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => resolveSubmit(false));
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
    const onSubmit = vi.fn().mockResolvedValue(true);
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

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith("帮我整理这周的更新", {
        clientTurnId: expect.any(String),
        skillIds: ["00000000-0000-4000-8000-000000000001"],
      }),
    );
    await waitFor(() => expect(screen.queryByLabelText("移除 Skill 周报整理")).toBeNull());
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
  it("stores the persisted id while keeping the optimistic UI id stable", () => {
    const optimisticId = "assistant-optimistic-1";
    const persisted = message(
      "persisted-1",
      "assistant",
      "好的",
      "2026-07-09T04:00:01.000Z",
    );

    const merged = mergeMessages(
      [message(optimisticId, "assistant", "好的", "2026-07-09T04:00:00.000Z")],
      [persisted],
    );

    expect(merged).toEqual([{ ...persisted, uiId: optimisticId }]);
    expect(mergeMessages(merged, [persisted])).toEqual(merged);
  });

  it("appends a later persisted message with the same role and content", () => {
    const optimisticId = "assistant-optimistic-1";
    const persistedFirst = message(
      "persisted-1",
      "assistant",
      "好的",
      "2026-07-09T04:00:01.000Z",
    );
    const persistedSecond = message(
      "persisted-2",
      "assistant",
      "好的",
      "2026-07-09T04:00:02.000Z",
    );
    const persisted = mergeMessages(
      [message(optimisticId, "assistant", "好的", "2026-07-09T04:00:00.000Z")],
      [persistedFirst],
    );

    expect(mergeMessages(persisted, [persistedSecond])).toEqual([
      { ...persistedFirst, uiId: optimisticId },
      persistedSecond,
    ]);
  });

  it("matches identical optimistic messages to persisted messages one by one", () => {
    const persistedFirst = message(
      "persisted-1",
      "assistant",
      "好的",
      "2026-07-09T04:00:01.000Z",
    );
    const persistedSecond = message(
      "persisted-2",
      "assistant",
      "好的",
      "2026-07-09T04:00:02.000Z",
    );

    expect(
      mergeMessages(
        [
          message("assistant-optimistic-1", "assistant", "好的", "2026-07-09T04:00:00.000Z"),
          message("assistant-optimistic-2", "assistant", "好的", "2026-07-09T04:00:00.500Z"),
        ],
        [persistedFirst, persistedSecond],
      ),
    ).toEqual([
      { ...persistedFirst, uiId: "assistant-optimistic-1" },
      { ...persistedSecond, uiId: "assistant-optimistic-2" },
    ]);
  });
});

function message(id: string, role: ChatMessage["role"], content: string, createdAt: string): ChatMessage {
  return { id, role, content, createdAt };
}

function setElementScrollMetrics(
  element: HTMLElement,
  metrics: { scrollHeight: number; scrollTop: number; clientHeight: number },
) {
  for (const [key, value] of Object.entries(metrics)) {
    Object.defineProperty(element, key, { configurable: true, value });
  }
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

function FreshArrayChatScrollHarness({
  conversationId,
  messageIds,
}: {
  conversationId?: string;
  messageIds: string[];
}) {
  const { containerRef, endRef, unreadCount, jumpToLatest } = useChatScroll({
    conversationId,
    messageIds: [...messageIds],
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

function imageAttachment() {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    kind: "image" as const,
    fileName: "cat.png",
    mimeType: "image/png",
    sizeBytes: 3,
    status: "ready" as const,
  };
}

function documentAttachment(
  id: string,
  fileName: string,
  mimeType: string,
  sizeBytes = 3,
) {
  return {
    id,
    kind: "document" as const,
    fileName,
    mimeType,
    sizeBytes,
    status: "ready" as const,
  };
}

function uploadResponse(attachment: ReturnType<typeof imageAttachment> | ReturnType<typeof documentAttachment>) {
  return new Response(JSON.stringify({ attachment }), {
    status: 201,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(events: Array<Record<string, unknown>>) {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function messageTexts(content: string) {
  return Array.from(document.querySelectorAll(".message-text"))
    .filter((element) => element.textContent === content);
}

function conversationItem() {
  return {
    id: "00000000-0000-4000-8000-000000000010",
    title: "附件测试",
    channel: "web",
    projectId: null,
    pinned: false,
    updatedAt: "2026-07-14T10:00:00.000Z",
    messageCount: 0,
  } as const;
}
