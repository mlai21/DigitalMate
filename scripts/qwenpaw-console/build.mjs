import { spawn } from "node:child_process";
import {
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
import { __testing as consoleTestTesting } from "./test.mjs";

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
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  rename,
  rm,
});

function spawnCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      resolve({
        exitCode: exitCode ?? (signal ? 1 : 0),
        signal: signal ?? null,
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

function attachCleanupError(primaryError, cleanupError) {
  attachErrorDetail(primaryError, "cleanupError", cleanupError);
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
  if (
    !relativeFiles.some(
      (relativePath) =>
        relativePath.startsWith("assets/") &&
        CONTENT_HASHED_ASSET.test(path.posix.basename(relativePath)),
    )
  ) {
    throw new Error("content-hashed build asset missing");
  }

  return { indexPath, relativeFiles };
}

async function cleanupPath(targetPath, fileOperations, primaryError) {
  try {
    await fileOperations.rm(targetPath, { recursive: true, force: true });
  } catch (cleanupError) {
    if (primaryError !== undefined) {
      attachCleanupError(primaryError, cleanupError);
      return;
    }
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
    await cleanupPath(stagingRoot, fileOperations, primaryError);
  }
}

const defaultDependencies = Object.freeze({
  cleanupPrepared: (workdir) =>
    rm(workdir, { recursive: true, force: true }),
  prepare: prepareConsole,
  publicRoot: DEFAULT_PUBLIC_ROOT,
  publishBuild: publishConsoleBuild,
  runCommand: spawnCommand,
  validateBuild: consoleTestTesting.validateConsoleBuild,
});

/** @param {Partial<typeof defaultDependencies>} dependencies */
export async function buildConsole(dependencies = defaultDependencies) {
  const resolved = { ...defaultDependencies, ...dependencies };
  let workdir;
  let result;
  let primaryError;

  try {
    const prepared = await resolved.prepare({ keep: true });
    workdir = prepared.workdir;
    if (!workdir) {
      throw new Error("Console preparation did not return a workdir");
    }

    for (const [command, ...args] of BUILD_COMMANDS) {
      const outcome = await resolved.runCommand(command, args, {
        cwd: workdir,
      });
      if (outcome.exitCode !== 0 || outcome.signal) {
        throw createCommandError(command, args, outcome);
      }
    }

    await resolved.validateBuild(workdir);
    result = await resolved.publishBuild(path.join(workdir, "dist"), {
      publicRoot: resolved.publicRoot,
    });
  } catch (error) {
    primaryError = error;
  }

  let cleanupError;
  if (workdir) {
    try {
      await resolved.cleanupPrepared(workdir);
    } catch (error) {
      cleanupError = error;
    }
  }

  if (primaryError !== undefined) {
    if (cleanupError !== undefined) {
      attachCleanupError(primaryError, cleanupError);
    }
    throw primaryError;
  }
  if (cleanupError !== undefined) {
    throw cleanupError;
  }
  return result;
}

export const __testing = Object.freeze({
  publishConsoleBuild,
  validatePublishTree,
});

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  buildConsole().then(
    ({ publishRoot }) => {
      console.log(`DigitalMate Console published at ${publishRoot}`);
    },
    (error) => {
      console.error(
        error instanceof Error ? error.message : "Console build failed",
      );
      const cleanupError =
        error && typeof error === "object"
          ? Reflect.get(error, "cleanupError")
          : undefined;
      if (cleanupError) {
        console.error(
          cleanupError instanceof Error
            ? `Console cleanup failed: ${cleanupError.message}`
            : "Console cleanup failed",
        );
      }
      process.exitCode = 1;
    },
  );
}
