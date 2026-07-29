import type { LlmPurpose } from "@/server/llm/types";
import type { AppEnv } from "@/server/config/env";
import type { LlmClient } from "@/server/llm/types";
import { AnthropicClient } from "@/server/llm/anthropic";
import { OpenAiCompatClient } from "@/server/llm/openai-compat";
import { MockLlmClient } from "@/server/llm/mock";

export type LlmRouteConfig = {
  main: string;
  light: string;
};

export type LlmClientName = "anthropic" | "openai" | "model-studio" | "mock";

export function chooseLlmClientName(purpose: LlmPurpose, config: LlmRouteConfig): LlmClientName {
  return clientNameForModel(purpose === "main" ? config.main : config.light);
}

/**
 * Qwen models are not on the KIE gateway; they are served by Alibaba Model
 * Studio, which needs its own base URL and credential.
 */
export function clientNameForModel(model: string): Exclude<LlmClientName, "mock"> {
  if (/claude/i.test(model)) return "anthropic";
  if (/^qwen/i.test(model)) return "model-studio";
  return "openai";
}

export function getLlmClient(purpose: LlmPurpose, env: AppEnv, routeConfig?: LlmRouteConfig): { client: LlmClient; model: string } {
  const config = routeConfig ?? { main: env.llmModelMain, light: env.llmModelLight };
  const model = purpose === "main" ? config.main : config.light;
  const client = getLlmClientForModel(model, env);
  return client ? { client, model } : { client: new MockLlmClient(), model: `mock-${purpose}` };
}

/**
 * Returns null when the provider this model belongs to has no credential
 * configured, so callers can skip it instead of failing a live turn.
 */
export function getLlmClientForModel(model: string, env: AppEnv): LlmClient | null {
  switch (clientNameForModel(model)) {
    case "anthropic":
      return env.kieAiApiKey ? new AnthropicClient(env) : null;
    case "openai":
      return env.kieAiApiKey ? OpenAiCompatClient.forKieModel(model, env) : null;
    case "model-studio":
      return env.modelStudioApiKey ? OpenAiCompatClient.forModelStudio(env) : null;
  }
}
