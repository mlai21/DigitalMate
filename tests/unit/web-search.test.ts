import { describe, expect, it } from "vitest";
import { summarizeSearchResults } from "@/server/agent/tools/web-search";

describe("summarizeSearchResults", () => {
  it("formats search hits into a numbered digest", () => {
    const summary = summarizeSearchResults([
      { title: "北京天气", url: "https://example.com/weather", snippet: "明天小雨" },
    ]);

    expect(summary).toBe("1. 北京天气：明天小雨 (https://example.com/weather)");
  });

  it("degrades gracefully with no results", () => {
    expect(summarizeSearchResults([])).toBe("没有找到可靠搜索结果。");
  });
});
