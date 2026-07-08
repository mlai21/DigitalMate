import type { AppEnv } from "@/server/config/env";
import type { LlmClient, LlmMessage } from "@/server/llm/types";

export class KieGeminiClient implements LlmClient {
  constructor(private readonly env: AppEnv) {}

  async *streamText(input: { messages: LlmMessage[]; model: string }): AsyncIterable<string> {
    const response = await fetch(`${this.env.kieAiBaseUrl}${this.env.geminiEndpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.env.kieAiApiKey ?? ""}`,
      },
      body: JSON.stringify({
        model: input.model,
        stream: true,
        messages: input.messages.map((message) => ({
          role: message.role === "system" ? "user" : message.role,
          content: [{ type: "text", text: message.content }],
        })),
      }),
    });

    if (!response.ok || !response.body) {
      throw new Error(`Gemini request failed with status ${response.status}`);
    }

    for await (const line of readSseLines(response.body)) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (!data || data === "[DONE]") continue;
      const event = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
      const content = event.choices?.[0]?.delta?.content;
      if (content) yield content;
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
