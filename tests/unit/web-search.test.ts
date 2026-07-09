import { afterEach, describe, expect, it, vi } from "vitest";
import { mapIqsPageItems, searchWeb, summarizeSearchResults } from "@/server/agent/tools/web-search";
import type { AppEnv } from "@/server/config/env";

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

  it("truncates oversized snippets so full-page dumps cannot flood the context", () => {
    const summary = summarizeSearchResults([
      { title: "掘金搜索", url: "https://juejin.cn", snippet: "长文".repeat(500) },
    ]);

    expect(summary.length).toBeLessThan(400);
    expect(summary).toContain("…");
  });
});

describe("mapIqsPageItems", () => {
  it("maps IQS page items into normalized search results", () => {
    const results = mapIqsPageItems([
      {
        title: "杭州美食",
        link: "https://example.com/food",
        summary: "推荐几家本地小吃",
      },
      {
        title: "  ",
        link: "https://example.com/invalid",
        summary: "应被过滤",
      },
    ]);

    expect(results).toEqual([
      { title: "杭州美食", url: "https://example.com/food", snippet: "推荐几家本地小吃" },
    ]);
  });

  it("falls back to snippet and mainText when summary is missing", () => {
    const results = mapIqsPageItems([
      { title: "A", link: "https://a.test", snippet: "snippet text" },
      { title: "B", link: "https://b.test", mainText: "main body" },
    ]);

    expect(results).toEqual([
      { title: "A", url: "https://a.test", snippet: "snippet text" },
      { title: "B", url: "https://b.test", snippet: "main body" },
    ]);
  });
});

describe("searchWeb", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls IQS unified search when provider is iqs", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          pageItems: [{ title: "杭州美食", link: "https://example.com/food", summary: "本地小吃推荐" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const env = {
      searchProvider: "iqs",
      aliyunIqsApiKey: "test-key",
      aliyunIqsBaseUrl: "https://cloud-iqs.aliyuncs.com",
    } as AppEnv;

    const results = await searchWeb("杭州美食", env);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloud-iqs.aliyuncs.com/search/unified",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer test-key",
        }),
      }),
    );
    expect(results).toEqual([
      { title: "杭州美食", url: "https://example.com/food", snippet: "本地小吃推荐" },
    ]);
  });

  it("throws when iqs provider is selected without an API key", async () => {
    const env = {
      searchProvider: "iqs",
      aliyunIqsApiKey: undefined,
      aliyunIqsBaseUrl: "https://cloud-iqs.aliyuncs.com",
    } as AppEnv;

    await expect(searchWeb("杭州美食", env)).rejects.toThrow("ALIYUN_IQS_API_KEY is required");
  });
});
