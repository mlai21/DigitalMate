import { afterEach, describe, expect, it, vi } from "vitest";
import { readEnv } from "@/server/config/env";
import { embedText, isRealEmbeddingConfigured } from "@/server/llm/embeddings";

describe("embedText", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the configured OpenAI-compatible embeddings endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ embedding: Array.from({ length: 1536 }, () => 0.01) }] }), {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const env = readEnv({
      EMBEDDING_BASE_URL: "https://api.example.com/v1",
      EMBEDDING_API_KEY: "embed-key",
      EMBEDDING_MODEL: "text-embedding-3-small",
    });

    const vector = await embedText("用户喜欢周末爬山", env);

    expect(vector).toHaveLength(1536);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/v1/embeddings",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer embed-key" }),
      }),
    );
    expect(isRealEmbeddingConfigured(env)).toBe(true);
  });

  it("falls back to the local pseudo-embedding without a provider", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const env = readEnv({});

    const vector = await embedText("用户喜欢周末爬山", env);

    expect(vector).toHaveLength(1536);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isRealEmbeddingConfigured(env)).toBe(false);
  });

  it("falls back to the local pseudo-embedding on provider failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oops", { status: 500 })));
    const env = readEnv({
      EMBEDDING_BASE_URL: "https://api.example.com/v1",
      EMBEDDING_MODEL: "text-embedding-3-small",
    });

    const vector = await embedText("用户喜欢周末爬山", env);

    expect(vector).toHaveLength(1536);
  });
});
