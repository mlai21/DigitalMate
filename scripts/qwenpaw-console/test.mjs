import { spawn } from "node:child_process";
import { lstat, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareConsole } from "./prepare.mjs";

const CONSOLE_BASE_PATH = "/_admin-console/";

export const COMMANDS = Object.freeze([
  Object.freeze(["npm", "ci"]),
  Object.freeze(["npm", "run", "test:run"]),
  Object.freeze(["npm", "run", "build:prod"]),
]);

function spawnCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: "inherit",
    });
    let forwardedSignal = null;

    const forwardSignal = (signal) => {
      forwardedSignal = signal;
      if (!child.killed) {
        child.kill(signal);
      }
    };
    const onSigint = () => forwardSignal("SIGINT");
    const onSigterm = () => forwardSignal("SIGTERM");
    const removeSignalHandlers = () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };

    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    child.once("error", (error) => {
      removeSignalHandlers();
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      removeSignalHandlers();
      resolve({
        exitCode: exitCode ?? (signal || forwardedSignal ? 1 : 0),
        signal: signal ?? forwardedSignal,
      });
    });
  });
}

async function removePreparedConsole(workdir) {
  await rm(workdir, { recursive: true, force: true });
}

function getBuildResourceUrls(indexHtml) {
  return [...indexHtml.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)].map(
    ([, resourceUrl]) => resourceUrl,
  );
}

async function requireRegularFile(filePath, description) {
  let stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    throw new Error(`${description} missing: ${filePath}`, { cause: error });
  }
  if (!stats.isFile()) {
    throw new Error(`${description} is not a file: ${filePath}`);
  }
}

async function validateConsoleBuild(workdir) {
  const distRoot = path.join(workdir, "dist");
  const indexPath = path.join(distRoot, "index.html");
  await requireRegularFile(indexPath, "build entry");
  const indexHtml = await readFile(indexPath, "utf8");
  const resourceUrls = getBuildResourceUrls(indexHtml);

  for (const resourceUrl of resourceUrls) {
    if (
      resourceUrl.startsWith("data:") ||
      resourceUrl.startsWith("#") ||
      /^[a-z][a-z\d+.-]*:/i.test(resourceUrl) ||
      resourceUrl.startsWith("//")
    ) {
      continue;
    }
    const resourcePath = resourceUrl.split(/[?#]/, 1)[0];
    if (!resourcePath.startsWith(CONSOLE_BASE_PATH)) {
      throw new Error(
        `build resource outside ${CONSOLE_BASE_PATH}: ${resourceUrl}`,
      );
    }
    const relativePath = decodeURIComponent(
      resourcePath.slice(CONSOLE_BASE_PATH.length),
    );
    const absolutePath = path.resolve(distRoot, relativePath);
    if (
      absolutePath !== distRoot &&
      !absolutePath.startsWith(`${distRoot}${path.sep}`)
    ) {
      throw new Error(`invalid build resource path: ${resourceUrl}`);
    }
    await requireRegularFile(absolutePath, "missing build asset");
  }

  const logoPath = path.join(distRoot, "digitalmate-logo.svg");
  await requireRegularFile(logoPath, "digitalmate-logo.svg");
  return {
    indexPath,
    logoPath,
    resourceUrls: [...resourceUrls],
  };
}

function attachCleanupError(primaryError, cleanupError) {
  if (primaryError && typeof primaryError === "object") {
    Object.defineProperty(primaryError, "cleanupError", {
      configurable: true,
      value: cleanupError,
    });
  }
}

export async function runPreparedConsoleTests({
  prepare = prepareConsole,
  runCommand = spawnCommand,
  validateBuild = validateConsoleBuild,
  cleanup = removePreparedConsole,
} = {}) {
  let workdir;
  let outcome = { exitCode: 0, signal: null };
  let primaryError;

  try {
    const prepared = await prepare({ keep: true });
    workdir = prepared.workdir;

    for (const [command, ...args] of COMMANDS) {
      outcome = await runCommand(command, args, { cwd: workdir });
      if (outcome.exitCode !== 0 || outcome.signal) {
        break;
      }
    }
    if (outcome.exitCode === 0 && !outcome.signal) {
      await validateBuild(workdir);
    }
  } catch (error) {
    primaryError = error;
  }

  let cleanupError;
  if (workdir) {
    try {
      await cleanup(workdir);
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
    if (outcome.exitCode !== 0 || outcome.signal) {
      return { ...outcome, cleanupError };
    }
    throw cleanupError;
  }
  return outcome;
}

export const __testing = Object.freeze({
  validateConsoleBuild,
});

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  runPreparedConsoleTests().then(
    ({ exitCode, signal, cleanupError }) => {
      if (cleanupError) {
        console.error(
          cleanupError instanceof Error
            ? `Console cleanup failed: ${cleanupError.message}`
            : "Console cleanup failed",
        );
      }
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exitCode = exitCode;
    },
    (error) => {
      const cleanupError =
        error && typeof error === "object"
          ? Reflect.get(error, "cleanupError")
          : undefined;
      console.error(
        error instanceof Error ? error.message : "Console tests failed",
      );
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
