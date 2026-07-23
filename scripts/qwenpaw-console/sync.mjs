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
  ["console", "console"],
  ["LICENSE", "LICENSE"],
  ["src/qwenpaw/app/channels", "reference/src/qwenpaw/app/channels"],
  ["src/qwenpaw/config/config.py", "reference/src/qwenpaw/config/config.py"],
  [
    "src/qwenpaw/app/routers/config.py",
    "reference/src/qwenpaw/app/routers/config.py",
  ],
  ["tests/unit/channels", "reference/tests/unit/channels"],
  ["tests/contract/channels", "reference/tests/contract/channels"],
  ["tests/fixtures/channels", "reference/tests/fixtures/channels"],
]);

async function pathExists(targetPath) {
  return lstat(targetPath)
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

async function copySnapshotPayload(cloneRoot, stagingRoot) {
  for (const [sourcePath, destinationPath] of SOURCE_MAPPINGS) {
    const source = path.join(cloneRoot, ...sourcePath.split("/"));
    const destination = path.join(stagingRoot, ...destinationPath.split("/"));
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

async function replaceSnapshotAtomically(stagingRoot, destinationRoot) {
  const parentRoot = path.dirname(destinationRoot);
  const backupRoot = path.join(
    parentRoot,
    `.qwenpaw-console-backup-${randomUUID()}`,
  );
  const hadExistingSnapshot = await pathExists(destinationRoot);
  let backupCreated = false;

  try {
    if (hadExistingSnapshot) {
      await rename(destinationRoot, backupRoot);
      backupCreated = true;
    }

    try {
      await rename(stagingRoot, destinationRoot);
    } catch (error) {
      if (backupCreated) {
        await rename(backupRoot, destinationRoot);
        backupCreated = false;
      }
      throw error;
    }

    if (backupCreated) {
      await rm(backupRoot, { recursive: true, force: true });
      backupCreated = false;
    }
  } finally {
    if (backupCreated && !(await pathExists(destinationRoot))) {
      await rename(backupRoot, destinationRoot);
      backupCreated = false;
    }
    if (backupCreated) {
      await rm(backupRoot, { recursive: true, force: true });
    }
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

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
  } finally {
    const cleanupResults = await Promise.allSettled([
      rm(cloneContainer, { recursive: true, force: true }),
      stagingRoot
        ? rm(stagingRoot, { recursive: true, force: true })
        : Promise.resolve(),
    ]);
    const cleanupFailure = cleanupResults.find(
      (result) => result.status === "rejected",
    );
    if (cleanupFailure?.status === "rejected") {
      throw cleanupFailure.reason;
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
