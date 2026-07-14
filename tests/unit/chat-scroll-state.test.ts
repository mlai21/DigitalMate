import { describe, expect, it } from "vitest";
import {
  collectUnreadMessageIds,
  isNearChatBottom,
} from "@/components/chat/chat-scroll-state";

describe("isNearChatBottom", () => {
  it("uses an inclusive 80px bottom threshold", () => {
    expect(
      isNearChatBottom({
        scrollHeight: 1000,
        scrollTop: 620,
        clientHeight: 300,
      }),
    ).toBe(true);
    expect(
      isNearChatBottom({
        scrollHeight: 1000,
        scrollTop: 619,
        clientHeight: 300,
      }),
    ).toBe(false);
  });
});

describe("collectUnreadMessageIds", () => {
  it("keeps each streaming message id unread only once", () => {
    const unreadIds = collectUnreadMessageIds(
      new Set(["assistant-stream"]),
      ["assistant-stream", "assistant-next"],
    );

    expect([...unreadIds]).toEqual(["assistant-stream", "assistant-next"]);
  });
});
