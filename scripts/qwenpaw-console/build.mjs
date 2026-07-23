import { spawn } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { prepareConsole } from "./prepare.mjs";
import {
  createSignalLifecycle,
  validateConsoleBuild,
} from "./test.mjs";

const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_ROOT, "../..");
const DEFAULT_PUBLIC_ROOT = path.join(REPOSITORY_ROOT, "public");
const PUBLISH_DIRECTORY = "_admin-console";
const STAGING_PREFIX = ".admin-console-staging-";
const BACKUP_PREFIX = ".admin-console-backup-";
const CONTENT_HASHED_ASSET = /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9.]+$/;

export const BUILD_COMMANDS = Object.freeze([
  Object.freeze(["npm", "ci"]),
  Object.freeze(["npm", "run", "build:prod"]),
]);

const defaultFileOperations = Object.freeze({
  cp,
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  rename,
  rm,
});

function spawnCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: "inherit",
    });
    options.signalLifecycle?.attachChild(child);
    child.once("error", (error) => {
      options.signalLifecycle?.detachChild(child);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("close", (exitCode, signal) => {
      options.signalLifecycle?.detachChild(child);
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        exitCode: exitCode ?? (signal || options.signalLifecycle?.signal ? 1 : 0),
        signal: signal ?? options.signalLifecycle?.signal ?? null,
      });
    });
  });
}

function attachErrorDetail(error, property, value) {
  if (error && typeof error === "object") {
    Object.defineProperty(error, property, {
      configurable: true,
      enumerable: true,
      value,
    });
  }
}

function appendCleanupError(primaryError, cleanupEntry) {
  if (!primaryError || typeof primaryError !== "object") {
    return;
  }
  const existing = Reflect.get(primaryError, "cleanupErrors");
  const cleanupErrors = Array.isArray(existing) ? [...existing] : [];
  cleanupErrors.push(cleanupEntry);
  attachErrorDetail(primaryError, "cleanupErrors", cleanupErrors);
  if (Reflect.get(primaryError, "cleanupError") === undefined) {
    attachErrorDetail(primaryError, "cleanupError", cleanupEntry.error);
  }
}

function createCommandError(command, args, outcome) {
  const commandLine = [command, ...args].join(" ");
  const error = new Error(
    outcome.signal
      ? `Console command interrupted by ${outcome.signal}: ${commandLine}`
      : `Console command failed with exit code ${outcome.exitCode}: ${commandLine}`,
  );
  attachErrorDetail(error, "command", commandLine);
  attachErrorDetail(error, "exitCode", outcome.exitCode);
  attachErrorDetail(error, "signal", outcome.signal);
  return error;
}

function createRollbackBlockedError(installError, backupPath, rollbackError) {
  const error = new Error(
    `Console publish state rollback-blocked; backup preserved at ${backupPath}`,
    { cause: installError },
  );
  attachErrorDetail(error, "publishState", "rollback-blocked");
  attachErrorDetail(error, "backupPath", backupPath);
  if (rollbackError !== undefined) {
    attachErrorDetail(error, "rollbackError", rollbackError);
  }
  return error;
}

async function pathExists(targetPath, fileOperations) {
  try {
    await fileOperations.lstat(targetPath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function requireDirectory(directoryPath, description, fileOperations) {
  let stats;
  try {
    stats = await fileOperations.lstat(directoryPath);
  } catch (error) {
    throw new Error(`${description} missing: ${directoryPath}`, {
      cause: error,
    });
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`symbolic link not allowed: ${directoryPath}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`${description} is not a directory: ${directoryPath}`);
  }
}

async function inspectBuildTree(
  root,
  current,
  relativeFiles,
  fileOperations,
) {
  const entries = await fileOperations.readdir(current, {
    withFileTypes: true,
  });
  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    const relativePath = path
      .relative(root, absolutePath)
      .split(path.sep)
      .join("/");
    const stats = await fileOperations.lstat(absolutePath);
    if (entry.isSymbolicLink() || stats.isSymbolicLink()) {
      throw new Error(`symbolic link not allowed: ${absolutePath}`);
    }
    if (entry.isDirectory() && stats.isDirectory()) {
      await inspectBuildTree(
        root,
        absolutePath,
        relativeFiles,
        fileOperations,
      );
      continue;
    }
    if (!entry.isFile() || !stats.isFile()) {
      throw new Error(`non-regular build entry not allowed: ${absolutePath}`);
    }
    relativeFiles.push(relativePath);
  }
}

async function validatePublishTree(
  buildRoot,
  fileOperations = defaultFileOperations,
) {
  await requireDirectory(buildRoot, "Console build root", fileOperations);

  const indexPath = path.join(buildRoot, "index.html");
  const indexStats = await fileOperations.lstat(indexPath).catch((error) => {
    throw new Error(`build entry missing: ${indexPath}`, { cause: error });
  });
  if (!indexStats.isFile() || indexStats.isSymbolicLink()) {
    throw new Error(`build entry is not a regular file: ${indexPath}`);
  }

  const assetsRoot = path.join(buildRoot, "assets");
  await requireDirectory(assetsRoot, "Console build assets", fileOperations);

  const relativeFiles = [];
  await inspectBuildTree(
    buildRoot,
    buildRoot,
    relativeFiles,
    fileOperations,
  );
  const assetFiles = relativeFiles.filter((relativePath) =>
    relativePath.startsWith("assets/"),
  );
  const unhashedAsset = assetFiles.find(
    (relativePath) =>
      !CONTENT_HASHED_ASSET.test(path.posix.basename(relativePath)),
  );
  if (assetFiles.length === 0 || unhashedAsset) {
    throw new Error(
      `unhashed build asset not allowed${
        unhashedAsset ? `: ${unhashedAsset}` : ""
      }`,
    );
  }

  return { indexPath, relativeFiles };
}

async function makePublishTreeReadable(
  current,
  fileOperations,
) {
  await fileOperations.chmod(current, 0o755);
  const entries = await fileOperations.readdir(current, {
    withFileTypes: true,
  });
  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    const stats = await fileOperations.lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      throw new Error(`symbolic link not allowed: ${absolutePath}`);
    }
    if (stats.isDirectory()) {
      await makePublishTreeReadable(absolutePath, fileOperations);
    } else if (stats.isFile()) {
      await fileOperations.chmod(absolutePath, 0o644);
    } else {
      throw new Error(`non-regular build entry not allowed: ${absolutePath}`);
    }
  }
}

async function cleanupPath(
  targetPath,
  fileOperations,
  primaryError,
  stage,
) {
  try {
    await fileOperations.rm(targetPath, { recursive: true, force: true });
  } catch (cleanupError) {
    const cleanupEntry = {
      stage,
      path: targetPath,
      error: cleanupError,
    };
    if (primaryError !== undefined) {
      appendCleanupError(primaryError, cleanupEntry);
      return;
    }
    appendCleanupError(cleanupError, cleanupEntry);
    throw cleanupError;
  }
}

async function publishConsoleBuild(
  distRoot,
  {
    publicRoot = DEFAULT_PUBLIC_ROOT,
    fileOperations: fileOperationOverrides = {},
  } = {},
) {
  const fileOperations = {
    ...defaultFileOperations,
    ...fileOperationOverrides,
  };
  await validatePublishTree(distRoot, fileOperations);
  await fileOperations.mkdir(publicRoot, { recursive: true });
  await requireDirectory(publicRoot, "public root", fileOperations);

  const publishRoot = path.join(publicRoot, PUBLISH_DIRECTORY);
  const stagingRoot = await fileOperations.mkdtemp(
    path.join(publicRoot, STAGING_PREFIX),
  );
  const backupRoot = path.join(
    publicRoot,
    `${BACKUP_PREFIX}${randomUUID()}`,
  );
  let primaryError;

  try {
    await fileOperations.cp(distRoot, stagingRoot, {
      errorOnExist: false,
      force: true,
      recursive: true,
    });
    await validatePublishTree(stagingRoot, fileOperations);
    await makePublishTreeReadable(stagingRoot, fileOperations);

    const hadPreviousPublish = await pathExists(publishRoot, fileOperations);
    if (hadPreviousPublish) {
      await requireDirectory(
        publishRoot,
        "existing Console publication",
        fileOperations,
      );
      await fileOperations.rename(publishRoot, backupRoot);
    }

    try {
      await fileOperations.rename(stagingRoot, publishRoot);
    } catch (installError) {
      if (hadPreviousPublish) {
        let rollbackBlockedError;
        try {
          if (await pathExists(publishRoot, fileOperations)) {
            rollbackBlockedError = createRollbackBlockedError(
              installError,
              backupRoot,
            );
          } else {
            try {
              await fileOperations.rename(backupRoot, publishRoot);
              attachErrorDetail(installError, "publishState", "rolled-back");
            } catch (rollbackError) {
              rollbackBlockedError = createRollbackBlockedError(
                installError,
                backupRoot,
                rollbackError,
              );
            }
          }
        } catch (rollbackInspectionError) {
          rollbackBlockedError = createRollbackBlockedError(
            installError,
            backupRoot,
            rollbackInspectionError,
          );
        }
        if (rollbackBlockedError) {
          throw rollbackBlockedError;
        }
      }
      throw installError;
    }

    if (hadPreviousPublish) {
      try {
        await fileOperations.rm(backupRoot, {
          recursive: true,
          force: false,
        });
      } catch (backupCleanupError) {
        attachErrorDetail(
          backupCleanupError,
          "publishState",
          "published-backup-retained",
        );
        attachErrorDetail(backupCleanupError, "backupPath", backupRoot);
        throw backupCleanupError;
      }
    }
    return { publishRoot };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await cleanupPath(
      stagingRoot,
      fileOperations,
      primaryError,
      "staging",
    );
  }
}

const defaultDependencies = Object.freeze({
  cleanupPrepared: (workdir) =>
    rm(workdir, { recursive: true, force: true }),
  prepare: prepareConsole,
  publicRoot: DEFAULT_PUBLIC_ROOT,
  publishBuild: publishConsoleBuild,
  runCommand: spawnCommand,
  validateBuild: validateConsoleBuild,
});

/** @param {Partial<typeof defaultDependencies>} dependencies */
export async function buildConsole(dependencies = defaultDependencies) {
  const resolved = { ...defaultDependencies, ...dependencies };
  const signalLifecycle = createSignalLifecycle();
  let workdir;
  let result;
  let primaryError;

  signalLifecycle.install();
  try {
    try {
      const prepared = await resolved.prepare({ keep: true });
      workdir = prepared.workdir;
      if (!workdir) {
        throw new Error("Console preparation did not return a workdir");
      }

      for (const [command, ...args] of BUILD_COMMANDS) {
        if (signalLifecycle.signal) {
          break;
        }
        const outcome = await resolved.runCommand(command, args, {
          cwd: workdir,
          signalLifecycle,
        });
        if (
          outcome.signal &&
          outcome.signal !== signalLifecycle.signal
        ) {
          throw createCommandError(command, args, outcome);
        }
        if (outcome.exitCode !== 0 && !signalLifecycle.signal) {
          throw createCommandError(command, args, outcome);
        }
      }

      if (!signalLifecycle.signal) {
        await resolved.validateBuild(workdir);
      }
      if (!signalLifecycle.signal) {
        result = await resolved.publishBuild(path.join(workdir, "dist"), {
          publicRoot: resolved.publicRoot,
        });
      }
    } catch (error) {
      primaryError = error;
    }

    if (workdir) {
      try {
        await resolved.cleanupPrepared(workdir);
      } catch (cleanupError) {
        const cleanupEntry = {
          stage: "prepared",
          path: workdir,
          error: cleanupError,
        };
        if (primaryError !== undefined) {
          appendCleanupError(primaryError, cleanupEntry);
        } else {
          appendCleanupError(cleanupError, cleanupEntry);
          primaryError = cleanupError;
        }
      }
    }

    if (primaryError !== undefined) {
      if (signalLifecycle.signal) {
        attachErrorDetail(primaryError, "signal", signalLifecycle.signal);
      }
      throw primaryError;
    }
    if (signalLifecycle.signal) {
      return {
        publishRoot: result?.publishRoot ?? null,
        signal: signalLifecycle.signal,
      };
    }
    return result;
  } finally {
    signalLifecycle.remove();
  }
}

export const __testing = Object.freeze({
  formatErrorDetails,
  publishConsoleBuild,
  validatePublishTree,
});

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function formatErrorDetails(error) {
  const lines = [];
  const publishState =
    error && typeof error === "object"
      ? Reflect.get(error, "publishState")
      : undefined;
  const backupPath =
    error && typeof error === "object"
      ? Reflect.get(error, "backupPath")
      : undefined;
  if (publishState || backupPath) {
    lines.push(
      `Console publish recovery: state=${publishState ?? "unknown"}${
        backupPath ? ` backup=${backupPath}` : ""
      }`,
    );
  }
  const cleanupErrors =
    error && typeof error === "object"
      ? Reflect.get(error, "cleanupErrors")
      : undefined;
  if (Array.isArray(cleanupErrors)) {
    for (const cleanupEntry of cleanupErrors) {
      lines.push(
        `Console cleanup failed at ${cleanupEntry.stage} (${cleanupEntry.path}): ${
          cleanupEntry.error instanceof Error
            ? cleanupEntry.error.message
            : "unknown cleanup error"
        }`,
      );
    }
  }
  return lines;
}

function reportErrorDetails(error) {
  for (const detailLine of formatErrorDetails(error)) {
    console.error(detailLine);
  }
}

if (isMain) {
  buildConsole().then(
    ({ publishRoot, signal }) => {
      if (publishRoot) {
        console.log(`DigitalMate Console published at ${publishRoot}`);
      }
      if (signal) {
        process.kill(process.pid, signal);
      }
    },
    (error) => {
      console.error(
        error instanceof Error ? error.message : "Console build failed",
      );
      reportErrorDetails(error);
      const signal =
        error && typeof error === "object"
          ? Reflect.get(error, "signal")
          : undefined;
      if (signal) {
        process.kill(process.pid, signal);
      } else {
        process.exitCode = 1;
      }
    },
  );
}
