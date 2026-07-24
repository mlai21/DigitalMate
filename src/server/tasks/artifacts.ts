import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type ArtifactFileInput = {
  root: string;
  userId: string;
  taskRunId: string;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
};

export type StoredArtifactFile = {
  fileName: string;
  mimeType: string;
  storagePath: string;
};

export function createArtifactFileLocator(input: {
  userId: string;
  taskRunId: string;
  fileName: string;
  mimeType: string;
}): StoredArtifactFile {
  const fileName = safeArtifactFileName(input.fileName);
  return {
    fileName,
    mimeType: input.mimeType,
    storagePath: path.posix.join(input.userId, input.taskRunId, fileName),
  };
}

export function defaultArtifactRoot(): string {
  return path.join(process.cwd(), "data", "artifacts");
}

export function safeArtifactFileName(fileName: string): string {
  const base = path.basename(fileName).replace(/[\\/:*?"<>|]/g, "_").replace(/^\.+/, "").trim();
  return base || "artifact";
}

export async function writeArtifactFile(input: ArtifactFileInput): Promise<StoredArtifactFile> {
  const stored = createArtifactFileLocator(input);
  const { storagePath } = stored;
  const absolutePath = resolveArtifactPath(input.root, storagePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, input.buffer);
  return stored;
}

export function createArtifactTemporaryLocator(finalStoragePath: string): string {
  const directory = path.posix.dirname(finalStoragePath);
  const fileName = path.posix.basename(finalStoragePath);
  return path.posix.join(directory, `.${fileName}.${randomUUID()}.tmp`);
}

export async function writeArtifactTemporaryFile(input: {
  root: string;
  storagePath: string;
  buffer: Buffer;
}): Promise<void> {
  const absolutePath = resolveArtifactPath(input.root, input.storagePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, input.buffer, { flag: "wx" });
}

export async function promoteArtifactTemporaryFile(input: {
  root: string;
  temporaryStoragePath: string;
  finalStoragePath: string;
}): Promise<void> {
  await rename(
    resolveArtifactPath(input.root, input.temporaryStoragePath),
    resolveArtifactPath(input.root, input.finalStoragePath),
  );
}

export async function deleteArtifactFile(root: string, storagePath: string): Promise<void> {
  await rm(resolveArtifactPath(root, storagePath), { force: true });
}

export async function readArtifactFile(root: string, storagePath: string): Promise<Buffer> {
  return readFile(resolveArtifactPath(root, storagePath));
}

export async function deleteArtifactTree(root: string, userId: string): Promise<void> {
  await rm(resolveArtifactPath(root, userId), { recursive: true, force: true });
}

export function resolveArtifactPath(root: string, storagePath: string): string {
  const resolved = path.resolve(root, storagePath);
  const rootResolved = path.resolve(root);
  if (!resolved.startsWith(`${rootResolved}${path.sep}`) && resolved !== rootResolved) {
    throw new Error("Artifact path escapes storage root");
  }
  return resolved;
}
