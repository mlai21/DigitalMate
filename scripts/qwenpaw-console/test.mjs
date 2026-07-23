import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareConsole } from "./prepare.mjs";

export const COMMANDS = Object.freeze([
  Object.freeze(["npm", "ci"]),
  Object.freeze(["npm", "run", "test:run"]),
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

export async function runPreparedConsoleTests({
  prepare = prepareConsole,
  runCommand = spawnCommand,
} = {}) {
  let workdir;
  let outcome = { exitCode: 0, signal: null };

  try {
    const prepared = await prepare({ keep: true });
    workdir = prepared.workdir;

    for (const [command, ...args] of COMMANDS) {
      outcome = await runCommand(command, args, { cwd: workdir });
      if (outcome.exitCode !== 0 || outcome.signal) {
        return outcome;
      }
    }
    return outcome;
  } finally {
    if (workdir) {
      await rm(workdir, { recursive: true, force: true });
    }
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  runPreparedConsoleTests()
    .then(({ exitCode, signal }) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(
        error instanceof Error ? error.message : "Console tests failed",
      );
      process.exitCode = 1;
    });
}
