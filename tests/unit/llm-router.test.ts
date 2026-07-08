import { describe, expect, it } from "vitest";
import { readEnv } from "@/server/config/env";
import { chooseLlmClientName, getLlmClient } from "@/server/llm/router";

describe("chooseLlmClientName", () => {
  it("routes main and light purposes from config", () => {
    expect(
      chooseLlmClientName("main", {
        main: "claude-opus-4-8",
        light: "gemini-3-5-flash-openai",
      }),
    ).toBe("anthropic");
    expect(
      chooseLlmClientName("light", {
        main: "claude-opus-4-8",
        light: "gemini-3-5-flash-openai",
      }),
    ).toBe("openai");
  });

  it("uses explicit route config ahead of environment model defaults", () => {
    const routed = getLlmClient(
      "main",
      readEnv({
        KIE_AI_API_KEY: "key",
        LLM_MODEL_MAIN: "claude-opus-4-8",
        LLM_MODEL_LIGHT: "gemini-3-5-flash-openai",
      }),
      { main: "gemini-3-5-flash-openai", light: "claude-opus-4-8" },
    );

    expect(routed.model).toBe("gemini-3-5-flash-openai");
    expect(routed.client.constructor.name).toBe("OpenAiCompatClient");
  });

  it("falls back to the mock client without an API key", () => {
    const routed = getLlmClient("light", readEnv({}));

    expect(routed.client.constructor.name).toBe("MockLlmClient");
    expect(routed.model).toBe("mock-light");
  });
});
