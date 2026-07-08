export type LlmMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type LlmPurpose = "main" | "light";

export type LlmClient = {
  streamText(input: { messages: LlmMessage[]; model: string }): AsyncIterable<string>;
  completeText(input: { messages: LlmMessage[]; model: string }): Promise<string>;
};
