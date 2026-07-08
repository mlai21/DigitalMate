import type { LlmPurpose } from "@/server/llm/types";
import type { AppEnv } from "@/server/config/env";
import type { LlmClient } from "@/server/llm/types";
import { KieClaudeClient } from "@/server/llm/kie-claude";
import { KieGeminiClient } from "@/server/llm/kie-gemini";
import { MockLlmClient } from "@/server/llm/mock";

export type LlmRouteConfig = {
  main: string;
  light: string;
};

export type LlmClientName = "claude" | "gemini" | "mock";

export function chooseLlmClientName(purpose: LlmPurpose, config: LlmRouteConfig): LlmClientName {
  const model = purpose === "main" ? config.main : config.light;
  if (/claude/i.test(model)) return "claude";
  if (/gemini/i.test(model)) return "gemini";
  return "mock";
}

export function getLlmClient(purpose: LlmPurpose, env: AppEnv, routeConfig?: LlmRouteConfig): { client: LlmClient; model: string } {
  const config = routeConfig ?? { main: env.llmModelMain, light: env.llmModelLight };
  const model = purpose === "main" ? config.main : config.light;
  const clientName = env.kieAiApiKey ? chooseLlmClientName(purpose, config) : "mock";

  if (clientName === "claude") return { client: new KieClaudeClient(env), model };
  if (clientName === "gemini") return { client: new KieGeminiClient(env), model };
  return { client: new MockLlmClient(), model: `mock-${purpose}` };
}
