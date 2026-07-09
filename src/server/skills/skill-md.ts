export type SkillDocument = {
  name: string;
  description: string;
  /** Markdown body without the frontmatter block. */
  body: string;
  /** Raw frontmatter key-value pairs (agentskills.io allows extra metadata). */
  metadata: Record<string, string>;
};

const frontmatterPattern = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Parses a SKILL.md document (agentskills.io compatible frontmatter with
 * `name` and `description`). Falls back to deriving name/description from the
 * first heading and paragraph when no frontmatter is present.
 */
export function parseSkillMd(raw: string): SkillDocument | null {
  const text = raw.trim();
  if (!text) return null;

  const match = text.match(frontmatterPattern);
  if (match) {
    const metadata = parseFrontmatter(match[1]);
    const body = text.slice(match[0].length).trim();
    const name = metadata.name?.trim() || extractHeading(body);
    if (!name) return null;
    return {
      name,
      description: metadata.description?.trim() || extractFirstParagraph(body) || name,
      body,
      metadata,
    };
  }

  const name = extractHeading(text);
  if (!name) return null;
  return {
    name,
    description: extractFirstParagraph(text) || name,
    body: text,
    metadata: {},
  };
}

export function serializeSkillMd(input: { name: string; description: string; body: string }): string {
  return [
    "---",
    `name: ${escapeFrontmatterValue(input.name)}`,
    `description: ${escapeFrontmatterValue(input.description)}`,
    "---",
    "",
    input.body.trim(),
    "",
  ].join("\n");
}

export function buildSkillBody(input: { name: string; scenario: string; steps: string[]; notes?: string[] }): string {
  return [
    `# ${input.name}`,
    "",
    "## 适用场景",
    input.scenario,
    "",
    "## 步骤",
    ...input.steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    "## 注意事项",
    ...(input.notes && input.notes.length > 0 ? input.notes.map((note) => `- ${note}`) : ["- 启用前需要用户在后台确认。"]),
  ].join("\n");
}

function parseFrontmatter(block: string): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    if (!key || key.startsWith("#")) continue;
    metadata[key] = stripQuotes(line.slice(separator + 1).trim());
  }
  return metadata;
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function escapeFrontmatterValue(value: string): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return /[:#'"[\]{}]/.test(singleLine) ? JSON.stringify(singleLine) : singleLine;
}

function extractHeading(body: string): string {
  const match = body.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : "";
}

function extractFirstParagraph(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("---")) continue;
    return trimmed;
  }
  return "";
}
