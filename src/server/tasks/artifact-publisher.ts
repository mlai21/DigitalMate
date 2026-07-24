import type { AgentScope } from "@/server/agents/types";
import {
  createArtifactFileLocator,
  createArtifactTemporaryLocator,
  deleteArtifactFile,
  promoteArtifactTemporaryFile,
  type StoredArtifactFile,
  writeArtifactTemporaryFile,
} from "@/server/tasks/artifacts";

export type PublishedTaskArtifact = StoredArtifactFile & {
  artifactId: string;
};

type ArtifactRepositories = {
  taskArtifacts: {
    createPending(scope: AgentScope, input: {
      taskRunId: string;
      fileName: string;
      mimeType: string;
      storagePath: string;
      temporaryStoragePath: string;
      metadata?: unknown;
    }): Promise<string>;
    deletePending(scope: AgentScope, artifactId: string): Promise<boolean>;
  };
};

type ArtifactStorage = {
  createLocator(input: {
    userId: string;
    taskRunId: string;
    fileName: string;
    mimeType: string;
  }): StoredArtifactFile;
  createTemporaryLocator(finalStoragePath: string): string;
  writeTemporary(input: {
    root: string;
    storagePath: string;
    buffer: Buffer;
  }): Promise<void>;
  promote(input: {
    root: string;
    temporaryStoragePath: string;
    finalStoragePath: string;
  }): Promise<void>;
  deleteFile(root: string, storagePath: string): Promise<void>;
};

const defaultStorage: ArtifactStorage = {
  createLocator: createArtifactFileLocator,
  createTemporaryLocator: createArtifactTemporaryLocator,
  writeTemporary: writeArtifactTemporaryFile,
  promote: promoteArtifactTemporaryFile,
  deleteFile: deleteArtifactFile,
};

export async function publishTaskArtifact(input: {
  scope: AgentScope;
  repositories: ArtifactRepositories;
  root: string;
  taskRunId: string;
  file: {
    fileName: string;
    mimeType: string;
    buffer: Buffer;
    metadata?: unknown;
  };
  storage?: ArtifactStorage;
}): Promise<PublishedTaskArtifact> {
  const storage = input.storage ?? defaultStorage;
  const stored = storage.createLocator({
    userId: input.scope.userId,
    taskRunId: input.taskRunId,
    fileName: input.file.fileName,
    mimeType: input.file.mimeType,
  });
  const temporaryStoragePath = storage.createTemporaryLocator(stored.storagePath);
  let artifactId: string | undefined;

  try {
    artifactId = await input.repositories.taskArtifacts.createPending(input.scope, {
      taskRunId: input.taskRunId,
      ...stored,
      temporaryStoragePath,
      metadata: input.file.metadata,
    });
    await storage.writeTemporary({
      root: input.root,
      storagePath: temporaryStoragePath,
      buffer: input.file.buffer,
    });
    await storage.promote({
      root: input.root,
      temporaryStoragePath,
      finalStoragePath: stored.storagePath,
    });
    return { artifactId, ...stored };
  } catch (error) {
    if (artifactId) {
      await compensateArtifactPublication({
        scope: input.scope,
        repositories: input.repositories,
        root: input.root,
        artifactId,
        temporaryStoragePath,
        finalStoragePath: stored.storagePath,
        storage,
      });
    }
    throw error;
  }
}

export async function discardPublishedTaskArtifacts(input: {
  scope: AgentScope;
  repositories: ArtifactRepositories;
  root: string;
  artifacts: PublishedTaskArtifact[];
  storage?: ArtifactStorage;
}): Promise<void> {
  const storage = input.storage ?? defaultStorage;
  for (const artifact of input.artifacts) {
    try {
      await storage.deleteFile(input.root, artifact.storagePath);
    } catch {
      continue;
    }
    await input.repositories.taskArtifacts
      .deletePending(input.scope, artifact.artifactId)
      .catch(() => undefined);
  }
}

async function compensateArtifactPublication(input: {
  scope: AgentScope;
  repositories: ArtifactRepositories;
  root: string;
  artifactId: string;
  temporaryStoragePath: string;
  finalStoragePath: string;
  storage: ArtifactStorage;
}): Promise<void> {
  const cleanupResults = await Promise.allSettled([
    input.storage.deleteFile(input.root, input.temporaryStoragePath),
    input.storage.deleteFile(input.root, input.finalStoragePath),
  ]);
  if (cleanupResults.every((result) => result.status === "fulfilled")) {
    await input.repositories.taskArtifacts
      .deletePending(input.scope, input.artifactId)
      .catch(() => undefined);
  }
}
