import type { AppEnv } from "@/server/config/env";
import type { LlmClient, LlmMessage } from "@/server/llm/types";

export class KieClaudeClient implements LlmClient {
  constructor(private readonly env: AppEnv) {}

  async *streamText(input: { messages: LlmMessage[]; model: string }): AsyncIterable<string> {
    const response = await fetch(`${this.env.kieAiBaseUrl}${this.env.claudeEndpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.env.kieAiApiKey ?? ""}`,
        "anthropic-version": this.env.anthropicVersion,
      },
      body: JSON.stringify({
        model: input.model,
        max_tokens: 4096,
        stream: true,
        messages: input.messages.filter((message) => message.role !== "system"),
        system: input.messages.find((message) => message.role === "system")?.content,
      }),
    });

    if (!response.ok || !response.body) {
      throw new Error(`Claude request failed with status ${response.status}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      const body = await response.text();
      throw new Error(`Claude request failed with status ${response.status}: ${body.slice(0, 200)}`);
    }

    for await (const line of readSseLines(response.body)) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (!data || data === "[DONE]") continue;
      const event = JSON.parse(data) as { type?: string; delta?: { text?: string } };
      if (event.type === "content_block_delta" && event.delta?.text) yield event.delta.text;
    }
  }

  async completeText(input: { messages: LlmMessage[]; model: string }): Promise<string> {
    const chunks = [];
    for await (const chunk of this.streamText(input)) chunks.push(chunk);
    return chunks.join("");
  }
}

async function* readSseLines(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) yield line;
  }
  if (buffer) yield buffer;
}
