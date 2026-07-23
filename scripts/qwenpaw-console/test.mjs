import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareConsole } from "./prepare.mjs";
import {
  appendCleanupError,
  attachSignalToError,
  createSignalLifecycle,
  formatCleanupErrorDetails,
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
      const preparedWorkdir =
        prepared &&
        typeof prepared === "object" &&
        typeof prepared.workdir === "string"
          ? prepared.workdir
          : undefined;
      if (!preparedWorkdir || preparedWorkdir.trim().length === 0) {
        throw new Error(
          "Console preparation did not return a workdir",
        );
      }
      workdir = preparedWorkdir;

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
        primaryError = appendCleanupError(primaryError, {
          stage: "prepared",
          path: workdir,
          error: cleanupError,
        });
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
      const decoratedCleanupError = appendCleanupError(cleanupError, {
        stage: "prepared",
        path: workdir,
        error: cleanupError,
      });
      if (outcome.exitCode !== 0 || outcome.signal) {
        return {
          ...outcome,
          cleanupError: decoratedCleanupError,
        };
      }
      throw decoratedCleanupError;
    }
    return outcome;
  } finally {
    signalLifecycle.remove();
  }
}

async function runTestCli({
  resendSignal = (signal) => process.kill(process.pid, signal),
  runTests = () =>
    runPreparedConsoleTests({
      createLifecycle: () =>
        createSignalLifecycle({
          onDiagnostic: (diagnostic) => {
            console.error(formatSignalLifecycleDiagnostic(diagnostic));
          },
        }),
    }),
  setExitCode = (exitCode) => {
    process.exitCode = exitCode;
  },
  writeStderr = (line) => {
    console.error(line);
  },
} = {}) {
  const writeCleanupDetails = (error) => {
    const details = formatCleanupErrorDetails(error);
    if (details.length > 0) {
      for (const detail of details) {
        writeStderr(detail);
      }
      return;
    }
    const cleanupError =
      error && typeof error === "object"
        ? Reflect.get(error, "cleanupError")
        : undefined;
    if (cleanupError) {
      writeStderr(
        cleanupError instanceof Error
          ? `Console cleanup failed: ${cleanupError.message}`
          : "Console cleanup failed",
      );
    }
  };

  try {
    const { exitCode, signal, cleanupError } = await runTests();
    if (cleanupError) {
      writeCleanupDetails(cleanupError);
    }
    if (signal) {
      resendSignal(signal);
      return;
    }
    setExitCode(exitCode);
  } catch (error) {
    const signal =
      error && typeof error === "object"
        ? Reflect.get(error, "signal")
        : undefined;
    writeStderr(
      error instanceof Error ? error.message : "Console tests failed",
    );
    writeCleanupDetails(error);
    if (signal) {
      resendSignal(signal);
      return;
    }
    setExitCode(1);
  }
}

export const __testing = Object.freeze({
  runTestCli,
  validateConsoleBuild,
});

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  void runTestCli();
}
