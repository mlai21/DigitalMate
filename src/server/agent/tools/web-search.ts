import { load } from "cheerio";
import { readEnv, type AppEnv } from "@/server/config/env";

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

type IqsPageItem = {
  title?: string;
  link?: string;
  snippet?: string;
  summary?: string;
  mainText?: string;
};

type IqsSearchResponse = {
  pageItems?: IqsPageItem[];
  message?: string;
};

export async function searchWeb(query: string, env: AppEnv = readEnv()): Promise<WebSearchResult[]> {
  if (env.searchProvider === "iqs") {
    return searchWithIqs(query, env);
  }
  return searchWithDuckDuckGo(query);
}

export function summarizeSearchResults(results: WebSearchResult[]): string {
  if (results.length === 0) return "没有找到可靠搜索结果。";
  return results.map((result, index) => `${index + 1}. ${result.title}：${result.snippet} (${result.url})`).join("\n");
}

export function mapIqsPageItems(items: IqsPageItem[]): WebSearchResult[] {
  return items
    .map((item) => {
      const title = item.title?.trim() ?? "";
      const url = item.link?.trim() ?? "";
      const snippet = (item.snippet ?? item.summary ?? item.mainText ?? "").replace(/\s+/g, " ").trim();
      if (!title || !url) return null;
      return { title, url, snippet };
    })
    .filter((item): item is WebSearchResult => item !== null);
}

async function searchWithIqs(query: string, env: AppEnv): Promise<WebSearchResult[]> {
  if (!env.aliyunIqsApiKey) {
    throw new Error("ALIYUN_IQS_API_KEY is required when SEARCH_PROVIDER=iqs");
  }

  const response = await fetch(`${env.aliyunIqsBaseUrl.replace(/\/$/, "")}/search/unified`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.aliyunIqsApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query,
      engineType: "LiteAdvanced",
      contents: {
        mainText: false,
        markdownText: false,
        summary: true,
        rerankScore: true,
      },
      advancedParams: {
        numResults: 5,
      },
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`IQS search failed with status ${response.status}${detail ? `: ${detail}` : ""}`);
  }

  const payload = (await response.json()) as IqsSearchResponse;
  return mapIqsPageItems(payload.pageItems ?? []);
}

async function searchWithDuckDuckGo(query: string): Promise<WebSearchResult[]> {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: {
      "user-agent": "DigitalMate/0.1 (+https://localhost)",
    },
  });

  if (!response.ok) {
    throw new Error(`Search failed with status ${response.status}`);
  }

  const html = await response.text();
  const $ = load(html);
  const results: WebSearchResult[] = [];

  $(".result").each((_, element) => {
    const title = $(element).find(".result__title").text().replace(/\s+/g, " ").trim();
    const rawUrl = $(element).find(".result__a").attr("href") ?? "";
    const snippet = $(element).find(".result__snippet").text().replace(/\s+/g, " ").trim();
    const parsedUrl = normalizeDuckDuckGoUrl(rawUrl);
    if (title && parsedUrl) {
      results.push({ title, url: parsedUrl, snippet });
    }
  });

  return results.slice(0, 5);
}

function normalizeDuckDuckGoUrl(value: string): string {
  if (!value) return "";
  try {
    const parsed = new URL(value, "https://duckduckgo.com");
    const target = parsed.searchParams.get("uddg");
    return target ? decodeURIComponent(target) : parsed.toString();
  } catch {
    return "";
  }
}
