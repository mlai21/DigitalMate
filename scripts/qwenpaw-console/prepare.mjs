import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendCleanupError,
  attachSignalToError,
  createSignalLifecycle,
  formatCleanupErrorDetails,
  formatSignalLifecycleDiagnostic,
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

function hasPreparedCleanupEntry(error, workdir) {
  if (!error || typeof error !== "object") {
    return false;
  }
  const cleanupErrors = Reflect.get(error, "cleanupErrors");
  return (
    Array.isArray(cleanupErrors) &&
    cleanupErrors.some(
      (cleanupEntry) =>
        cleanupEntry?.stage === "prepared" &&
        cleanupEntry?.path === workdir,
    )
  );
}

async function removePreparedDirectory(
  workdir,
  originalError,
  remove = rm,
) {
  try {
    await remove(workdir, { recursive: true, force: true });
  } catch (cleanupError) {
    const cleanupEntry = {
      stage: "prepared",
      path: workdir,
      error: cleanupError,
    };
    if (originalError !== undefined) {
      return appendCleanupError(originalError, cleanupEntry);
    }
    throw appendCleanupError(cleanupError, cleanupEntry);
  }
  return originalError;
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
    remove = rm,
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
      await removePreparedDirectory(workdir, undefined, remove);
      throwIfSignalRecorded(signalLifecycle, "prepared-cleanup");
      return { workdir: null, applied: [...applied] };
    }
    return { workdir, applied: [...applied] };
  } catch (error) {
    let interruptedError = attachSignalToError(
      error,
      signalLifecycle?.signal,
    );
    if (!hasPreparedCleanupEntry(interruptedError, workdir)) {
      interruptedError = await removePreparedDirectory(
        workdir,
        interruptedError,
        remove,
      );
    }
    throw interruptedError;
  }
}

export async function prepareConsole(options = {}) {
  if (options.signalLifecycle) {
    return prepareConsoleWithDependencies(options);
  }

  const { onDiagnostic, ...preparationOptions } = options;
  const signalLifecycle = createSignalLifecycle({ onDiagnostic });
  signalLifecycle.install();
  try {
    const result = await prepareConsoleWithDependencies({
      ...preparationOptions,
      signalLifecycle,
    });
    if (signalLifecycle.signal && result.workdir) {
      await removePreparedDirectory(result.workdir);
    }
    throwIfSignalRecorded(signalLifecycle, "preparation-complete");
    return result;
  } catch (error) {
    throw attachSignalToError(error, signalLifecycle.signal);
  } finally {
    signalLifecycle.remove();
  }
}

async function runPrepareCli({
  prepare = prepareConsole,
  resendSignal = (signal) => {
    process.kill(process.pid, signal);
  },
  setExitCode = (exitCode) => {
    process.exitCode = exitCode;
  },
  writeStderr = console.error,
  writeStdout = console.log,
} = {}) {
  try {
    const { applied } = await prepare({
      onDiagnostic: (diagnostic) => {
        writeStderr(formatSignalLifecycleDiagnostic(diagnostic));
      },
    });
    writeStdout(`Console patches verified: ${applied.join(", ")}`);
  } catch (error) {
    writeStderr(
      error instanceof Error ? error.message : "Console preparation failed",
    );
    for (const detailLine of formatCleanupErrorDetails(error)) {
      writeStderr(detailLine);
    }
    const signal =
      error && typeof error === "object"
        ? Reflect.get(error, "signal")
        : undefined;
    if (signal) {
      resendSignal(signal);
    } else {
      setExitCode(1);
    }
  }
}

export const __testing = Object.freeze({
  formatCleanupErrorDetails,
  prepareConsoleWithDependencies,
  runPrepareCli,
});

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  void runPrepareCli();
}
