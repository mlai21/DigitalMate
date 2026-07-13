export type ModelPurposeTag = "main" | "light";

export type ModelCatalogEntry = {
  /** Model identifier passed to the API (and stored in settings). */
  id: string;
  label: string;
  provider: "Anthropic" | "Google" | "OpenAI";
  description: string;
  recommendedFor: ModelPurposeTag[];
  supportsImageInput: boolean;
};

/**
 * Models reachable through the configured KIE.AI gateway. The admin UI offers
 * these as choices but still accepts a custom model id, so the catalog never
 * blocks using a model that is not listed here.
 */
export const MODEL_CATALOG: ModelCatalogEntry[] = [
  {
    id: "claude-opus-4-8",
    label: "Claude Opus 4.8",
    provider: "Anthropic",
    description: "能力优先的旗舰模型，适合主对话与复杂任务。",
    recommendedFor: ["main"],
    supportsImageInput: true,
  },
  {
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    provider: "Anthropic",
    description: "能力与成本均衡，可作为主对话的经济选项。",
    recommendedFor: ["main"],
    supportsImageInput: true,
  },
  {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    provider: "Anthropic",
    description: "低延迟低成本，适合高频轻量调用。",
    recommendedFor: ["light"],
    supportsImageInput: true,
  },
  {
    id: "gemini-3-5-pro-openai",
    label: "Gemini 3.5 Pro",
    provider: "Google",
    description: "多模态旗舰（OpenAI 兼容端点），适合主对话。",
    recommendedFor: ["main"],
    supportsImageInput: true,
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
    id: "gpt-5-2-openai",
    label: "GPT-5.2",
    provider: "OpenAI",
    description: "OpenAI 旗舰（OpenAI 兼容端点）。",
    recommendedFor: ["main"],
    supportsImageInput: true,
  },
  {
    id: "gpt-5-2-mini-openai",
    label: "GPT-5.2 mini",
    provider: "OpenAI",
    description: "轻量版本，适合高频低成本调用。",
    recommendedFor: ["light"],
    supportsImageInput: true,
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
