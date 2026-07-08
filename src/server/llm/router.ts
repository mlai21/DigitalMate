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

export type LlmClientName = "anthropic" | "openai" | "mock";

export function chooseLlmClientName(purpose: LlmPurpose, config: LlmRouteConfig): LlmClientName {
  const model = purpose === "main" ? config.main : config.light;
  if (/claude/i.test(model)) return "anthropic";
  return "openai";
}

export function getLlmClient(purpose: LlmPurpose, env: AppEnv, routeConfig?: LlmRouteConfig): { client: LlmClient; model: string } {
  const config = routeConfig ?? { main: env.llmModelMain, light: env.llmModelLight };
  const model = purpose === "main" ? config.main : config.light;
  const clientName = env.kieAiApiKey ? chooseLlmClientName(purpose, config) : "mock";

  if (clientName === "anthropic") return { client: new AnthropicClient(env), model };
  if (clientName === "openai") return { client: OpenAiCompatClient.fromEnv(env), model };
  return { client: new MockLlmClient(), model: `mock-${purpose}` };
}
