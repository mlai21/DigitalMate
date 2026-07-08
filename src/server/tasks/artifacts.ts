import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

export function defaultArtifactRoot(): string {
  return path.join(process.cwd(), "data", "artifacts");
}

export function safeArtifactFileName(fileName: string): string {
  const base = path.basename(fileName).replace(/[\\/:*?"<>|]/g, "_").replace(/^\.+/, "").trim();
  return base || "artifact";
}

export async function writeArtifactFile(input: ArtifactFileInput): Promise<StoredArtifactFile> {
  const fileName = safeArtifactFileName(input.fileName);
  const storagePath = path.posix.join(input.userId, input.taskRunId, fileName);
  const absolutePath = resolveArtifactPath(input.root, storagePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, input.buffer);
  return { fileName, mimeType: input.mimeType, storagePath };
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
