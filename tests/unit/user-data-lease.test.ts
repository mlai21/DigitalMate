import { describe, expect, it, vi } from "vitest";
import {
  acquireUserDataLease,
  withFreshUserDataLease,
  withUserDataLease,
} from "@/server/admin/user-data-lease";
import { createRepositories } from "@/server/db/repositories";

vi.mock("@/server/db/repositories", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db/repositories")>();
  return {
    ...actual,
    createRepositories: vi.fn(),
  };
});

function createLeaseHarness() {
  const release = vi.fn(async () => undefined);
  const beginRequest = vi.fn(async (userId: string) => ({ userId, epoch: "7" }));
  const acquireSharedLease = vi.fn(async (fence: { userId: string; epoch: string }) => ({
    ...fence,
    mode: "shared" as const,
    release,
  }));
  return {
    release,
    repositories: {
      userDataMutations: {
        beginRequest,
        acquireSharedLease,
      },
    },
  };
}

describe("user data lease wrapper", () => {
  it("releases a shared lease after successful work", async () => {
    const harness = createLeaseHarness();

    await expect(
      withUserDataLease(harness.repositories, "user-1", async (lease) => lease.epoch),
    ).resolves.toBe("7");

    expect(harness.release).toHaveBeenCalledTimes(1);
  });

  it("releases a shared lease when work rejects", async () => {
    const harness = createLeaseHarness();

    await expect(
      withUserDataLease(harness.repositories, "user-1", async () => {
        throw new Error("work_failed");
      }),
    ).rejects.toThrow("work_failed");

    expect(harness.release).toHaveBeenCalledTimes(1);
  });

  it("returns an explicit lease for streaming ownership transfer", async () => {
    const harness = createLeaseHarness();

    const lease = await acquireUserDataLease(harness.repositories, "user-1");

    expect(lease).toMatchObject({ userId: "user-1", epoch: "7", mode: "shared" });
    expect(harness.release).not.toHaveBeenCalled();
    await lease.release();
  });

  it("creates one repository set and releases its shared lease", async () => {
    const harness = createLeaseHarness();
    vi.mocked(createRepositories).mockReturnValue(
      harness.repositories as unknown as ReturnType<typeof createRepositories>,
    );

    await expect(
      withFreshUserDataLease("user-1", async (repositories) => repositories),
    ).resolves.toBe(harness.repositories);

    expect(createRepositories).toHaveBeenCalledTimes(1);
    expect(harness.release).toHaveBeenCalledTimes(1);
  });

  it("aborts bounded work, waits for it to exit, then releases the shared lease", async () => {
    vi.useFakeTimers();
    const harness = createLeaseHarness();
    let workSignal: AbortSignal | undefined;
    let exited = false;
    const order: string[] = [];
    harness.release.mockImplementationOnce(async () => {
      order.push("lease-released");
    });
    try {
      const operation = withUserDataLease(
        harness.repositories,
        "user-1",
        async (_lease, signal) => {
          workSignal = signal;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 1_000);
            signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              resolve();
            }, { once: true });
          });
          try {
            signal?.throwIfAborted();
            exited = true;
          } finally {
            order.push("work-exited");
          }
        },
        { timeoutMs: 25, timeoutCode: "user_data_work_timeout" },
      );
      const settled = operation.then(
        () => null,
        (error: unknown) => error,
      );

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(25);
      expect(workSignal?.aborted).toBe(true);
      const error = await settled;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("user_data_work_timeout");
      expect(exited).toBe(false);
      expect(harness.release).toHaveBeenCalledTimes(1);
      expect(order).toEqual(["work-exited", "lease-released"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
