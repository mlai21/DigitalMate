import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readArtifactFile, safeArtifactFileName, writeArtifactFile } from "@/server/tasks/artifacts";

describe("artifact storage", () => {
  it("sanitizes file names and stores artifacts under the task directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "digitalmate-artifacts-"));
    try {
      expect(safeArtifactFileName("../报表?.csv")).toBe("报表_.csv");

      const artifact = await writeArtifactFile({
        root,
        userId: "user-1",
        taskRunId: "task-1",
        fileName: "../报表?.csv",
        mimeType: "text/csv",
        buffer: Buffer.from("ok"),
      });

      expect(artifact.storagePath).toBe("user-1/task-1/报表_.csv");
      expect(await readArtifactFile(root, artifact.storagePath)).toEqual(Buffer.from("ok"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
