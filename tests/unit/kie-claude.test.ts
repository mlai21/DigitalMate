import { afterEach, describe, expect, it, vi } from "vitest";
import { readEnv } from "@/server/config/env";
import { KieClaudeClient } from "@/server/llm/kie-claude";

describe("KieClaudeClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends bearer authorization for Claude requests", async () => {
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

    const client = new KieClaudeClient(env());
    const text = await collect(client.streamText({ model: "claude-opus-4-8", messages: [{ role: "user", content: "Hi" }] }));

    expect(text).toBe("OK");
    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers).toMatchObject({
      authorization: "Bearer test-key",
      "anthropic-version": "2023-06-01",
    });
    expect(options.headers).not.toHaveProperty("x-api-key");
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

    const client = new KieClaudeClient(env());

    await expect(collect(client.streamText({ model: "claude-opus-4-8", messages: [{ role: "user", content: "Hi" }] }))).rejects.toThrow(
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

async function collect(stream: AsyncIterable<string>): Promise<string> {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks.join("");
}
