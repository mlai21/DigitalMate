export function splitAssistantText(text: string): string[] {
  const clean = sanitizeAssistantText(text);
  const paragraphs = clean
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (paragraphs.length > 1) return paragraphs;

  return clean
    .split(/(?<=[。！？!?])\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function sanitizeAssistantText(text: string): string {
  return removeLeadingToolCallJson(text)
    .replace(/```(?:json)?\s*[\s\S]*?["']tool_call["'][\s\S]*?```/gi, "")
    .replace(/\{["']tool_call["']\s*:\s*["'][^"']+["']\}/g, "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .replace(/<(?:thinking|reasoning|analysis)>[\s\S]*?<\/(?:thinking|reasoning|analysis)>/gi, "")
    .replace(/^(?:系统提示|system prompt|内部日志|internal log|工具调用|tool call|思考|thinking|reasoning|analysis)\s*[：:][^\n]*(?:\n|$)/gim, "")
    .trim();
}

function removeLeadingToolCallJson(text: string): string {
  const trimmedStart = text.trimStart();
  if (!trimmedStart.startsWith("{")) return text;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let index = 0; index < trimmedStart.length; index += 1) {
    const char = trimmedStart[index];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === "\\") {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth !== 0) continue;

    const candidate = trimmedStart.slice(0, index + 1);
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && "tool_call" in parsed) {
        return trimmedStart.slice(index + 1);
      }
    } catch {
      return text;
    }
    return text;
  }

  return text;
}
