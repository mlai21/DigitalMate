import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createArtifactTemporaryLocator,
  promoteArtifactTemporaryFile,
  readArtifactFile,
  safeArtifactFileName,
  writeArtifactFile,
  writeArtifactTemporaryFile,
} from "@/server/tasks/artifacts";

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

  it("keeps a unique temporary artifact invisible until atomic promotion", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "digitalmate-artifacts-"));
    const finalStoragePath = "user-1/task-1/report.md";
    const firstTemporary = createArtifactTemporaryLocator(finalStoragePath);
    const secondTemporary = createArtifactTemporaryLocator(finalStoragePath);
    try {
      expect(firstTemporary).not.toBe(secondTemporary);
      expect(path.posix.dirname(firstTemporary)).toBe(path.posix.dirname(finalStoragePath));

      await writeArtifactTemporaryFile({
        root,
        storagePath: firstTemporary,
        buffer: Buffer.from("complete"),
      });
      await expect(readArtifactFile(root, finalStoragePath)).rejects.toMatchObject({ code: "ENOENT" });

      await promoteArtifactTemporaryFile({
        root,
        temporaryStoragePath: firstTemporary,
        finalStoragePath,
      });

      await expect(readArtifactFile(root, finalStoragePath)).resolves.toEqual(Buffer.from("complete"));
      await expect(stat(path.join(root, firstTemporary))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
