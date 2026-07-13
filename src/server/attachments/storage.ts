import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readFile, unlink } from "node:fs/promises";
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

export async function cleanupAttachmentTemporaryFile(
  temporaryPath: string,
  primaryError: unknown,
  removeFile: (target: string) => Promise<void> = unlink,
) {
  try {
    await removeFile(temporaryPath);
  } catch (cleanupError) {
    if (!isMissingFile(cleanupError) && primaryError === undefined) {
      throw cleanupError;
    }
  }
}

export function createAttachmentStorageKey() {
  return randomUUID();
}

export type SaveAttachmentOptions = {
  removeTemporaryFile?: (target: string) => Promise<void>;
};

export async function saveAttachment(
  rootDirectory: string,
  storageKey: string,
  bytes: Buffer,
  options: SaveAttachmentOptions = {},
) {
  const { root, resolved } = resolveStoragePath(rootDirectory, storageKey);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);

  const temporaryPath = path.resolve(root, `.${storageKey}.${randomUUID()}.tmp`);
  if (!temporaryPath.startsWith(`${root}${path.sep}`)) {
    throw stableError("attachment_invalid_storage_key");
  }

  let temporaryFileCreated = false;
  let published = false;
  let primaryError: unknown;
  try {
    const temporaryHandle = await open(temporaryPath, "wx", 0o600);
    temporaryFileCreated = true;
    let writeError: unknown;
    try {
      await temporaryHandle.writeFile(bytes);
      await temporaryHandle.chmod(0o600);
      await temporaryHandle.sync();
    } catch (error) {
      writeError = error;
      throw error;
    } finally {
      try {
        await temporaryHandle.close();
      } catch (closeError) {
        if (writeError === undefined) throw closeError;
      }
    }

    // Hard-link publication is atomic and fails with EEXIST instead of replacing an existing key.
    await link(temporaryPath, resolved);
    published = true;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (temporaryFileCreated) {
      await cleanupAttachmentTemporaryFile(
        temporaryPath,
        primaryError ?? (published ? new Error("attachment_published") : undefined),
        options.removeTemporaryFile,
      );
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
