import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareConsole } from "./prepare.mjs";
import {
  attachSignalToError,
  createSignalLifecycle,
  formatSignalLifecycleDiagnostic,
  runManagedSpawn,
} from "./process-lifecycle.mjs";
import { validateConsoleBuild } from "./validate-build.mjs";

export { createSignalLifecycle, validateConsoleBuild };

export const COMMANDS = Object.freeze([
  Object.freeze(["npm", "ci"]),
  Object.freeze(["npm", "run", "test:run"]),
  Object.freeze(["npm", "run", "build:prod"]),
]);

function spawnCommand(command, args, options) {
  return runManagedSpawn(command, args, {
    cwd: options.cwd,
    env: process.env,
    signalLifecycle: options.signalLifecycle,
    stdio: "inherit",
  });
}

async function removePreparedConsole(workdir) {
  await rm(workdir, { recursive: true, force: true });
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
  createLifecycle = createSignalLifecycle,
  prepare = prepareConsole,
  runCommand = spawnCommand,
  validateBuild = validateConsoleBuild,
  cleanup = removePreparedConsole,
} = {}) {
  let workdir;
  let outcome = { exitCode: 0, signal: null };
  let primaryError;
  const signalLifecycle = createLifecycle();

  signalLifecycle.install();
  try {
    try {
      const prepared = await prepare({
        keep: true,
        signalLifecycle,
      });
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
      if (signalLifecycle.signal) {
        primaryError = attachSignalToError(
          primaryError,
          signalLifecycle.signal,
        );
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
  runPreparedConsoleTests({
    createLifecycle: () =>
      createSignalLifecycle({
        onDiagnostic: (diagnostic) => {
          console.error(formatSignalLifecycleDiagnostic(diagnostic));
        },
      }),
  }).then(
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
