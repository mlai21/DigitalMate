import { z } from "zod";

import type {
  PersonaSettings,
  ProactivitySettings,
} from "@/server/settings/defaults";

export const VIRTUAL_FILES = Object.freeze({
  "/AGENT.md": Object.freeze({
    filename: "AGENT.md",
    writable: true,
    source: "agent_persona",
  }),
  "/PROACTIVITY.md": Object.freeze({
    filename: "PROACTIVITY.md",
    writable: true,
    source: "agent_proactivity",
  }),
  "/CHANNELS.md": Object.freeze({
    filename: "CHANNELS.md",
    writable: false,
    source: "channel_summary",
  }),
  "/RUNTIME.json": Object.freeze({
    filename: "RUNTIME.json",
    writable: false,
    source: "runtime_summary",
  }),
});

export type VirtualFilePath = keyof typeof VIRTUAL_FILES;

export type AgentVirtualFileInput = Readonly<{
  revision: number;
  displayName: string;
  persona: PersonaSettings;
}>;

export type ProactivityVirtualFileInput = Readonly<{
  revision: number;
  proactivity: ProactivitySettings;
}>;

const revisionSchema = z.number().int().positive();
const clockSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u);
const agentSchema = z
  .object({
    revision: revisionSchema,
    displayName: z.string().trim().min(1).max(80),
    persona: z
      .object({
        name: z.string().trim().min(1).max(80),
        style: z.string().trim().min(1).max(4_000),
        emojiHabit: z.string().trim().max(500),
      })
      .strict(),
  })
  .strict();
const proactivitySchema = z
  .object({
    revision: revisionSchema,
    proactivity: z
      .object({
        quietStart: clockSchema,
        quietEnd: clockSchema,
        minIntervalMinutes: z.number().int().min(1).max(1_440),
        maxPerHour: z.number().int().min(1).max(10),
        maxPerDay: z.number().int().min(1).max(20),
      })
      .strict(),
  })
  .strict();

export function normalizeVirtualFilePath(
  input: string,
): VirtualFilePath {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.includes("\u0000") ||
    input.includes("%") ||
    input.includes("\\") ||
    input.includes("..")
  ) {
    throw virtualFileNotFound();
  }
  const name = input.startsWith("/") ? input.slice(1) : input;
  if (
    name.length === 0 ||
    name.includes("/") ||
    input.startsWith("//")
  ) {
    throw virtualFileNotFound();
  }
  const path = `/${name}`;
  if (!Object.prototype.hasOwnProperty.call(VIRTUAL_FILES, path)) {
    throw virtualFileNotFound();
  }
  return path as VirtualFilePath;
}

export function serializeAgentVirtualFile(
  input: AgentVirtualFileInput,
): string {
  const value = agentSchema.parse(input);
  return [
    "# DigitalMate Agent",
    metadata("AGENT", value.revision),
    `displayName: ${JSON.stringify(value.displayName)}`,
    `name: ${JSON.stringify(value.persona.name)}`,
    `style: ${JSON.stringify(value.persona.style)}`,
    `emojiHabit: ${JSON.stringify(value.persona.emojiHabit)}`,
    "",
  ].join("\n");
}

export function parseAgentVirtualFile(
  content: string,
): AgentVirtualFileInput {
  try {
    const lines = normalizedLines(content);
    if (
      lines.length !== 6 ||
      lines[0] !== "# DigitalMate Agent"
    ) {
      throw virtualFileInvalid();
    }
    const revision = parseMetadata(lines[1], "AGENT");
    const fields = parseExactJsonFields(lines.slice(2), [
      "displayName",
      "name",
      "style",
      "emojiHabit",
    ]);
    return agentSchema.parse({
      revision,
      displayName: fields.displayName,
      persona: {
        name: fields.name,
        style: fields.style,
        emojiHabit: fields.emojiHabit,
      },
    });
  } catch {
    throw virtualFileInvalid();
  }
}

export function serializeProactivityVirtualFile(
  input: ProactivityVirtualFileInput,
): string {
  const value = proactivitySchema.parse(input);
  return [
    "# DigitalMate Proactivity",
    metadata("PROACTIVITY", value.revision),
    `quietStart: ${JSON.stringify(value.proactivity.quietStart)}`,
    `quietEnd: ${JSON.stringify(value.proactivity.quietEnd)}`,
    `minIntervalMinutes: ${JSON.stringify(value.proactivity.minIntervalMinutes)}`,
    `maxPerHour: ${JSON.stringify(value.proactivity.maxPerHour)}`,
    `maxPerDay: ${JSON.stringify(value.proactivity.maxPerDay)}`,
    "",
  ].join("\n");
}

export function parseProactivityVirtualFile(
  content: string,
): ProactivityVirtualFileInput {
  try {
    const lines = normalizedLines(content);
    if (
      lines.length !== 7 ||
      lines[0] !== "# DigitalMate Proactivity"
    ) {
      throw virtualFileInvalid();
    }
    const revision = parseMetadata(
      lines[1],
      "PROACTIVITY",
    );
    const fields = parseExactJsonFields(lines.slice(2), [
      "quietStart",
      "quietEnd",
      "minIntervalMinutes",
      "maxPerHour",
      "maxPerDay",
    ]);
    return proactivitySchema.parse({
      revision,
      proactivity: fields,
    });
  } catch {
    throw virtualFileInvalid();
  }
}

export function readVirtualFileRevision(
  path: VirtualFilePath,
  content: string,
): number {
  switch (path) {
    case "/AGENT.md":
      return parseAgentVirtualFile(content).revision;
    case "/PROACTIVITY.md":
      return parseProactivityVirtualFile(content).revision;
    default:
      throw new Error("virtual_file_read_only");
  }
}

function metadata(
  kind: "AGENT" | "PROACTIVITY",
  revision: number,
): string {
  return `<!-- digitalmate:virtual=${kind};revision=${revision} -->`;
}

function parseMetadata(
  line: string,
  kind: "AGENT" | "PROACTIVITY",
): number {
  const escapedKind = kind.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const matched = new RegExp(
    `^<!-- digitalmate:virtual=${escapedKind};revision=([1-9]\\d*) -->$`,
    "u",
  ).exec(line);
  if (!matched) throw virtualFileInvalid();
  const revision = Number(matched[1]);
  return revisionSchema.parse(revision);
}

function parseExactJsonFields(
  lines: readonly string[],
  names: readonly string[],
): Record<string, unknown> {
  if (lines.length !== names.length) throw virtualFileInvalid();
  const result: Record<string, unknown> = {};
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    const prefix = `${name}: `;
    const line = lines[index];
    if (!line.startsWith(prefix)) throw virtualFileInvalid();
    result[name] = JSON.parse(line.slice(prefix.length));
  }
  return result;
}

function normalizedLines(content: string): string[] {
  if (
    typeof content !== "string" ||
    content.length === 0 ||
    content.length > 32_000 ||
    content.includes("\u0000")
  ) {
    throw virtualFileInvalid();
  }
  return content.replace(/\r\n?/gu, "\n").replace(/\n$/u, "").split("\n");
}

function virtualFileNotFound(): Error {
  return new Error("virtual_file_not_found");
}

function virtualFileInvalid(): Error {
  return new Error("virtual_file_invalid_format");
}
