export type ModelPurposeTag = "main" | "light";

export type ModelCatalogEntry = {
  /** Model identifier passed to the API (and stored in settings). */
  id: string;
  label: string;
  provider: "Anthropic" | "Google" | "OpenAI" | "Alibaba";
  description: string;
  recommendedFor: ModelPurposeTag[];
  supportsImageInput: boolean;
};

/**
 * Models reachable through the configured providers — the KIE.AI gateway for
 * Anthropic/Google/OpenAI ids, Alibaba Model Studio for Qwen ids. The admin UI
 * offers these as choices but still accepts a custom model id, so the catalog
 * never blocks using a model that is not listed here.
 *
 * Image-input contract audit verified 2026-07-14 for KIE ids: only the exact
 * `gemini-3-5-flash-openai` endpoint has a matching contract
 * (https://docs.kie.ai/market/gemini/gemini-3-5-flash-openai). Other KIE ids
 * stay false until KIE documents that exact endpoint/model id.
 *
 * Model Studio ids verified 2026-07-30 against the live endpoint: `qwen3.7-plus`
 * describes a real photo, `qwen3.7-max` rejects image content outright
 * ("Unexpected item type in content").
 */
export const MODEL_CATALOG: ModelCatalogEntry[] = [
  {
    id: "claude-opus-4-8",
    label: "Claude Opus 4.8",
    provider: "Anthropic",
    description: "能力优先的旗舰模型，适合主对话与复杂任务。",
    recommendedFor: ["main"],
    supportsImageInput: false,
  },
  {
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    provider: "Anthropic",
    description: "能力与成本均衡，可作为主对话的经济选项。",
    recommendedFor: ["main"],
    supportsImageInput: false,
  },
  {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    provider: "Anthropic",
    description: "低延迟低成本，适合高频轻量调用。",
    recommendedFor: ["light"],
    supportsImageInput: false,
  },
  {
    id: "gemini-3-5-pro-openai",
    label: "Gemini 3.5 Pro",
    provider: "Google",
    description: "多模态旗舰（OpenAI 兼容端点），适合主对话。",
    recommendedFor: ["main"],
    supportsImageInput: false,
  },
  {
    id: "gemini-3-5-flash-openai",
    label: "Gemini 3.5 Flash",
    provider: "Google",
    description: "快速便宜（OpenAI 兼容端点），适合记忆抽取、复盘等轻量任务。",
    recommendedFor: ["light"],
    supportsImageInput: true,
  },
  {
    id: "gemini-3-6-flash-openai",
    label: "Gemini 3.6 Flash",
    provider: "Google",
    description: "更新一代的快速模型（OpenAI 兼容端点），主对话降级与轻量任务都可用。",
    recommendedFor: ["main", "light"],
    supportsImageInput: false,
  },
  {
    id: "qwen3.7-max",
    label: "Qwen3.7-Max",
    provider: "Alibaba",
    description: "百炼旗舰模型（需配置 Model Studio 密钥），长上下文与工具调用能力强，仅支持文本。",
    recommendedFor: ["main"],
    supportsImageInput: false,
  },
  {
    id: "qwen3.7-plus",
    label: "Qwen3.7-Plus",
    provider: "Alibaba",
    description: "百炼均衡档（需配置 Model Studio 密钥），支持图片理解与工具调用，适合主对话与降级备用。",
    recommendedFor: ["main"],
    supportsImageInput: true,
  },
  {
    id: "gpt-5-2-openai",
    label: "GPT-5.2",
    provider: "OpenAI",
    description: "OpenAI 旗舰（OpenAI 兼容端点）。",
    recommendedFor: ["main"],
    supportsImageInput: false,
  },
  {
    id: "gpt-5-2-mini-openai",
    label: "GPT-5.2 mini",
    provider: "OpenAI",
    description: "轻量版本，适合高频低成本调用。",
    recommendedFor: ["light"],
    supportsImageInput: false,
  },
];

export function groupCatalogByProvider(): Array<{ provider: string; models: ModelCatalogEntry[] }> {
  const groups = new Map<string, ModelCatalogEntry[]>();
  for (const entry of MODEL_CATALOG) {
    const list = groups.get(entry.provider) ?? [];
    list.push(entry);
    groups.set(entry.provider, list);
  }
  return [...groups.entries()].map(([provider, models]) => ({ provider, models }));
}

export function isCatalogModel(modelId: string): boolean {
  return MODEL_CATALOG.some((entry) => entry.id === modelId);
}

export function supportsImageInput(modelId: string): boolean {
  return MODEL_CATALOG.find((entry) => entry.id === modelId)?.supportsImageInput ?? false;
}
