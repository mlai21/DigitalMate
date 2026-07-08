import { describe, expect, it } from "vitest";
import { buildConversationSummary, shouldCompactConversation } from "@/server/agent/compaction";

const messages = Array.from({ length: 24 }, (_, index) => ({
  id: `m${index}`,
  role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
  content: index === 0 ? "我在准备一个演讲" : `第 ${index} 条消息`,
  createdAt: new Date("2026-07-05T10:00:00+08:00"),
}));

describe("conversation compaction", () => {
  it("compacts long conversations while keeping the latest window outside the summary", () => {
    expect(shouldCompactConversation(messages, { threshold: 20 })).toBe(true);

    const summary = buildConversationSummary(messages, { keepRecent: 6 });

    expect(summary.messageCount).toBe(18);
    expect(summary.text).toContain("用户：我在准备一个演讲");
    expect(summary.text).not.toContain("第 23 条消息");
  });

  it("does not compact short conversations", () => {
    expect(shouldCompactConversation(messages.slice(0, 8), { threshold: 20 })).toBe(false);
  });
});
