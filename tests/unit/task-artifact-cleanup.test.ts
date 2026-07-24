import { describe, expect, it, vi } from "vitest";
import { cleanupStaleTaskArtifacts } from "@/server/tasks/artifact-cleanup";

const scope = { userId: "user-1", agentId: "agent-1" };

function createHarness() {
  const pending = {
    id: "artifact-1",
    storage_path: "user-1/task-1/report.md",
    temporary_storage_path: "user-1/task-1/.report.md.unique.tmp",
  };
  return {
    pending,
    repositories: {
      taskArtifacts: {
        listExpiredPending: vi.fn(async () => [pending]),
        delete: vi.fn(async () => true),
      },
    },
    deleteFile: vi.fn(async () => undefined),
  };
}

describe("stale task artifact cleanup", () => {
  it("deletes the recorded temporary and final paths before removing the pending locator", async () => {
    const harness = createHarness();

    await expect(cleanupStaleTaskArtifacts({
      scope,
      repositories: harness.repositories,
      root: "/private/artifacts",
      deleteFile: harness.deleteFile,
    })).resolves.toEqual({ claimed: 1, deleted: 1, failed: 0 });

    expect(harness.repositories.taskArtifacts.listExpiredPending).toHaveBeenCalledWith(scope, 24, 100);
    expect(harness.deleteFile).toHaveBeenNthCalledWith(
      1,
      "/private/artifacts",
      harness.pending.temporary_storage_path,
    );
    expect(harness.deleteFile).toHaveBeenNthCalledWith(
      2,
      "/private/artifacts",
      harness.pending.storage_path,
    );
    expect(harness.repositories.taskArtifacts.delete).toHaveBeenCalledWith(scope, harness.pending.id);
  });

  it("keeps the pending locator retryable when physical cleanup fails", async () => {
    const harness = createHarness();
    harness.deleteFile.mockRejectedValueOnce(new Error("temporary_delete_failed"));

    await expect(cleanupStaleTaskArtifacts({
      scope,
      repositories: harness.repositories,
      root: "/private/artifacts",
      deleteFile: harness.deleteFile,
    })).resolves.toEqual({ claimed: 1, deleted: 0, failed: 1 });

    expect(harness.deleteFile).toHaveBeenCalledTimes(2);
    expect(harness.repositories.taskArtifacts.delete).not.toHaveBeenCalled();
  });
});
