import { describe, expect, it } from "vitest";
import { shouldSearchWeb } from "@/server/agent/tools/web-search";

describe("shouldSearchWeb", () => {
  it("detects real-time questions", () => {
    expect(shouldSearchWeb("帮我查一下明天北京天气")).toBe(true);
    expect(shouldSearchWeb("我喜欢爬山")).toBe(false);
  });
});
