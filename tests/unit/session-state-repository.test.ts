import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createRepositories } from "@/server/db/repositories";

describe("session state repository", () => {
  it("atomically rotates a persistent per-user generation", async () => {
    const query = vi.fn(async () => ({
      rows: [{ generation: "12" }],
    }));
    const repositories = createRepositories({ query } as unknown as Pool);

    await expect(
      repositories.sessionStates.rotate("user-1"),
    ).resolves.toBe(12);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT (user_id) DO UPDATE"),
      ["user-1"],
    );
  });

  it("reads the current generation without creating an authenticated session", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const repositories = createRepositories({ query } as unknown as Pool);

    await expect(
      repositories.sessionStates.getGeneration("user-1"),
    ).resolves.toBeNull();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("FROM user_session_states"),
      ["user-1"],
    );
  });
});
