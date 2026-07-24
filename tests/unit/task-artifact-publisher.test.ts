import { describe, expect, it, vi } from "vitest";
import {
  discardPublishedTaskArtifacts,
  publishTaskArtifact,
} from "@/server/tasks/artifact-publisher";

const scope = { userId: "user-1", agentId: "agent-1" };
const stored = {
  fileName: "report.md",
  mimeType: "text/markdown",
  storagePath: "user-1/task-1/report.md",
};

function createHarness(failure?: "locator" | "temporary-write" | "rename" | "ready") {
  const order: string[] = [];
  const repositories = {
    taskArtifacts: {
      createPending: vi.fn(async () => {
        order.push("pending");
        if (failure === "locator") throw new Error("locator_failed");
        return "artifact-1";
      }),
      markReady: vi.fn(async () => {
        order.push("ready");
        if (failure === "ready") throw new Error("ready_failed");
        return true;
      }),
      markPendingForCleanup: vi.fn(async () => {
        order.push("hide");
        return true;
      }),
      delete: vi.fn(async () => {
        order.push("delete-row");
        return true;
      }),
    },
  };
  const storage = {
    createLocator: vi.fn(() => stored),
    createTemporaryLocator: vi.fn(() => `${stored.storagePath}.unique.tmp`),
    writeTemporary: vi.fn(async () => {
      order.push("temporary-write");
      if (failure === "temporary-write") throw new Error("temporary_write_failed");
    }),
    promote: vi.fn(async () => {
      order.push("rename");
      if (failure === "rename") throw new Error("rename_failed");
    }),
    deleteFile: vi.fn(async (_root: string, storagePath: string) => {
      order.push(`delete-file:${storagePath}`);
    }),
  };
  return { order, repositories, storage };
}

describe("task artifact publisher", () => {
  it("publishes pending locator through a unique temporary file and atomic rename before ready", async () => {
    const harness = createHarness();

    await expect(publishTaskArtifact({
      scope,
      repositories: harness.repositories,
      root: "/private/artifacts",
      taskRunId: "task-1",
      file: {
        fileName: stored.fileName,
        mimeType: stored.mimeType,
        buffer: Buffer.from("report"),
      },
      storage: harness.storage,
    })).resolves.toMatchObject({ artifactId: "artifact-1", ...stored });

    expect(harness.order).toEqual(["pending", "temporary-write", "rename", "ready"]);
    expect(harness.storage.writeTemporary).toHaveBeenCalledWith({
      root: "/private/artifacts",
      storagePath: `${stored.storagePath}.unique.tmp`,
      buffer: Buffer.from("report"),
    });
    expect(harness.storage.promote).toHaveBeenCalledWith({
      root: "/private/artifacts",
      temporaryStoragePath: `${stored.storagePath}.unique.tmp`,
      finalStoragePath: stored.storagePath,
    });
  });

  it.each([
    ["locator", []],
    ["temporary-write", [
      `delete-file:${stored.storagePath}.unique.tmp`,
      `delete-file:${stored.storagePath}`,
      "delete-row",
    ]],
    ["rename", [
      `delete-file:${stored.storagePath}.unique.tmp`,
      `delete-file:${stored.storagePath}`,
      "delete-row",
    ]],
    ["ready", [
      `delete-file:${stored.storagePath}.unique.tmp`,
      `delete-file:${stored.storagePath}`,
      "delete-row",
    ]],
  ] as const)("compensates locator, temporary and final state after %s failure", async (failure, cleanup) => {
    const harness = createHarness(failure);

    await expect(publishTaskArtifact({
      scope,
      repositories: harness.repositories,
      root: "/private/artifacts",
      taskRunId: "task-1",
      file: {
        fileName: stored.fileName,
        mimeType: stored.mimeType,
        buffer: Buffer.from("report"),
      },
      storage: harness.storage,
    })).rejects.toThrow();

    expect(harness.order.filter((entry) => entry.startsWith("delete"))).toEqual(cleanup);
  });

  it("keeps a pending locator retryable when publication compensation cannot remove every file", async () => {
    const harness = createHarness("temporary-write");
    harness.storage.deleteFile.mockRejectedValueOnce(new Error("temporary_delete_failed"));

    await expect(publishTaskArtifact({
      scope,
      repositories: harness.repositories,
      root: "/private/artifacts",
      taskRunId: "task-1",
      file: {
        fileName: stored.fileName,
        mimeType: stored.mimeType,
        buffer: Buffer.from("report"),
      },
      storage: harness.storage,
    })).rejects.toThrow("temporary_write_failed");

    expect(harness.storage.deleteFile).toHaveBeenCalledTimes(2);
    expect(harness.repositories.taskArtifacts.delete).not.toHaveBeenCalled();
  });

  it("removes every already-published file and locator when task completion fails", async () => {
    const harness = createHarness();

    await discardPublishedTaskArtifacts({
      scope,
      repositories: harness.repositories,
      root: "/private/artifacts",
      artifacts: [
        { artifactId: "artifact-1", ...stored },
        {
          artifactId: "artifact-2",
          ...stored,
          storagePath: "user-1/task-1/chart.svg",
        },
      ],
      storage: harness.storage,
    });

    expect(harness.storage.deleteFile).toHaveBeenCalledTimes(2);
    expect(harness.repositories.taskArtifacts.markPendingForCleanup).toHaveBeenCalledTimes(2);
    expect(harness.repositories.taskArtifacts.delete).toHaveBeenCalledTimes(2);
  });

  it("hides a ready artifact and keeps its locator retryable when file cleanup fails", async () => {
    const harness = createHarness();
    harness.storage.deleteFile.mockRejectedValueOnce(new Error("delete_failed"));

    await discardPublishedTaskArtifacts({
      scope,
      repositories: harness.repositories,
      root: "/private/artifacts",
      artifacts: [{ artifactId: "artifact-1", ...stored }],
      storage: harness.storage,
    });

    expect(harness.repositories.taskArtifacts.markPendingForCleanup).toHaveBeenCalledWith(
      scope,
      "artifact-1",
    );
    expect(harness.repositories.taskArtifacts.delete).not.toHaveBeenCalled();
  });
});
