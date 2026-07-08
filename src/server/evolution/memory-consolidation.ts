import { z } from "zod";
import type { LlmClient } from "@/server/llm/types";
import type { ExtractedMemory, MemoryKind } from "@/server/agent/memory";

// Resident-context layers (profile / agent_self) have strict capacity caps so
// their per-turn token cost stays bounded (Hermes keeps ~1300 tokens of
// resident memory). Episodic entries are excluded: they expire via TTL.
export const MEMORY_CAPACITY_LIMITS: Partial<Record<MemoryKind, number>> = {
  profile: 40,
  agent_self: 24,
};

export type MemoryEntryForConsolidation = {
  id: string;
  content: string;
  confidence: number;
  createdAt: Date;
};

export type ConsolidationOutcome = {
  kind: MemoryKind;
  removedCount: number;
  mergedCount: number;
  strategy: "llm_merge" | "prune_oldest";
};

const mergeSchema = z
  .array(
    z.object({
      content: z.string().min(2).max(300),
      confidence: z.number().min(0).max(1),
    }),
  )
  .min(1);

function buildMergePrompt(cap: number): string {
  return [
    "你是一个私人 AI 助手的记忆整理模块。下面是同一层级的长期记忆条目，数量已超过容量上限。",
    `请合并重复/相近条目、压缩啰嗦表述、淘汰过时或价值最低的条目，输出不超过 ${cap} 条精选记忆。`,
    '输出 JSON 数组，不要任何其他文字。每项格式：{"content":"...","confidence":0.0-1.0}',
    "规则：",
    "- content 用第三人称陈述，保留原有事实，不要凭空新增。",
    "- 相互矛盾时保留较新的表述。",
    "- confidence 取被合并条目中的较高值。",
  ].join("\n");
}

type ConsolidationRepositories = {
  memories: {
    listActiveByKind(userId: string, kind: MemoryKind): Promise<MemoryEntryForConsolidation[]>;
    softDeleteMany(userId: string, memoryIds: string[]): Promise<void>;
    createMany(userId: string, sourceMessageId: string | null, memories: ExtractedMemory[]): Promise<void>;
  };
};

/**
 * Enforce the capacity cap for one resident memory kind. When over cap, the
 * agent consolidates its own memory with the light model (merge + compress +
 * evict) instead of silently dropping entries; if the model output is
 * unusable it falls back to pruning the oldest low-confidence entries.
 */
export async function consolidateMemoryKind(input: {
  repositories: ConsolidationRepositories;
  llm: LlmClient;
  model: string;
  userId: string;
  kind: MemoryKind;
  cap?: number;
}): Promise<ConsolidationOutcome | null> {
  const cap = input.cap ?? MEMORY_CAPACITY_LIMITS[input.kind];
  if (!cap) return null;

  const entries = await input.repositories.memories.listActiveByKind(input.userId, input.kind);
  if (entries.length <= cap) return null;

  const merged = await mergeWithLlm(input.llm, input.model, entries, cap);
  if (merged) {
    await input.repositories.memories.softDeleteMany(
      input.userId,
      entries.map((entry) => entry.id),
    );
    await input.repositories.memories.createMany(
      input.userId,
      null,
      merged.map((memory) => ({ ...memory, kind: input.kind })),
    );
    return {
      kind: input.kind,
      removedCount: entries.length,
      mergedCount: merged.length,
      strategy: "llm_merge",
    };
  }

  const surplus = pickPruneCandidates(entries, entries.length - cap);
  await input.repositories.memories.softDeleteMany(
    input.userId,
    surplus.map((entry) => entry.id),
  );
  return {
    kind: input.kind,
    removedCount: surplus.length,
    mergedCount: 0,
    strategy: "prune_oldest",
  };
}

async function mergeWithLlm(
  llm: LlmClient,
  model: string,
  entries: MemoryEntryForConsolidation[],
  cap: number,
): Promise<Array<{ content: string; confidence: number }> | null> {
  try {
    const raw = await llm.completeText({
      model,
      messages: [
        { role: "system", content: buildMergePrompt(cap) },
        {
          role: "user",
          content: entries.map((entry) => `- (置信度 ${entry.confidence.toFixed(2)}) ${entry.content}`).join("\n"),
        },
      ],
    });
    const jsonText = extractJsonArray(raw);
    if (!jsonText) return null;
    const parsed = mergeSchema.parse(JSON.parse(jsonText));
    if (parsed.length > cap) return parsed.slice(0, cap);
    return parsed;
  } catch {
    return null;
  }
}

export function pickPruneCandidates(
  entries: MemoryEntryForConsolidation[],
  count: number,
): MemoryEntryForConsolidation[] {
  return [...entries]
    .sort(
      (a, b) => a.confidence - b.confidence || a.createdAt.getTime() - b.createdAt.getTime(),
    )
    .slice(0, Math.max(0, count));
}

function extractJsonArray(text: string): string | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
}
