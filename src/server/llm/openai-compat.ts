import type { AppEnv } from "@/server/config/env";
import { formatDocumentAttachments } from "@/server/llm/attachments";
import type { LlmClient, LlmMessage, LlmStreamEvent, LlmStreamInput, LlmTool } from "@/server/llm/types";
import { collectStreamText } from "@/server/llm/types";

/**
 * Generic client for OpenAI-compatible chat completions endpoints
 * (KIE.AI Gemini route today; any /v1/chat/completions provider tomorrow).
 */
export class OpenAiCompatClient implements LlmClient {
  constructor(private readonly config: { url: string; apiKey: string }) {}

  static fromEnv(env: AppEnv): OpenAiCompatClient {
    return new OpenAiCompatClient({
      url: `${env.kieAiBaseUrl}${env.geminiEndpoint}`,
      apiKey: env.kieAiApiKey ?? "",
    });
  }

  async *stream(input: LlmStreamInput): AsyncIterable<LlmStreamEvent> {
    const response = await fetch(this.config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: input.model,
        stream: true,
        messages: input.messages.map(toOpenAiMessage),
        ...(input.tools && input.tools.length > 0 ? { tools: input.tools.map(toOpenAiTool) } : {}),
      }),
    });

    if (!response.ok || !response.body) {
      throw new Error(`LLM request failed with status ${response.status}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      const body = await response.text();
      throw new Error(`LLM request failed with status ${response.status}: ${body.slice(0, 200)}`);
    }

    const pendingToolCalls = new Map<number, { id: string; name: string; argumentChunks: string[] }>();

    for await (const line of readSseLines(response.body)) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (!data || data === "[DONE]") continue;
      const event = JSON.parse(data) as {
        choices?: Array<{
          delta?: {
            content?: string;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
      };
      const delta = event.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) yield { type: "text", text: delta.content };
      for (const chunk of delta.tool_calls ?? []) {
        const index = chunk.index ?? 0;
        const pending = pendingToolCalls.get(index) ?? { id: "", name: "", argumentChunks: [] };
        if (chunk.id) pending.id = chunk.id;
        if (chunk.function?.name) pending.name = chunk.function.name;
        if (chunk.function?.arguments) pending.argumentChunks.push(chunk.function.arguments);
        pendingToolCalls.set(index, pending);
      }
    }

    for (const [index, pending] of [...pendingToolCalls.entries()].sort(([a], [b]) => a - b)) {
      yield {
        type: "tool_call",
        toolCall: {
          id: pending.id || `tool_${index}`,
          name: pending.name,
          arguments: pending.argumentChunks.join("") || "{}",
        },
      };
    }
  }

  async completeText(input: { messages: LlmMessage[]; model: string }): Promise<string> {
    return collectStreamText(this.stream(input));
  }
}

function toOpenAiTool(tool: LlmTool) {
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  };
}

function toOpenAiMessage(message: LlmMessage) {
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId ?? "", content: message.content };
  }
  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  if (message.role === "user" && message.attachments && message.attachments.length > 0) {
    const formattedDocuments = formatDocumentAttachments(
      message.attachments.filter((attachment) => attachment.kind === "document"),
    );
    let documentIndex = 0;
    const content: Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    > = [];
    if (message.content) content.push({ type: "text", text: message.content });
    for (const attachment of message.attachments) {
      if (attachment.kind === "image") {
        content.push({
          type: "image_url",
          image_url: { url: `data:${attachment.mimeType};base64,${attachment.base64}` },
        });
      } else {
        content.push({ type: "text", text: formattedDocuments[documentIndex] });
        documentIndex += 1;
      }
    }
    return { role: "user", content };
  }
  return { role: message.role, content: message.content };
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
