import type { AppEnv } from "@/server/config/env";
import { formatDocumentAttachments } from "@/server/llm/attachments";
import type { LlmClient, LlmMessage, LlmStreamEvent, LlmStreamInput, LlmTool } from "@/server/llm/types";
import { collectStreamText } from "@/server/llm/types";

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/webp"; data: string };
    }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
};

export class AnthropicClient implements LlmClient {
  constructor(private readonly env: AppEnv) {}

  async *stream(input: LlmStreamInput): AsyncIterable<LlmStreamEvent> {
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
        system: input.messages.find((message) => message.role === "system")?.content,
        messages: toAnthropicMessages(input.messages),
        ...(input.tools && input.tools.length > 0 ? { tools: input.tools.map(toAnthropicTool) } : {}),
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

    let pendingToolCall: { id: string; name: string; argumentChunks: string[] } | null = null;

    for await (const line of readSseLines(response.body)) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (!data || data === "[DONE]") continue;
      const event = JSON.parse(data) as {
        type?: string;
        content_block?: { type?: string; id?: string; name?: string };
        delta?: { type?: string; text?: string; partial_json?: string };
      };

      if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
        pendingToolCall = {
          id: event.content_block.id ?? `tool_${Date.now()}`,
          name: event.content_block.name ?? "",
          argumentChunks: [],
        };
        continue;
      }
      if (event.type === "content_block_delta") {
        if (event.delta?.type === "input_json_delta" && pendingToolCall) {
          pendingToolCall.argumentChunks.push(event.delta.partial_json ?? "");
          continue;
        }
        if (event.delta?.text) {
          yield { type: "text", text: event.delta.text };
        }
        continue;
      }
      if (event.type === "content_block_stop" && pendingToolCall) {
        yield {
          type: "tool_call",
          toolCall: {
            id: pendingToolCall.id,
            name: pendingToolCall.name,
            arguments: pendingToolCall.argumentChunks.join("") || "{}",
          },
        };
        pendingToolCall = null;
      }
    }
  }

  async completeText(input: { messages: LlmMessage[]; model: string }): Promise<string> {
    return collectStreamText(this.stream(input));
  }
}

function toAnthropicTool(tool: LlmTool) {
  return { name: tool.name, description: tool.description, input_schema: tool.parameters };
}

function toAnthropicMessages(messages: LlmMessage[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const block: AnthropicContentBlock = {
        type: "tool_result",
        tool_use_id: message.toolCallId ?? "",
        content: message.content,
      };
      // Anthropic requires consecutive tool results to live in one user turn.
      const last = result[result.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content) && last.content.every((item) => item.type === "tool_result")) {
        last.content.push(block);
      } else {
        result.push({ role: "user", content: [block] });
      }
      continue;
    }
    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      const blocks: AnthropicContentBlock[] = [];
      if (message.content.trim()) blocks.push({ type: "text", text: message.content });
      for (const call of message.toolCalls) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: safeParseJson(call.arguments) });
      }
      result.push({ role: "assistant", content: blocks });
      continue;
    }
    if (message.role === "user" && message.attachments && message.attachments.length > 0) {
      const formattedDocuments = formatDocumentAttachments(
        message.attachments.filter((attachment) => attachment.kind === "document"),
      );
      let documentIndex = 0;
      const blocks: AnthropicContentBlock[] = [];
      if (message.content) blocks.push({ type: "text", text: message.content });
      for (const attachment of message.attachments) {
        if (attachment.kind === "image") {
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: attachment.mimeType, data: attachment.base64 },
          });
        } else {
          blocks.push({ type: "text", text: formattedDocuments[documentIndex] });
          documentIndex += 1;
        }
      }
      result.push({ role: "user", content: blocks });
      continue;
    }
    result.push({ role: message.role, content: message.content });
  }
  return result;
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return {};
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
