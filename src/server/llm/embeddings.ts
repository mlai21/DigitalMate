import { readEnv, type AppEnv } from "@/server/config/env";
import { buildLocalMemoryEmbedding, MEMORY_EMBEDDING_DIMENSIONS } from "@/server/agent/memory";

/**
 * Embeds text via an OpenAI-compatible /embeddings endpoint when configured
 * (EMBEDDING_BASE_URL + EMBEDDING_MODEL). Falls back to a local hash-based
 * pseudo-embedding so the vector pipeline keeps working without a provider —
 * degraded recall quality, but no hard dependency.
 */
export async function embedText(text: string, env: AppEnv = readEnv()): Promise<number[]> {
  if (!env.embeddingBaseUrl || !env.embeddingModel) {
    return buildLocalMemoryEmbedding(text);
  }

  try {
    const response = await fetch(`${env.embeddingBaseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.embeddingApiKey ?? ""}`,
      },
      body: JSON.stringify({
        model: env.embeddingModel,
        input: text,
        dimensions: env.embeddingDimensions,
      }),
    });
    if (!response.ok) {
      throw new Error(`Embedding request failed with status ${response.status}`);
    }
    const payload = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
    const embedding = payload.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length !== MEMORY_EMBEDDING_DIMENSIONS) {
      throw new Error(`Embedding response invalid (length ${embedding?.length ?? 0}, expected ${MEMORY_EMBEDDING_DIMENSIONS})`);
    }
    return embedding;
  } catch (error) {
    console.error("embedText fell back to local embedding:", error instanceof Error ? error.message : error);
    return buildLocalMemoryEmbedding(text);
  }
}

export function isRealEmbeddingConfigured(env: AppEnv = readEnv()): boolean {
  return Boolean(env.embeddingBaseUrl && env.embeddingModel);
}
