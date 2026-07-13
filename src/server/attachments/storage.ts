import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function stableError(code: string) {
  return new Error(code);
}

function resolveStoragePath(rootDirectory: string, storageKey: string) {
  if (!UUID_V4_PATTERN.test(storageKey)) {
    throw stableError("attachment_invalid_storage_key");
  }

  const root = path.resolve(rootDirectory);
  const resolved = path.resolve(root, storageKey);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw stableError("attachment_invalid_storage_key");
  }
  return { root, resolved };
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function createAttachmentStorageKey() {
  return randomUUID();
}

export async function saveAttachment(rootDirectory: string, storageKey: string, bytes: Buffer) {
  const { root, resolved } = resolveStoragePath(rootDirectory, storageKey);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);

  const temporaryPath = path.resolve(root, `.${storageKey}.${randomUUID()}.tmp`);
  if (!temporaryPath.startsWith(`${root}${path.sep}`)) {
    throw stableError("attachment_invalid_storage_key");
  }

  let targetReserved = false;
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
    await chmod(temporaryPath, 0o600);

    const targetHandle = await open(resolved, "wx", 0o600);
    targetReserved = true;
    await targetHandle.close();
    await chmod(resolved, 0o600);

    await rename(temporaryPath, resolved);
    await chmod(resolved, 0o600);
    targetReserved = false;
  } catch (error) {
    if (targetReserved) {
      try {
        await unlink(resolved);
      } catch (cleanupError) {
        if (!isMissingFile(cleanupError)) {
          throw new AggregateError([error, cleanupError], "attachment_storage_cleanup_failed");
        }
      }
    }
    throw error;
  } finally {
    try {
      await unlink(temporaryPath);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
}

export async function readAttachment(rootDirectory: string, storageKey: string) {
  const { resolved } = resolveStoragePath(rootDirectory, storageKey);
  return readFile(resolved);
}

export async function deleteAttachment(rootDirectory: string, storageKey: string) {
  const { resolved } = resolveStoragePath(rootDirectory, storageKey);
  try {
    await unlink(resolved);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}
