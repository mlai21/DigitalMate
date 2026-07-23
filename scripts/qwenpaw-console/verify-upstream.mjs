import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FORBIDDEN_SEGMENTS,
  SNAPSHOT_PATHS,
  UPSTREAM,
} from "./sync.mjs";

const METADATA_FILES = new Set(["SHA256SUMS", "UPSTREAM.md"]);
const SNAPSHOT_DIRECTORY_PATHS = new Set([
  "console",
  "reference/src/qwenpaw/app/channels",
  "reference/tests/unit/channels",
  "reference/tests/contract/channels",
  "reference/tests/fixtures/channels",
]);
const UPSTREAM_METADATA_FIELDS = [
  "Repository",
  "Tag",
  "Commit",
  "Directory SHA-256",
];

function comparePosixPaths(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function hasForbiddenSegment(relativePath, forbiddenSegments) {
  const forbidden = new Set(forbiddenSegments);
  return relativePath.split("/").some((segment) => forbidden.has(segment));
}

function isAllowedPayloadPath(relativePath) {
  if (relativePath === "LICENSE") {
    return true;
  }

  if (
    relativePath === "reference/src/qwenpaw/config/config.py" ||
    relativePath === "reference/src/qwenpaw/app/routers/config.py"
  ) {
    return true;
  }

  return [...SNAPSHOT_DIRECTORY_PATHS].some(
    (directoryPath) => relativePath.startsWith(`${directoryPath}/`),
  );
}

function isAllowedDirectoryPath(relativePath) {
  return SNAPSHOT_PATHS.some(
    (snapshotPath) =>
      snapshotPath === relativePath ||
      snapshotPath.startsWith(`${relativePath}/`) ||
      (SNAPSHOT_DIRECTORY_PATHS.has(snapshotPath) &&
        relativePath.startsWith(`${snapshotPath}/`)),
  );
}

function validateManifestPath(relativePath) {
  if (
    relativePath.includes("\\") ||
    path.posix.isAbsolute(relativePath) ||
    relativePath.startsWith("./")
  ) {
    throw new Error("invalid checksum path");
  }

  const segments = relativePath.split("/");
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
    path.posix.normalize(relativePath) !== relativePath
  ) {
    throw new Error("invalid checksum path");
  }

  if (hasForbiddenSegment(relativePath, FORBIDDEN_SEGMENTS)) {
    throw new Error("forbidden path segment");
  }
  if (!isAllowedPayloadPath(relativePath)) {
    throw new Error("invalid checksum path");
  }
}

async function readSnapshotMetadata(filePath, missingMessage) {
  const entry = await lstat(filePath).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error(missingMessage);
    }
    throw error;
  });
  if (entry.isSymbolicLink()) {
    throw new Error("symbolic link not allowed");
  }
  if (!entry.isFile()) {
    throw new Error("non-regular snapshot metadata");
  }

  return readFile(filePath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error(missingMessage);
    }
    if (error?.code === "EISDIR") {
      throw new Error("non-regular snapshot metadata");
    }
    throw error;
  });
}

function parseUpstreamMetadata(metadata) {
  const parsedFields = new Map(
    UPSTREAM_METADATA_FIELDS.map((field) => [field, []]),
  );
  const exactFieldPattern =
    /^- (Repository|Tag|Commit|Directory SHA-256): (.+)$/;
  const fieldLikePattern =
    /^\s*(?:-\s*)?(Repository|Tag|Commit|Directory SHA-256)\s*:/;

  for (const line of metadata.split("\n")) {
    const exactMatch = exactFieldPattern.exec(line);
    if (exactMatch) {
      parsedFields.get(exactMatch[1]).push(exactMatch[2]);
      continue;
    }
    if (fieldLikePattern.test(line)) {
      throw new Error("invalid upstream metadata");
    }
  }

  if (
    UPSTREAM_METADATA_FIELDS.some(
      (field) => parsedFields.get(field).length !== 1,
    )
  ) {
    throw new Error("invalid upstream metadata");
  }

  const directoryHash = parsedFields.get("Directory SHA-256")[0];
  if (!/^[a-f0-9]{64}$/.test(directoryHash)) {
    throw new Error("invalid upstream metadata");
  }

  return {
    repository: parsedFields.get("Repository")[0],
    tag: parsedFields.get("Tag")[0],
    commit: parsedFields.get("Commit")[0],
    directoryHash,
  };
}

async function sha256File(filePath) {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

async function verifyRequiredPaths(root) {
  for (const relativePath of SNAPSHOT_PATHS) {
    const entry = await lstat(path.join(root, ...relativePath.split("/"))).catch(
      (error) => {
        if (error?.code === "ENOENT") {
          throw new Error("required snapshot path missing");
        }
        throw error;
      },
    );

    if (entry.isSymbolicLink()) {
      throw new Error("symbolic link not allowed");
    }
    if (SNAPSHOT_DIRECTORY_PATHS.has(relativePath) && !entry.isDirectory()) {
      throw new Error("required snapshot path invalid");
    }
    if (!SNAPSHOT_DIRECTORY_PATHS.has(relativePath) && !entry.isFile()) {
      if (!entry.isDirectory()) {
        throw new Error("non-regular snapshot entry");
      }
      throw new Error("required snapshot path invalid");
    }
  }
}

export function renderChecksums(entries) {
  return `${entries
    .map(({ sha256, path: relativePath }) => `${sha256}  ${relativePath}`)
    .join("\n")}\n`;
}

export function calculateDirectoryHash(entries) {
  return createHash("sha256").update(renderChecksums(entries)).digest("hex");
}

export async function readChecksums(checksumPath) {
  const content = await readSnapshotMetadata(
    checksumPath,
    "SHA256SUMS missing",
  );

  const lines = content.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  if (lines.length === 0 || lines.some((line) => line.length === 0)) {
    throw new Error("invalid checksum format");
  }

  const seenPaths = new Set();
  const entries = lines.map((line) => {
    const match = /^([a-f0-9]{64})  ([^\r\n]+)$/.exec(line);
    if (!match) {
      throw new Error("invalid checksum format");
    }

    const relativePath = match[2];
    validateManifestPath(relativePath);
    if (seenPaths.has(relativePath)) {
      throw new Error("duplicate checksum entry");
    }
    seenPaths.add(relativePath);
    return { sha256: match[1], path: relativePath };
  });

  const sortedPaths = entries
    .map((entry) => entry.path)
    .toSorted(comparePosixPaths);
  if (entries.some((entry, index) => entry.path !== sortedPaths[index])) {
    throw new Error("invalid checksum order");
  }

  return entries;
}

export async function hashSnapshotFiles(
  root,
  forbiddenSegments = FORBIDDEN_SEGMENTS,
) {
  const rootEntry = await lstat(root);
  if (rootEntry.isSymbolicLink()) {
    throw new Error("symbolic link not allowed");
  }
  if (!rootEntry.isDirectory()) {
    throw new Error("snapshot root invalid");
  }

  const hashedFiles = [];

  async function walk(directoryPath, relativeDirectory = "") {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => comparePosixPaths(left.name, right.name));

    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;

      if (hasForbiddenSegment(relativePath, forbiddenSegments)) {
        throw new Error("forbidden path segment");
      }
      if (entry.isSymbolicLink()) {
        throw new Error("symbolic link not allowed");
      }

      const absolutePath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        if (!isAllowedDirectoryPath(relativePath)) {
          throw new Error("unregistered snapshot file");
        }
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error("non-regular snapshot entry");
      }
      if (relativeDirectory === "" && METADATA_FILES.has(entry.name)) {
        continue;
      }
      if (!isAllowedPayloadPath(relativePath)) {
        throw new Error("unregistered snapshot file");
      }

      hashedFiles.push({
        sha256: await sha256File(absolutePath),
        path: relativePath,
      });
    }
  }

  await walk(root);
  hashedFiles.sort((left, right) => comparePosixPaths(left.path, right.path));
  return hashedFiles;
}

export async function verifySnapshot(root = "vendor/qwenpaw-console") {
  const metadata = await readSnapshotMetadata(
    path.join(root, "UPSTREAM.md"),
    "UPSTREAM.md missing",
  );
  const upstreamMetadata = parseUpstreamMetadata(metadata);
  if (
    upstreamMetadata.repository !== UPSTREAM.repository ||
    upstreamMetadata.tag !== UPSTREAM.tag ||
    upstreamMetadata.commit !== UPSTREAM.commit
  ) {
    throw new Error("upstream identity mismatch");
  }

  const expected = await readChecksums(path.join(root, "SHA256SUMS"));
  await verifyRequiredPaths(root);
  const actual = await hashSnapshotFiles(root, FORBIDDEN_SEGMENTS);

  const expectedPaths = new Set(expected.map((entry) => entry.path));
  const actualPaths = new Set(actual.map((entry) => entry.path));
  if (actual.some((entry) => !expectedPaths.has(entry.path))) {
    throw new Error("unregistered snapshot file");
  }
  if (expected.some((entry) => !actualPaths.has(entry.path))) {
    throw new Error("registered snapshot file missing");
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("snapshot checksum mismatch");
  }

  if (
    upstreamMetadata.directoryHash !== calculateDirectoryHash(actual)
  ) {
    throw new Error("snapshot directory hash mismatch");
  }

  return { files: actual.length, commit: UPSTREAM.commit };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  verifySnapshot()
    .then((result) => {
      console.log(
        `${result.commit} · ${result.files} files · snapshot verified`,
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "snapshot verification failed");
      process.exitCode = 1;
    });
}
