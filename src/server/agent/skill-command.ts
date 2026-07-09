export type SlashCommand =
  | { kind: "create_skill"; rest: string }
  | { kind: "use_skill"; name: string; rest: string };

/**
 * Parses leading slash commands typed by the user: "/create-skill ..." starts
 * the guided skill-creation flow; any other "/name ..." token is treated as an
 * explicit skill invocation (used by IM channels where cards are unavailable).
 */
export function parseSlashCommand(text: string): SlashCommand | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) return null;
  const match = trimmed.match(/^\/(\S+)([\s\S]*)$/);
  if (!match) return null;
  const token = match[1];
  const rest = match[2].trim();
  if (token === "create-skill" || token === "create_skill") {
    return { kind: "create_skill", rest };
  }
  return { kind: "use_skill", name: token, rest };
}

export function buildExplicitSkillFallbackMessage(skillName: string): string {
  return `请按照 Skill「${skillName}」执行。`;
}
