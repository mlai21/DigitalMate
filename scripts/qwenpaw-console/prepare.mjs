import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSignalLifecycle,
  runManagedExecFile,
  throwIfSignalRecorded,
} from "./process-lifecycle.mjs";
import { verifySnapshot } from "./verify-upstream.mjs";

const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_ROOT, "../..");
const SNAPSHOT_ROOT = path.join(REPOSITORY_ROOT, "vendor/qwenpaw-console");
const CONSOLE_ROOT = path.join(SNAPSHOT_ROOT, "console");
const PATCH_ROOT = path.join(REPOSITORY_ROOT, "patches/qwenpaw-console");

export const PATCHES = Object.freeze([
  "0001-brand.patch",
  "0002-theme.patch",
  "0003-route-auth.patch",
  "0004-api-compat.patch",
]);

const DEFAULT_PATCH_PATHS = Object.freeze(
  PATCHES.map((patchName) => path.join(PATCH_ROOT, patchName)),
);

async function applyPatch(
  workdir,
  patchPath,
  signalLifecycle,
  runExecFile,
) {
  const options = {
    cwd: workdir,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 10 * 1024 * 1024,
    signalLifecycle,
  };
  throwIfSignalRecorded(signalLifecycle, "patch-check");
  await runExecFile("git", ["apply", "--check", patchPath], options);
  throwIfSignalRecorded(signalLifecycle, "patch-apply");
  await runExecFile("git", ["apply", patchPath], options);
  throwIfSignalRecorded(signalLifecycle, "patch-applied");
}

async function removePreparedDirectory(workdir, originalError) {
  try {
    await rm(workdir, { recursive: true, force: true });
  } catch (cleanupError) {
    if (originalError && typeof originalError === "object") {
      Object.defineProperty(originalError, "cleanupError", {
        configurable: true,
        value: cleanupError,
      });
      return;
    }
    throw cleanupError;
  }
}

/**
 * @param {{
 *   keep?: boolean,
 *   signalLifecycle?: ReturnType<typeof createSignalLifecycle>,
 * }} [options]
 */
async function prepareConsoleWithDependencies(
  { keep = false, signalLifecycle } = {},
  {
    patchPaths = DEFAULT_PATCH_PATHS,
    runExecFile = runManagedExecFile,
    temporaryParent = os.tmpdir(),
    verify = () => verifySnapshot(SNAPSHOT_ROOT),
  } = {},
) {
  await verify();
  throwIfSignalRecorded(signalLifecycle, "initial-verification");
  const workdir = await mkdtemp(
    path.join(temporaryParent, "digitalmate-qwenpaw-console-"),
  );
  const applied = [];

  try {
    await cp(CONSOLE_ROOT, workdir, {
      force: false,
      recursive: true,
    });
    throwIfSignalRecorded(signalLifecycle, "snapshot-copy");

    for (const patchPath of patchPaths) {
      await applyPatch(
        workdir,
        path.resolve(patchPath),
        signalLifecycle,
        runExecFile,
      );
      applied.push(path.basename(patchPath));
    }

    throwIfSignalRecorded(signalLifecycle, "final-verification");
    await verify();
    throwIfSignalRecorded(signalLifecycle, "final-verification");
    if (!keep) {
      await removePreparedDirectory(workdir);
      throwIfSignalRecorded(signalLifecycle, "prepared-cleanup");
      return { workdir: null, applied: [...applied] };
    }
    return { workdir, applied: [...applied] };
  } catch (error) {
    await removePreparedDirectory(workdir, error);
    throw error;
  }
}

export async function prepareConsole(options = {}) {
  if (options.signalLifecycle) {
    return prepareConsoleWithDependencies(options);
  }

  const signalLifecycle = createSignalLifecycle();
  signalLifecycle.install();
  try {
    const result = await prepareConsoleWithDependencies({
      ...options,
      signalLifecycle,
    });
    if (signalLifecycle.signal && result.workdir) {
      await removePreparedDirectory(result.workdir);
    }
    throwIfSignalRecorded(signalLifecycle, "preparation-complete");
    return result;
  } finally {
    signalLifecycle.remove();
  }
}

export const __testing = Object.freeze({
  prepareConsoleWithDependencies,
});

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  prepareConsole()
    .then(({ applied }) => {
      console.log(`Console patches verified: ${applied.join(", ")}`);
    })
    .catch((error) => {
      console.error(
        error instanceof Error ? error.message : "Console preparation failed",
      );
      const signal =
        error && typeof error === "object"
          ? Reflect.get(error, "signal")
          : undefined;
      if (signal) {
        process.kill(process.pid, signal);
      } else {
        process.exitCode = 1;
      }
    });
}
