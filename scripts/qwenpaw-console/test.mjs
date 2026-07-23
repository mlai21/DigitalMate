import { spawn } from "node:child_process";
import { lstat, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareConsole } from "./prepare.mjs";

const CONSOLE_BASE_PATH = "/_admin-console/";
const STATIC_RESOURCE_EXTENSIONS = new Set([
  ".avif",
  ".css",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".js",
  ".mjs",
  ".mp3",
  ".mp4",
  ".ogg",
  ".otf",
  ".png",
  ".svg",
  ".ttf",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
]);

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
    options.signalLifecycle?.attachChild(child);
    child.once("error", (error) => {
      options.signalLifecycle?.detachChild(child);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      options.signalLifecycle?.detachChild(child);
      const interruptedSignal = signal ?? options.signalLifecycle?.signal;
      resolve({
        exitCode: exitCode ?? (interruptedSignal ? 1 : 0),
        signal: interruptedSignal ?? null,
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

function createSignalLifecycle() {
  let signal = null;
  let activeChild = null;
  let forwardedChild = null;

  const forwardToActiveChild = () => {
    if (
      signal &&
      activeChild &&
      forwardedChild !== activeChild &&
      !activeChild.killed
    ) {
      forwardedChild = activeChild;
      activeChild.kill(signal);
    }
  };
  const recordSignal = (receivedSignal) => {
    signal ??= receivedSignal;
    forwardToActiveChild();
  };
  const onSigint = () => recordSignal("SIGINT");
  const onSigterm = () => recordSignal("SIGTERM");

  return {
    get signal() {
      return signal;
    },
    install() {
      process.on("SIGINT", onSigint);
      process.on("SIGTERM", onSigterm);
    },
    remove() {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    },
    attachChild(child) {
      activeChild = child;
      forwardToActiveChild();
    },
    detachChild(child) {
      if (activeChild === child) {
        activeChild = null;
      }
    },
  };
}

async function listBuildFiles(root, current = root) {
  const files = [];
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listBuildFiles(root, absolutePath)));
    } else if (entry.isFile()) {
      files.push({
        absolutePath,
        relativePath: path.relative(root, absolutePath).split(path.sep).join("/"),
      });
    }
  }
  return files;
}

function getCssResourceUrls(source) {
  return [...source.matchAll(/url\(\s*(["']?)([^'")]+)\1\s*\)/gi)].map(
    ([, , resourceUrl]) => resourceUrl.trim(),
  );
}

function isStaticResourceUrl(resourceUrl) {
  if (!resourceUrl.startsWith("/") || resourceUrl.startsWith("//")) {
    return false;
  }
  const resourcePath = resourceUrl.split(/[?#]/, 1)[0];
  return STATIC_RESOURCE_EXTENSIONS.has(
    path.posix.extname(resourcePath).toLowerCase(),
  );
}

function getJavaScriptResourceUrls(source) {
  const resourceUrls = [];
  const stringLiteral =
    /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`/g;
  for (const match of source.matchAll(stringLiteral)) {
    const rawValue = match[1] ?? match[2] ?? match[3] ?? "";
    if (rawValue.includes("${")) {
      continue;
    }
    const resourceUrl = rawValue.replaceAll("\\/", "/");
    if (isStaticResourceUrl(resourceUrl)) {
      resourceUrls.push(resourceUrl);
    }
  }
  return resourceUrls;
}

function resolveBuildResourcePath(distRoot, resourcePath) {
  const relativePath = decodeURIComponent(
    resourcePath.slice(CONSOLE_BASE_PATH.length),
  );
  const absolutePath = path.resolve(distRoot, relativePath);
  if (
    absolutePath !== distRoot &&
    !absolutePath.startsWith(`${distRoot}${path.sep}`)
  ) {
    throw new Error(`invalid build resource path: ${resourcePath}`);
  }
  return absolutePath;
}

async function validateBuildResource(
  distRoot,
  distFiles,
  resourceUrl,
  { requirePrefixed = false } = {},
) {
  if (
    resourceUrl.startsWith("data:") ||
    resourceUrl.startsWith("#") ||
    /^[a-z][a-z\d+.-]*:/i.test(resourceUrl) ||
    resourceUrl.startsWith("//")
  ) {
    return;
  }
  const resourcePath = resourceUrl.split(/[?#]/, 1)[0];
  if (!resourcePath.startsWith(CONSOLE_BASE_PATH)) {
    const rootRelativePath = decodeURIComponent(resourcePath.slice(1));
    if (requirePrefixed || distFiles.has(rootRelativePath)) {
      throw new Error(
        `build resource outside ${CONSOLE_BASE_PATH}: ${resourceUrl}`,
      );
    }
    return;
  }
  const absolutePath = resolveBuildResourcePath(distRoot, resourcePath);
  await requireRegularFile(absolutePath, "missing build asset");
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
  const buildFiles = await listBuildFiles(distRoot);
  const distFiles = new Set(buildFiles.map(({ relativePath }) => relativePath));
  const resourceUrls = [];

  for (const { absolutePath, relativePath } of buildFiles) {
    const extension = path.extname(relativePath).toLowerCase();
    if (![".css", ".html", ".js", ".mjs"].includes(extension)) {
      continue;
    }
    const source = await readFile(absolutePath, "utf8");
    let discoveredUrls = [];
    let requirePrefixed = false;
    if (extension === ".html") {
      discoveredUrls = getBuildResourceUrls(source);
      requirePrefixed = true;
    } else if (extension === ".css") {
      discoveredUrls = getCssResourceUrls(source).filter((resourceUrl) =>
        isStaticResourceUrl(resourceUrl),
      );
    } else {
      discoveredUrls = getJavaScriptResourceUrls(source);
    }
    for (const resourceUrl of discoveredUrls) {
      resourceUrls.push(resourceUrl);
      await validateBuildResource(distRoot, distFiles, resourceUrl, {
        requirePrefixed,
      });
    }
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
  const signalLifecycle = createSignalLifecycle();

  signalLifecycle.install();
  try {
    try {
      const prepared = await prepare({ keep: true });
      workdir = prepared.workdir;

      if (signalLifecycle.signal) {
        outcome = { exitCode: 1, signal: signalLifecycle.signal };
      }
      for (const [command, ...args] of COMMANDS) {
        if (outcome.signal) {
          break;
        }
        outcome = await runCommand(command, args, {
          cwd: workdir,
          signalLifecycle,
        });
        if (signalLifecycle.signal && !outcome.signal) {
          outcome = { ...outcome, signal: signalLifecycle.signal };
        }
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

    if (signalLifecycle.signal) {
      outcome = {
        exitCode: outcome.exitCode === 0 ? 1 : outcome.exitCode,
        signal: signalLifecycle.signal,
      };
    }

    if (primaryError !== undefined) {
      if (cleanupError !== undefined) {
        attachCleanupError(primaryError, cleanupError);
      }
      if (signalLifecycle.signal && typeof primaryError === "object") {
        Object.defineProperty(primaryError, "signal", {
          configurable: true,
          value: signalLifecycle.signal,
        });
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
  } finally {
    signalLifecycle.remove();
  }
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
      const signal =
        error && typeof error === "object"
          ? Reflect.get(error, "signal")
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
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exitCode = 1;
    },
  );
}
