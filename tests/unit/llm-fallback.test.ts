import { describe, expect, it, vi } from "vitest";
import { readEnv } from "@/server/config/env";
import { LlmProviderError } from "@/server/llm/errors";
import {
  createFallbackLlmClient,
  getMainLlmClientWithFallbacks,
  type LlmFallbackEvent,
} from "@/server/llm/fallback";
import {
  collectStreamText,
  type LlmClient,
  type LlmStreamEvent,
  type LlmStreamInput,
} from "@/server/llm/types";

function providerError(status: number): LlmProviderError {
  return new LlmProviderError({
    provider: "openai-compat",
    model: "primary",
    status,
    message: `LLM request failed with status ${status}`,
  });
}

function textClient(text: string): LlmClient {
  return {
    async *stream(): AsyncIterable<LlmStreamEvent> {
      yield { type: "text", text };
    },
    completeText: async () => text,
  };
}

function failingClient(error: unknown, options: { emitFirst?: string } = {}): {
  client: LlmClient;
  calls: LlmStreamInput[];
} {
  const calls: LlmStreamInput[] = [];
  return {
    calls,
    client: {
      async *stream(input: LlmStreamInput): AsyncIterable<LlmStreamEvent> {
        calls.push(input);
        if (options.emitFirst) yield { type: "text", text: options.emitFirst };
        throw error;
      },
      completeText: async () => {
        throw error;
      },
    },
  };
}

async function collect(stream: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const events: LlmStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("createFallbackLlmClient", () => {
  it("moves to the next model when the provider is unavailable", async () => {
    const primary = failingClient(providerError(500));
    const events: LlmFallbackEvent[] = [];
    const routed = createFallbackLlmClient({
      candidates: [
        { client: primary.client, model: "claude-opus-4-8" },
        { client: textClient("备用回答"), model: "gemini-3-6-flash-openai" },
      ],
      onFallback: (event) => events.push(event),
    });

    expect(routed.model).toBe("claude-opus-4-8");
    expect(await collect(routed.client.stream({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "在吗" }],
    }))).toEqual([{ type: "text", text: "备用回答" }]);
    expect(events).toEqual([{
      from: "claude-opus-4-8",
      to: "gemini-3-6-flash-openai",
      code: "llm_http_500",
      status: 500,
    }]);
  });

  it("asks each candidate with its own model id", async () => {
    const primary = failingClient(providerError(529));
    const secondary = failingClient(providerError(500));
    const routed = createFallbackLlmClient({
      candidates: [
        { client: primary.client, model: "claude-opus-4-8" },
        { client: secondary.client, model: "qwen3.7-max" },
      ],
    });

    await expect(collect(routed.client.stream({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "在吗" }],
    }))).rejects.toThrow("LLM request failed with status 500");
    expect(primary.calls[0]?.model).toBe("claude-opus-4-8");
    expect(secondary.calls[0]?.model).toBe("qwen3.7-max");
  });

  it("stays with the primary once it has emitted, so no reply is duplicated", async () => {
    const primary = failingClient(providerError(500), { emitFirst: "开头" });
    const secondary = vi.fn();
    const routed = createFallbackLlmClient({
      candidates: [
        { client: primary.client, model: "claude-opus-4-8" },
        {
          client: { stream: secondary as never, completeText: secondary as never },
          model: "gemini-3-6-flash-openai",
        },
      ],
    });

    await expect(collect(routed.client.stream({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "在吗" }],
    }))).rejects.toThrow("LLM request failed with status 500");
    expect(secondary).not.toHaveBeenCalled();
  });

  it("does not retry a request the provider rejected", async () => {
    const primary = failingClient(providerError(422));
    const secondary = vi.fn();
    const routed = createFallbackLlmClient({
      candidates: [
        { client: primary.client, model: "claude-opus-4-8" },
        {
          client: { stream: secondary as never, completeText: secondary as never },
          model: "gemini-3-6-flash-openai",
        },
      ],
    });

    await expect(collect(routed.client.stream({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "在吗" }],
    }))).rejects.toThrow("LLM request failed with status 422");
    expect(secondary).not.toHaveBeenCalled();
  });

  it("keeps the fallback choice for the rest of the turn", async () => {
    const primary = failingClient(providerError(500));
    const routed = createFallbackLlmClient({
      candidates: [
        { client: primary.client, model: "claude-opus-4-8" },
        { client: textClient("好"), model: "gemini-3-6-flash-openai" },
      ],
    });
    const input = {
      model: "claude-opus-4-8",
      messages: [{ role: "user" as const, content: "在吗" }],
    };

    await collect(routed.client.stream(input));
    await collect(routed.client.stream(input));

    expect(primary.calls).toHaveLength(1);
  });

  it("routes completeText through the same chain", async () => {
    const primary = failingClient(providerError(500));
    const routed = createFallbackLlmClient({
      candidates: [
        { client: primary.client, model: "claude-opus-4-8" },
        { client: textClient("轻量结论"), model: "gemini-3-6-flash-openai" },
      ],
    });

    expect(await routed.client.completeText({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "在吗" }],
    })).toBe("轻量结论");
  });

  it("propagates an abort instead of trying another model", async () => {
    const controller = new AbortController();
    controller.abort();
    const primary = failingClient(providerError(500));
    const secondary = vi.fn();
    const routed = createFallbackLlmClient({
      candidates: [
        { client: primary.client, model: "claude-opus-4-8" },
        {
          client: { stream: secondary as never, completeText: secondary as never },
          model: "gemini-3-6-flash-openai",
        },
      ],
    });

    await expect(collect(routed.client.stream({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "在吗" }],
      signal: controller.signal,
    }))).rejects.toThrow("LLM request failed with status 500");
    expect(secondary).not.toHaveBeenCalled();
  });
});

describe("getMainLlmClientWithFallbacks", () => {
  const env = readEnv({
    KIE_AI_API_KEY: "key",
    MODEL_STUDIO_API_KEY: "studio-key",
  });
  const routeConfig = { main: "claude-opus-4-8", light: "gemini-3-5-flash-openai" };

  it("returns the primary untouched when no fallback is configured", () => {
    const routed = getMainLlmClientWithFallbacks({
      env,
      routeConfig,
      fallbackModels: [],
    });

    expect(routed.model).toBe("claude-opus-4-8");
    expect(routed.client.constructor.name).toBe("AnthropicClient");
  });

  it("drops fallbacks that duplicate the primary or lack a credential", async () => {
    const withoutStudio = readEnv({ KIE_AI_API_KEY: "key" });
    const events: LlmFallbackEvent[] = [];
    const routed = getMainLlmClientWithFallbacks({
      env: withoutStudio,
      routeConfig,
      fallbackModels: ["claude-opus-4-8", "qwen3.7-max"],
      onFallback: (event) => events.push(event),
    });

    // Only the primary survived, so the wrapper is bypassed entirely.
    expect(routed.client.constructor.name).toBe("AnthropicClient");
    expect(events).toEqual([]);
  });

  it("builds a chain across providers when both credentials exist", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (
      url.includes("dashscope")
        ? new Response(
            'data: {"choices":[{"delta":{"content":"百炼回答"}}]}\n\ndata: [DONE]\n\n',
            { headers: { "content-type": "text/event-stream" } },
          )
        : new Response(JSON.stringify({ code: 500, msg: "Internal error" }), {
            headers: { "content-type": "application/json" },
          })
    )));

    const routed = getMainLlmClientWithFallbacks({
      env,
      routeConfig,
      fallbackModels: ["qwen3.7-max"],
    });
    const text = await collectStreamText(routed.client.stream({
      model: routed.model,
      messages: [{ role: "user", content: "在吗" }],
    }));

    expect(text).toBe("百炼回答");
    vi.unstubAllGlobals();
  });
});
