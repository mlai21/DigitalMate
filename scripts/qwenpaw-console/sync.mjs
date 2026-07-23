import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const DEFAULT_FILE_OPERATIONS = Object.freeze({
  lstat,
  rename,
  rm,
});

export const UPSTREAM = Object.freeze({
  repository: "https://github.com/agentscope-ai/QwenPaw.git",
  tag: "v2.0.0.post3",
  commit: "fef7e64d984f4332d0b84a343cd209bd3ea5d316",
});

export const SNAPSHOT_PATHS = Object.freeze([
  "console",
  "LICENSE",
  "reference/src/qwenpaw/app/channels",
  "reference/src/qwenpaw/config/config.py",
  "reference/src/qwenpaw/app/routers/config.py",
  "reference/tests/unit/channels",
  "reference/tests/contract/channels",
  "reference/tests/fixtures/channels",
]);

export const FORBIDDEN_SEGMENTS = Object.freeze([
  "node_modules",
  "dist",
  ".git",
]);

const SOURCE_MAPPINGS = Object.freeze([
  ["console", "console", "directory"],
  ["LICENSE", "LICENSE", "file"],
  [
    "src/qwenpaw/app/channels",
    "reference/src/qwenpaw/app/channels",
    "directory",
  ],
  [
    "src/qwenpaw/config/config.py",
    "reference/src/qwenpaw/config/config.py",
    "file",
  ],
  [
    "src/qwenpaw/app/routers/config.py",
    "reference/src/qwenpaw/app/routers/config.py",
    "file",
  ],
  ["tests/unit/channels", "reference/tests/unit/channels", "directory"],
  [
    "tests/contract/channels",
    "reference/tests/contract/channels",
    "directory",
  ],
  [
    "tests/fixtures/channels",
    "reference/tests/fixtures/channels",
    "directory",
  ],
]);

async function pathExists(targetPath, lstatOperation = lstat) {
  return lstatOperation(targetPath)
    .then(() => true)
    .catch((error) => {
      if (error?.code === "ENOENT") {
        return false;
      }
      throw error;
    });
}

async function clonePinnedUpstream(cloneRoot) {
  await execFileAsync(
    "git",
    [
      "-c",
      "advice.detachedHead=false",
      "clone",
      "--quiet",
      "--depth",
      "1",
      "--branch",
      UPSTREAM.tag,
      "--single-branch",
      UPSTREAM.repository,
      cloneRoot,
    ],
    {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  const { stdout } = await execFileAsync("git", ["-C", cloneRoot, "rev-parse", "HEAD"]);
  if (stdout.trim() !== UPSTREAM.commit) {
    throw new Error("upstream commit mismatch");
  }

  const rootEntries = await readdir(cloneRoot);
  if (rootEntries.some((entry) => /^NOTICE(?:\.|$)/i.test(entry))) {
    throw new Error("upstream NOTICE requires review");
  }
}

async function validateSourceDirectory(directoryPath) {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new Error("symbolic link not allowed");
    }

    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      await validateSourceDirectory(entryPath);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error("non-regular snapshot entry");
    }
  }
}

async function validateSourcePath(sourcePath, expectedKind) {
  const entry = await lstat(sourcePath).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error("source snapshot path missing");
    }
    throw error;
  });
  if (entry.isSymbolicLink()) {
    throw new Error("symbolic link not allowed");
  }
  if (
    (expectedKind === "directory" && !entry.isDirectory()) ||
    (expectedKind === "file" && !entry.isFile())
  ) {
    throw new Error("source snapshot path invalid");
  }
  if (entry.isDirectory()) {
    await validateSourceDirectory(sourcePath);
  }
}

async function copySnapshotPayload(cloneRoot, stagingRoot) {
  for (const [sourcePath, destinationPath, expectedKind] of SOURCE_MAPPINGS) {
    const source = path.join(cloneRoot, ...sourcePath.split("/"));
    const destination = path.join(stagingRoot, ...destinationPath.split("/"));
    await validateSourcePath(source, expectedKind);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, {
      errorOnExist: true,
      force: false,
      recursive: true,
    });
  }
}

function renderMetadata(directoryHash) {
  return [
    "# QwenPaw Console 固定上游快照",
    "",
    `- Repository: ${UPSTREAM.repository}`,
    `- Tag: ${UPSTREAM.tag}`,
    `- Commit: ${UPSTREAM.commit}`,
    `- Retrieved: ${new Date().toISOString().slice(0, 10)}`,
    `- Directory SHA-256: ${directoryHash}`,
    "- Local modifications: 仅路径筛选与 reference/ 映射；载荷内容未修改",
    "",
    "目录哈希为按 POSIX 相对路径排序后的载荷 `SHA256SUMS` 内容的 SHA-256。",
    "`UPSTREAM.md` 与 `SHA256SUMS` 属于元数据，不计入载荷哈希。",
    "",
  ].join("\n");
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function createCombinedError(message, cause) {
  const error = new Error(message);
  error.cause = cause;
  return error;
}

async function replaceSnapshotAtomically(
  stagingRoot,
  destinationRoot,
  options = {},
) {
  const fileOperations = {
    ...DEFAULT_FILE_OPERATIONS,
    ...options.fileOperations,
  };
  const parentRoot = path.dirname(destinationRoot);
  const backupRoot =
    options.backupRoot ??
    path.join(parentRoot, `.qwenpaw-console-backup-${randomUUID()}`);
  const hadExistingSnapshot = await pathExists(
    destinationRoot,
    fileOperations.lstat,
  );
  let backupCreated = false;
  let replacementState = hadExistingSnapshot
    ? "original-present"
    : "destination-empty";

  if (hadExistingSnapshot) {
    try {
      await fileOperations.rename(destinationRoot, backupRoot);
      backupCreated = true;
      replacementState = "backup-created";
    } catch (backupError) {
      try {
        await fileOperations.rm(stagingRoot, {
          recursive: true,
          force: true,
        });
      } catch (cleanupError) {
        throw createCombinedError(
          `snapshot replacement failed: ${describeError(backupError)}; staging cleanup failed: ${describeError(cleanupError)}`,
          backupError,
        );
      }
      throw backupError;
    }
  }

  try {
    await fileOperations.rename(stagingRoot, destinationRoot);
    replacementState = "installed";
  } catch (installError) {
    let rollbackError;
    if (backupCreated) {
      try {
        await fileOperations.rename(backupRoot, destinationRoot);
        backupCreated = false;
        replacementState = "rolled-back";
      } catch (error) {
        rollbackError = error;
        replacementState = "rollback-failed";
      }
    }

    let cleanupError;
    try {
      await fileOperations.rm(stagingRoot, {
        recursive: true,
        force: true,
      });
    } catch (error) {
      cleanupError = error;
    }

    if (rollbackError) {
      const backupPreserved = await pathExists(
        backupRoot,
        fileOperations.lstat,
      ).catch(() => false);
      const backupState = backupPreserved
        ? `backup preserved at ${backupRoot}`
        : `backup state unknown at ${backupRoot}`;
      const cleanupState = cleanupError
        ? `; staging cleanup failed: ${describeError(cleanupError)}`
        : "";
      throw createCombinedError(
        `snapshot rollback failed; state=${replacementState}; ${backupState}; install error: ${describeError(installError)}; rollback error: ${describeError(rollbackError)}${cleanupState}`,
        installError,
      );
    }

    if (cleanupError) {
      throw createCombinedError(
        `snapshot replacement failed; state=${replacementState}; install error: ${describeError(installError)}; staging cleanup failed: ${describeError(cleanupError)}`,
        installError,
      );
    }
    throw installError;
  }

  if (backupCreated) {
    try {
      await fileOperations.rm(backupRoot, {
        recursive: true,
        force: true,
      });
    } catch (cleanupError) {
      throw createCombinedError(
        `snapshot installed but backup cleanup failed; backup preserved at ${backupRoot}; state=${replacementState}; cleanup error: ${describeError(cleanupError)}`,
        cleanupError,
      );
    }
  }
}

export const __testing = Object.freeze({
  replaceSnapshotAtomically,
});

export async function syncSnapshot(
  destination = "vendor/qwenpaw-console",
) {
  const destinationRoot = path.resolve(destination);
  const parentRoot = path.dirname(destinationRoot);
  await mkdir(parentRoot, { recursive: true });

  const cloneContainer = await mkdtemp(
    path.join(os.tmpdir(), "dm-qwenpaw-clone-"),
  );
  const cloneRoot = path.join(cloneContainer, "upstream");
  let stagingRoot;
  let syncFailure;

  try {
    stagingRoot = await mkdtemp(
      path.join(parentRoot, ".qwenpaw-console-staging-"),
    );
    await clonePinnedUpstream(cloneRoot);
    await copySnapshotPayload(cloneRoot, stagingRoot);

    const {
      calculateDirectoryHash,
      hashSnapshotFiles,
      renderChecksums,
      verifySnapshot,
    } = await import("./verify-upstream.mjs");
    const payloadFiles = await hashSnapshotFiles(stagingRoot, FORBIDDEN_SEGMENTS);
    const directoryHash = calculateDirectoryHash(payloadFiles);
    await writeFile(
      path.join(stagingRoot, "SHA256SUMS"),
      renderChecksums(payloadFiles),
      "utf8",
    );
    await writeFile(
      path.join(stagingRoot, "UPSTREAM.md"),
      renderMetadata(directoryHash),
      "utf8",
    );

    const verified = await verifySnapshot(stagingRoot);
    await replaceSnapshotAtomically(stagingRoot, destinationRoot);
    return verified;
  } catch (error) {
    syncFailure = error;
    throw error;
  } finally {
    const cleanupResults = await Promise.allSettled([
      rm(cloneContainer, { recursive: true, force: true }),
      stagingRoot
        ? rm(stagingRoot, { recursive: true, force: true })
        : Promise.resolve(),
    ]);
    const cleanupFailures = cleanupResults.filter(
      (result) => result.status === "rejected",
    );
    if (cleanupFailures.length > 0) {
      const cleanupMessage = cleanupFailures
        .map((result) =>
          result.status === "rejected"
            ? describeError(result.reason)
            : "unknown cleanup failure",
        )
        .join("; ");
      if (syncFailure) {
        throw createCombinedError(
          `snapshot sync failed: ${describeError(syncFailure)}; temporary cleanup failed: ${cleanupMessage}`,
          syncFailure,
        );
      }
      throw createCombinedError(
        `snapshot sync completed but temporary cleanup failed: ${cleanupMessage}`,
        cleanupFailures[0].status === "rejected"
          ? cleanupFailures[0].reason
          : undefined,
      );
    }
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  syncSnapshot()
    .then((result) => {
      console.log(`${result.commit} · ${result.files} files · snapshot synced`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "snapshot sync failed");
      process.exitCode = 1;
    });
}
