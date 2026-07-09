import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createRepositories } from "@/server/db/repositories";

describe("goals repository", () => {
  it("lists due goals covering both confirmed and due running statuses", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const repositories = createRepositories({ query } as unknown as Pool);
    const now = new Date("2026-07-09T06:00:00Z");

    await repositories.goals.listDue(now);

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("status = 'confirmed'");
    expect(sql).toContain("status = 'running' AND next_run_at IS NOT NULL AND next_run_at <= $1");
    expect(params).toEqual([now]);
  });

  it("only claims a running step when no fresh claim exists (stale takeover after 30 minutes)", async () => {
    const query = vi.fn(async () => ({ rows: [{ id: "goal-1" }] }));
    const repositories = createRepositories({ query } as unknown as Pool);

    await expect(repositories.goals.claimRunningStep("goal-1", "step-1")).resolves.toBe(true);

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("running_step IS NULL OR updated_at < now() - interval '30 minutes'");
    expect(params).toEqual(["goal-1", "step-1"]);
  });

  it("reports a failed claim when the guard matches no row", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const repositories = createRepositories({ query } as unknown as Pool);

    await expect(repositories.goals.claimRunningStep("goal-1", "step-1")).resolves.toBe(false);
  });

  it("clears the running step and schedules the next round on release", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const repositories = createRepositories({ query } as unknown as Pool);
    const nextRunAt = new Date("2026-07-09T06:30:00Z");

    await repositories.goals.releaseRunningStep("goal-1", nextRunAt);

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("running_step = NULL");
    expect(params).toEqual(["goal-1", nextRunAt]);
  });
});
