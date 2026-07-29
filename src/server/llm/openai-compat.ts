import type { AppEnv } from "@/server/config/env";
import { formatDocumentAttachments } from "@/server/llm/attachments";
import { LlmProviderError, providerErrorStatus } from "@/server/llm/errors";
import type { LlmClient, LlmMessage, LlmStreamEvent, LlmStreamInput, LlmTool } from "@/server/llm/types";
import { collectStreamText } from "@/server/llm/types";

/**
 * On the KIE gateway the endpoint path — not the request body — decides which
 * model answers: every model has its own `/{model}/v1/chat/completions` route,
 * and a path that is not provisioned answers 422 "The model is not supported".
 * Deriving the path from the model id is therefore required for anything other
 * than the single model the legacy env var pointed at.
 */
export function kieOpenAiCompatPath(model: string): string {
  return `/${model}/v1/chat/completions`;
}


/**
 * Generic client for OpenAI-compatible chat completions endpoints
 * (KIE.AI model routes and Alibaba Model Studio today; any
 * /v1/chat/completions provider tomorrow).
 */
export class OpenAiCompatClient implements LlmClient {
  constructor(private readonly config: { url: string; apiKey: string }) {}

  /**
   * Builds a client for one KIE-hosted model.
   *
   * `GEMINI_3_5_FLASH_ENDPOINT` stays honoured for its own model so existing
   * deployments that point it somewhere custom keep working; every other model
   * resolves through {@link kieOpenAiCompatPath}.
   */
  static forKieModel(model: string, env: AppEnv): OpenAiCompatClient {
    const path = model === "gemini-3-5-flash-openai" && env.geminiEndpoint
      ? env.geminiEndpoint
      : kieOpenAiCompatPath(model);
    return new OpenAiCompatClient({
      url: `${env.kieAiBaseUrl}${path}`,
      apiKey: env.kieAiApiKey ?? "",
    });
  }

  /** Alibaba Model Studio (DashScope) compatible-mode, used for Qwen models. */
  static forModelStudio(env: AppEnv): OpenAiCompatClient {
    return new OpenAiCompatClient({
      url: `${env.modelStudioBaseUrl.replace(/\/$/, "")}/chat/completions`,
      apiKey: env.modelStudioApiKey ?? "",
    });
  }

  async *stream(input: LlmStreamInput): AsyncIterable<LlmStreamEvent> {
    const response = await fetch(this.config.url, {
      method: "POST",
      signal: input.signal,
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
      // Providers put the actionable part in the body (which region rejected the
      // key, which quota ran out), so a bare status is not enough to act on.
      const body = await response.text().catch(() => "");
      throw new LlmProviderError({
        provider: "openai-compat",
        model: input.model,
        status: response.status,
        message: `LLM request failed with status ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
        detail: body,
      });
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      const body = await response.text();
      throw new LlmProviderError({
        provider: "openai-compat",
        model: input.model,
        status: providerErrorStatus(body) ?? response.status,
        message: `LLM request failed with status ${response.status}: ${body.slice(0, 200)}`,
        detail: body,
      });
    }

    const pendingToolCalls = new Map<number, { id: string; name: string; argumentChunks: string[] }>();

    for await (const line of readSseLines(response.body, input.signal)) {
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

  async completeText(input: {
    messages: LlmMessage[];
    model: string;
    signal?: AbortSignal;
  }): Promise<string> {
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
    if (message.content.trim()) content.push({ type: "text", text: message.content });
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

async function* readSseLines(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<string> {
  signal?.throwIfAborted();
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let cancellation: Promise<void> | undefined;
  const cancelReader = () => {
    cancellation ??= reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", cancelReader, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        signal?.throwIfAborted();
        yield line;
      }
    }
    signal?.throwIfAborted();
    if (buffer) yield buffer;
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    await cancellation;
    reader.releaseLock();
  }
}
