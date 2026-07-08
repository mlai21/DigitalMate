import type { LlmClient, LlmStreamEvent, LlmStreamInput } from "@/server/llm/types";
import { collectStreamText } from "@/server/llm/types";

export class MockLlmClient implements LlmClient {
  async *stream(input: LlmStreamInput): AsyncIterable<LlmStreamEvent> {
    const lastUser = [...input.messages].reverse().find((message) => message.role === "user")?.content ?? "";
    const system = input.messages.find((message) => message.role === "system")?.content ?? "";
    const memoryHint = system.includes("可参考的长期记忆") ? "我还记得之前聊到的一些事。" : "";
    yield { type: "text", text: `${memoryHint}${buildLocalReply(lastUser)}` };
  }

  async completeText(input: Parameters<LlmClient["completeText"]>[0]): Promise<string> {
    return collectStreamText(this.stream(input));
  }
}

function buildLocalReply(userText: string): string {
  if (/提醒我/.test(userText)) return "好，我帮你记下这个提醒。";
  if (/天气|查一下|最新|搜索/.test(userText)) return "结论我会说得保守一点：出门前再看一眼最新情况会更稳。";
  return "我在。你刚说的我记下了，我们可以接着慢慢聊。";
}
