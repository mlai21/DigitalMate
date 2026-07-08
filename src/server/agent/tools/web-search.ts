import { load } from "cheerio";

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

export async function searchWeb(query: string): Promise<WebSearchResult[]> {
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

export function summarizeSearchResults(results: WebSearchResult[]): string {
  if (results.length === 0) return "没有找到可靠搜索结果。";
  return results.map((result, index) => `${index + 1}. ${result.title}：${result.snippet} (${result.url})`).join("\n");
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
