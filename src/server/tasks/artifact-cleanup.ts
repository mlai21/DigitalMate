import type { AgentScope } from "@/server/agents/types";
import { deleteArtifactFile } from "@/server/tasks/artifacts";

export const TASK_ARTIFACT_PENDING_MAX_AGE_HOURS = 24;
export const TASK_ARTIFACT_CLEANUP_BATCH_SIZE = 100;

type PendingArtifactRow = {
  id: string;
  storage_path: string;
  temporary_storage_path: string | null;
};

type ArtifactCleanupRepositories = {
  taskArtifacts: {
    listExpiredPending(
      scope: AgentScope,
      hours: number,
      limit: number,
    ): Promise<PendingArtifactRow[]>;
    deletePending(scope: AgentScope, artifactId: string): Promise<boolean>;
  };
};

export async function cleanupStaleTaskArtifacts(input: {
  scope: AgentScope;
  repositories: ArtifactCleanupRepositories;
  root: string;
  deleteFile?: typeof deleteArtifactFile;
}): Promise<{ claimed: number; deleted: number; failed: number }> {
  const pending = await input.repositories.taskArtifacts.listExpiredPending(
    input.scope,
    TASK_ARTIFACT_PENDING_MAX_AGE_HOURS,
    TASK_ARTIFACT_CLEANUP_BATCH_SIZE,
  );
  const deleteFile = input.deleteFile ?? deleteArtifactFile;
  let deleted = 0;
  let failed = 0;

  for (const artifact of pending) {
    const paths = [artifact.temporary_storage_path, artifact.storage_path]
      .filter((storagePath): storagePath is string => Boolean(storagePath));
    const outcomes = await Promise.allSettled(
      paths.map((storagePath) => deleteFile(input.root, storagePath)),
    );
    if (outcomes.some((outcome) => outcome.status === "rejected")) {
      failed += 1;
      continue;
    }
    try {
      if (await input.repositories.taskArtifacts.deletePending(input.scope, artifact.id)) {
        deleted += 1;
      } else {
        failed += 1;
      }
    } catch {
      failed += 1;
    }
  }

  return { claimed: pending.length, deleted, failed };
}
