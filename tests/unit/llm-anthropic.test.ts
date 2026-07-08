import { afterEach, describe, expect, it, vi } from "vitest";
import { readEnv } from "@/server/config/env";
import { AnthropicClient } from "@/server/llm/anthropic";
import type { LlmStreamEvent } from "@/server/llm/types";

describe("AnthropicClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends bearer authorization and streams text deltas", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        [
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"O"}}',
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"K"}}',
          "",
        ].join("\n"),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new AnthropicClient(env());
    const events = await collect(client.stream({ model: "claude-opus-4-8", messages: [{ role: "user", content: "Hi" }] }));

    expect(events).toEqual([
      { type: "text", text: "O" },
      { type: "text", text: "K" },
    ]);
    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers).toMatchObject({
      authorization: "Bearer test-key",
      "anthropic-version": "2023-06-01",
    });
    expect(options.headers).not.toHaveProperty("x-api-key");
  });

  it("assembles tool_use blocks into tool_call events", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          [
            'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"toolu_1","name":"web_search"}}',
            'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"query\\":"}}',
            'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"\\"北京天气\\"}"}}',
            'data: {"type":"content_block_stop"}',
            "",
          ].join("\n"),
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
    );

    const client = new AnthropicClient(env());
    const events = await collect(
      client.stream({
        model: "claude-opus-4-8",
        messages: [{ role: "user", content: "查天气" }],
        tools: [{ name: "web_search", description: "搜索", parameters: { type: "object" } }],
      }),
    );

    expect(events).toEqual([
      { type: "tool_call", toolCall: { id: "toolu_1", name: "web_search", arguments: '{"query":"北京天气"}' } },
    ]);
  });

  it("serializes tool results as anthropic tool_result user turns", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"好"}}\n', {
        headers: { "content-type": "text/event-stream" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new AnthropicClient(env());
    await collect(
      client.stream({
        model: "claude-opus-4-8",
        messages: [
          { role: "user", content: "查天气" },
          { role: "assistant", content: "", toolCalls: [{ id: "toolu_1", name: "web_search", arguments: '{"query":"北京"}' }] },
          { role: "tool", content: "北京晴", toolCallId: "toolu_1" },
        ],
      }),
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages[1].content).toEqual([{ type: "tool_use", id: "toolu_1", name: "web_search", input: { query: "北京" } }]);
    expect(body.messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "北京晴" }],
    });
  });

  it("throws when KIE returns a JSON error body with HTTP 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: 401, msg: "Unauthorized" }), {
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const client = new AnthropicClient(env());

    await expect(collect(client.stream({ model: "claude-opus-4-8", messages: [{ role: "user", content: "Hi" }] }))).rejects.toThrow(
      "Claude request failed",
    );
  });
});

function env() {
  return readEnv({
    KIE_AI_API_KEY: "test-key",
    KIE_AI_BASE_URL: "https://api.kie.ai",
    CLAUDE_MESSAGES_ENDPOINT: "/claude/v1/messages",
    ANTHROPIC_API_VERSION: "2023-06-01",
  });
}

async function collect(stream: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}
