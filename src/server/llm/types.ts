export type LlmRole = "system" | "user" | "assistant" | "tool";

export type LlmToolCall = {
  id: string;
  name: string;
  /** JSON-encoded arguments as produced by the model. */
  arguments: string;
};

export type LlmAttachment =
  | {
      kind: "image";
      fileName: string;
      mimeType: "image/jpeg" | "image/png" | "image/webp";
      base64: string;
    }
  | {
      kind: "document";
      fileName: string;
      mimeType: string;
      text: string;
      truncated: boolean;
    };

export type LlmMessage = {
  role: LlmRole;
  content: string;
  /** User-provided attachments supplied as structured model input. */
  attachments?: LlmAttachment[];
  /** Present on assistant turns that requested tool calls. */
  toolCalls?: LlmToolCall[];
  /** Present on tool-result turns; links the result to the originating call. */
  toolCallId?: string;
};

export type LlmTool = {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  parameters: Record<string, unknown>;
};

export type LlmStreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; toolCall: LlmToolCall };

export type LlmPurpose = "main" | "light";

export type LlmStreamInput = {
  messages: LlmMessage[];
  model: string;
  tools?: LlmTool[];
};

export type LlmClient = {
  stream(input: LlmStreamInput): AsyncIterable<LlmStreamEvent>;
  completeText(input: { messages: LlmMessage[]; model: string }): Promise<string>;
};

export async function collectStreamText(stream: AsyncIterable<LlmStreamEvent>): Promise<string> {
  const chunks: string[] = [];
  for await (const event of stream) {
    if (event.type === "text") chunks.push(event.text);
  }
  return chunks.join("");
}
