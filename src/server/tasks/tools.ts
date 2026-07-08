import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runSandboxTask } from "@/server/tasks/sandbox";

export type ToolRegistrationDraftInput = {
  name: string;
  description: string;
  command: string;
  kind?: ToolRegistrationKind;
  mcpToolName?: string;
};

export type ToolRegistrationDraft = ToolRegistrationDraftInput & {
  kind: ToolRegistrationKind;
  status: "pending";
  requiresConfirmation: true;
};

export type ToolRegistrationKind = "script" | "mcp";

export function createToolRegistrationDraft(input: ToolRegistrationDraftInput): ToolRegistrationDraft {
  return {
    ...input,
    kind: input.kind ?? "script",
    status: "pending",
    requiresConfirmation: true,
  };
}

export type RegisteredToolContext = {
  name: string;
  description: string;
  command: string;
  kind?: ToolRegistrationKind;
  mcpToolName?: string | null;
};

export type RegisteredToolExecutionResult = {
  output: string;
};

export async function executeRegisteredTool(
  tool: RegisteredToolContext,
  input: string,
): Promise<RegisteredToolExecutionResult> {
  if (tool.kind === "mcp") {
    return { output: await callMcpTool(tool, input) };
  }

  const workdir = await mkdtemp(path.join(os.tmpdir(), "digitalmate-tool-"));
  try {
    await writeFile(path.join(workdir, "tool-input.txt"), input);
    const result = await runSandboxTask({
      image: "node:22-alpine",
      workdir,
      script: tool.command,
      memoryMb: 256,
      cpus: 1,
      network: false,
    });
    const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    return { output: output || "(empty)" };
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

export function mcpToolResultToText(result: unknown): string {
  const content =
    result && typeof result === "object" && "content" in result && Array.isArray((result as { content?: unknown }).content)
      ? ((result as { content: Array<{ type?: unknown; text?: unknown }> }).content)
      : [];
  const text = content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .trim();
  return text || JSON.stringify(result);
}

async function callMcpTool(tool: RegisteredToolContext, input: string): Promise<string> {
  const { command, args } = parseCommandLine(tool.command);
  const client = new Client({ name: "digitalmate", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command,
    args,
    stderr: "pipe",
  });
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: tool.mcpToolName || tool.name,
      arguments: parseMcpArguments(input),
    });
    return mcpToolResultToText(result);
  } finally {
    await client.close();
  }
}

function parseMcpArguments(input: string): Record<string, unknown> {
  if (!input.trim()) return {};
  try {
    const parsed = JSON.parse(input) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Fall through to a simple input payload.
  }
  return { input };
}

function parseCommandLine(commandLine: string): { command: string; args: string[] } {
  const parts = commandLine.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^["']|["']$/g, "")) ?? [];
  const [command, ...args] = parts;
  if (!command) throw new Error("MCP command is empty");
  return { command, args };
}
