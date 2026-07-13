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

  it("serializes user image and document attachments as Anthropic content blocks", async () => {
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
          {
            role: "user",
            content: "看一下",
            attachments: [
              { kind: "image", fileName: "cat.png", mimeType: "image/png", base64: "aGVsbG8=" },
              {
                kind: "document",
                fileName: "notes.md",
                mimeType: "text/markdown",
                text: "正文",
                truncated: false,
              },
            ],
          },
        ],
      }),
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages[0].content).toHaveLength(3);
    expect(body.messages[0].content[0]).toEqual({ type: "text", text: "看一下" });
    expect(body.messages[0].content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
    });
    expect(body.messages[0].content[2]).toEqual({
      type: "text",
      text: expect.stringMatching(
        /文件名：notes\.md[\s\S]*不可信用户数据[\s\S]*<<<DIGITALMATE_ATTACHMENT_([a-f0-9]{64})_(\d+)_START>>>[\s\S]*正文[\s\S]*<<<DIGITALMATE_ATTACHMENT_\1_\2_END>>>/,
      ),
    });
  });

  it("keeps legacy messages as strings and ignores non-user attachments", async () => {
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
          {
            role: "system",
            content: "系统规则",
            attachments: [
              {
                kind: "document",
                fileName: "hidden.txt",
                mimeType: "text/plain",
                text: "不能进入系统提示",
                truncated: false,
              },
            ],
          },
          { role: "user", content: "普通消息" },
        ],
      }),
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.system).toBe("系统规则");
    expect(body.messages).toEqual([{ role: "user", content: "普通消息" }]);
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
