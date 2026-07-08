export type MemoryKind = "episodic" | "profile" | "agent_self";

export type ExtractedMemory = {
  kind: MemoryKind;
  content: string;
  confidence: number;
};

export type RankableMemory = {
  id: string;
  content: string;
  createdAt: Date;
};

export const MEMORY_EMBEDDING_DIMENSIONS = 1536;

const sensitivePatterns = [
  /\b\d{17}[\dXx]\b/,
  /\b\d{13,19}\b/,
  /\b1[3-9]\d{9}\b/,
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  /(api[_-]?key|secret|token|password|密码|密钥)\s*(?:是|为|叫|[:：=])/i,
];

export function redactSensitiveMemory(content: string): string | null {
  if (sensitivePatterns.some((pattern) => pattern.test(content)) || hasSeparatedSensitiveNumber(content)) {
    return null;
  }
  return content.trim();
}

function hasSeparatedSensitiveNumber(content: string): boolean {
  const numericRuns = content.match(/[\dXx][\dXx\s-]{11,}[\dXx]/g) ?? [];
  return numericRuns.some((run) => {
    const normalized = run.replace(/[\s-]/g, "");
    return /^\d{13,19}$/.test(normalized) || /^\d{17}[\dXx]$/.test(normalized);
  });
}

export function extractRuleBasedMemories(text: string): ExtractedMemory[] {
  const candidates: ExtractedMemory[] = [];
  const normalized = text.replace(/\s+/g, " ").trim();

  addProfile(candidates, normalized, /我喜欢(.+)/, "用户喜欢");
  addProfile(candidates, normalized, /我不喜欢(.+)/, "用户不喜欢");
  addProfile(candidates, normalized, /我叫(.+)/, "用户叫");
  addProfile(candidates, normalized, /我在准备(.+)/, "用户在准备");
  addFutureEvent(candidates, normalized);
  addRelationshipFact(candidates, normalized);

  return candidates
    .map((memory) => ({ ...memory, content: redactSensitiveMemory(memory.content) }))
    .filter((memory): memory is ExtractedMemory => Boolean(memory.content));
}

export function rankMemories(query: string, memories: RankableMemory[]): RankableMemory[] {
  const queryTokens = tokenize(query);
  const now = Date.now();

  return [...memories].sort((a, b) => {
    const aScore = scoreMemory(a, queryTokens, now);
    const bScore = scoreMemory(b, queryTokens, now);
    return bScore - aScore;
  });
}

export function buildLocalMemoryEmbedding(text: string): number[] {
  const vector = Array.from({ length: MEMORY_EMBEDDING_DIMENSIONS }, () => 0);
  const tokens = tokenizeForEmbedding(text);

  for (const token of tokens) {
    const hash = hashToken(token);
    const index = hash % MEMORY_EMBEDDING_DIMENSIONS;
    const sign = hashToken(`sign:${token}`) % 2 === 0 ? 1 : -1;
    vector[index] += sign;
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) return vector;
  return vector.map((value) => value / magnitude);
}

export function formatPgVector(vector: number[]): string {
  return `[${vector.map((value) => (Object.is(value, -0) ? 0 : value).toFixed(6)).join(",")}]`;
}

function addProfile(candidates: ExtractedMemory[], text: string, pattern: RegExp, prefix: string): void {
  const match = text.match(pattern);
  if (!match) return;
  const value = match[1].replace(/[。.!！?？\s]+$/g, "").trim();
  if (!value) return;
  candidates.push({ kind: "profile", content: `${prefix}${value}`, confidence: 0.72 });
}

function addFutureEvent(candidates: ExtractedMemory[], text: string): void {
  const match = text.match(/我(今天|明天|后天|本周[一二三四五六日天]|这周[一二三四五六日天]|下周[一二三四五六日天])(?:要|得|需要)(.+)/);
  if (!match) return;
  const time = match[1];
  const event = cleanupMemoryValue(match[2]);
  if (!time || !event) return;
  candidates.push({ kind: "episodic", content: `用户${time}要${event}`, confidence: 0.68 });
}

function addRelationshipFact(candidates: ExtractedMemory[], text: string): void {
  const relationPattern = /(朋友|同事|老板|老婆|老公|女朋友|男朋友|妈妈|爸爸|孩子|儿子|女儿)/;
  const factPattern = /(喜欢|不喜欢|叫|是)/;
  const match = text.match(new RegExp(`我(?:的)?${relationPattern.source}([^，。,.!！?？\\s]{1,20})${factPattern.source}(.+)`));
  if (!match) return;
  const [, relation, name, verb, value] = match;
  const fact = cleanupMemoryValue(value);
  if (!relation || !name || !verb || !fact) return;
  candidates.push({ kind: "profile", content: `用户的${relation}${name}${verb}${fact}`, confidence: 0.7 });
}

function cleanupMemoryValue(value: string): string {
  return value.replace(/[。.!！?？\s]+$/g, "").trim();
}

function scoreMemory(memory: RankableMemory, queryTokens: string[], now: number): number {
  const content = memory.content.toLowerCase();
  const lexical = queryTokens.reduce((score, token) => score + (content.includes(token) ? 10 : 0), 0);
  const ageDays = Math.max(0, (now - memory.createdAt.getTime()) / 86_400_000);
  const recency = Math.max(0, 5 - ageDays / 30);
  return lexical + recency;
}

function tokenize(text: string): string[] {
  const compact = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const tokens = new Set<string>();
  for (let size = 2; size <= 4; size += 1) {
    for (let index = 0; index <= compact.length - size; index += 1) {
      tokens.add(compact.slice(index, index + size));
    }
  }
  return [...tokens];
}

function tokenizeForEmbedding(text: string): string[] {
  const compact = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const tokens = tokenize(text);
  if (compact) tokens.push(compact);
  return tokens.length > 0 ? tokens : ["empty"];
}

function hashToken(token: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}
