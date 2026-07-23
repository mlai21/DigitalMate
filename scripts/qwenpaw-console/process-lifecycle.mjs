import { spawn } from "node:child_process";

const DEFAULT_FORCE_KILL_TIMEOUT_MS = 5_000;
const DEFAULT_TREE_EXIT_TIMEOUT_MS = 2_000;
const TREE_EXIT_POLL_INTERVAL_MS = 20;

/**
 * @typedef {object} SignalLifecycleDiagnostic
 * @property {string} action
 * @property {string} [command]
 * @property {unknown} [error]
 * @property {number | null} [exitCode]
 * @property {number | null} [pid]
 * @property {string | null} [signal]
 * @property {string} [target]
 * @property {number} [timestamp]
 */

export function getWindowsTreeKillCommand(pid, { force = false } = {}) {
  return {
    command: "taskkill",
    args: [
      "/PID",
      String(pid),
      "/T",
      ...(force ? ["/F"] : []),
    ],
  };
}

function createDiagnosticReporter(diagnostics, onDiagnostic) {
  return (diagnostic) => {
    const entry = {
      ...diagnostic,
      timestamp: Date.now(),
    };
    diagnostics.push(entry);
    if (typeof onDiagnostic === "function") {
      try {
        onDiagnostic(entry);
      } catch {
        // Diagnostic reporting must never interrupt process-tree cleanup.
      }
    }
  };
}

/** @param {SignalLifecycleDiagnostic} diagnostic */
export function formatSignalLifecycleDiagnostic(diagnostic) {
  const action = diagnostic?.action ?? "unknown";
  const target = diagnostic?.command
    ? diagnostic.command
    : `${diagnostic?.target ?? "process-tree"}${
        diagnostic?.pid ? ` pid=${diagnostic.pid}` : ""
      }`;
  let reason = "unknown failure";
  if (diagnostic?.exitCode !== undefined && diagnostic.exitCode !== null) {
    reason = `exit code ${diagnostic.exitCode}`;
  } else if (diagnostic?.signal) {
    reason = `signal ${diagnostic.signal}`;
  } else if (diagnostic?.error instanceof Error) {
    reason = diagnostic.error.message;
  }
  return `Console process cleanup ${action} failed for ${target}: ${reason}`;
}

export function attachSignalToError(error, signal) {
  if (!signal) {
    return error;
  }

  if (error && typeof error === "object") {
    try {
      Object.defineProperty(error, "signal", {
        configurable: true,
        enumerable: true,
        value: signal,
      });
      return error;
    } catch {
      // A frozen or non-configurable error is wrapped below.
    }
  }

  const wrapped = new Error(
    error instanceof Error
      ? error.message
      : "Console operation interrupted",
    { cause: error },
  );
  Object.defineProperty(wrapped, "signal", {
    configurable: true,
    enumerable: true,
    value: signal,
  });
  return wrapped;
}

function attachDiagnostic(reportDiagnostic, diagnostic) {
  reportDiagnostic({
    ...diagnostic,
  });
}

function terminateProcessTree(
  child,
  {
    force,
    killProcess,
    platform,
    reportDiagnostic,
    signal,
    spawnProcess,
  },
) {
  const pid = child?.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    const error = new Error("managed child has no valid pid");
    attachDiagnostic(reportDiagnostic, {
      action: force ? "force" : "graceful",
      error,
      pid: pid ?? null,
    });
    return Promise.resolve({ error, ok: false });
  }

  if (platform === "win32") {
    const { command, args } = getWindowsTreeKillCommand(pid, { force });
    return new Promise((resolve) => {
      let settled = false;
      const finish = ({
        error,
        exitCode,
        signal: exitSignal,
      } = {}) => {
        if (settled) {
          return;
        }
        settled = true;
        let outcome;
        if (error) {
          attachDiagnostic(reportDiagnostic, {
            action: force ? "force" : "graceful",
            command: [command, ...args].join(" "),
            error,
            pid,
          });
          outcome = { error, ok: false };
        } else if (
          (typeof exitCode === "number" && exitCode !== 0) ||
          exitSignal
        ) {
          attachDiagnostic(reportDiagnostic, {
            action: force ? "force" : "graceful",
            command: [command, ...args].join(" "),
            exitCode: exitCode ?? null,
            pid,
            signal: exitSignal ?? null,
          });
          outcome = {
            exitCode: exitCode ?? null,
            ok: false,
            signal: exitSignal ?? null,
          };
        } else {
          outcome = {
            exitCode: exitCode ?? 0,
            ok: true,
            signal: null,
          };
        }
        resolve(outcome);
      };

      try {
        const killer = spawnProcess(command, args, {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.once("error", (error) => {
          finish({
            error,
          });
        });
        killer.once("close", (exitCode, exitSignal) => {
          finish({ exitCode, signal: exitSignal });
        });
        killer.unref?.();
      } catch (error) {
        finish({
          error,
        });
      }
    });
  }

  const forwardedSignal = force ? "SIGKILL" : signal;
  try {
    killProcess(-pid, forwardedSignal);
    return Promise.resolve({ ok: true });
  } catch (groupError) {
    attachDiagnostic(reportDiagnostic, {
      action: force ? "force" : "graceful",
      error: groupError,
      pid,
      target: "process-group",
    });
    try {
      killProcess(pid, forwardedSignal);
      return Promise.resolve({
        error: groupError,
        fallback: "direct-child",
        ok: false,
      });
    } catch (childError) {
      attachDiagnostic(reportDiagnostic, {
        action: force ? "force" : "graceful",
        error: childError,
        pid,
        target: "direct-child-fallback",
      });
      return Promise.resolve({
        error: childError,
        groupError,
        ok: false,
      });
    }
  }
}

function isMissingProcessError(error) {
  return error?.code === "ESRCH";
}

function getProcessGroupState(pid, { killProcess }) {
  try {
    killProcess(-pid, 0);
    return { alive: true, error: null };
  } catch (error) {
    if (isMissingProcessError(error)) {
      return { alive: false, error: null };
    }
    return { alive: true, error };
  }
}

function waitForTimer(timerOperations, delayMs) {
  return new Promise((resolve) => {
    timerOperations.setTimeout(resolve, delayMs);
  });
}

function waitWithTimeout(promise, timeoutMs, timerOperations) {
  return new Promise((resolve) => {
    let completed = false;
    let timeout = null;
    const finish = (timedOut, outcome) => {
      if (completed) {
        return;
      }
      completed = true;
      if (timeout !== null) {
        timerOperations.clearTimeout(timeout);
      }
      resolve({ outcome, timedOut });
    };
    timeout = timerOperations.setTimeout(
      () => finish(true),
      timeoutMs,
    );
    void promise.then(
      (outcome) => finish(false, outcome),
      (error) => finish(false, { error, ok: false }),
    );
  });
}

/**
 * @param {{
 *   forceKillTimeoutMs?: number,
 *   killProcess?: (pid: number, signal?: string | number) => boolean,
 *   onDiagnostic?: (diagnostic: SignalLifecycleDiagnostic) => void,
 *   platform?: NodeJS.Platform,
 *   spawnProcess?: (
 *     command: string,
 *     args: string[],
 *     options: import("node:child_process").SpawnOptions,
 *   ) => import("node:child_process").ChildProcess,
 *   treeExitTimeoutMs?: number,
 *   timerOperations?: {
 *     clearTimeout: typeof clearTimeout,
 *     setTimeout: typeof setTimeout,
 *   },
 * }} [options]
 */
export function createSignalLifecycle({
  forceKillTimeoutMs = DEFAULT_FORCE_KILL_TIMEOUT_MS,
  killProcess = process.kill.bind(process),
  onDiagnostic,
  platform = process.platform,
  spawnProcess = spawn,
  treeExitTimeoutMs = DEFAULT_TREE_EXIT_TIMEOUT_MS,
  timerOperations = {
    clearTimeout,
    setTimeout,
  },
} = {}) {
  if (
    !Number.isFinite(forceKillTimeoutMs) ||
    forceKillTimeoutMs < 0
  ) {
    throw new Error("forceKillTimeoutMs must be a non-negative number");
  }
  if (
    !Number.isFinite(treeExitTimeoutMs) ||
    treeExitTimeoutMs < 0
  ) {
    throw new Error("treeExitTimeoutMs must be a non-negative number");
  }

  let activeChild = null;
  let firstSignal = null;
  let forceRequested = false;
  let forceTimer = null;
  let gracefulForwardedChild = null;
  let gracefulTermination = null;
  let forceForwardedChild = null;
  let forceTermination = null;
  let installed = false;
  const diagnostics = [];
  const reportDiagnostic = createDiagnosticReporter(
    diagnostics,
    onDiagnostic,
  );

  const clearForceTimer = () => {
    if (forceTimer !== null) {
      timerOperations.clearTimeout(forceTimer);
      forceTimer = null;
    }
  };

  const forwardToActiveTree = (force) => {
    if (!firstSignal || !activeChild) {
      return;
    }
    if (force) {
      if (forceForwardedChild === activeChild) {
        return;
      }
      forceForwardedChild = activeChild;
      clearForceTimer();
    } else {
      if (gracefulForwardedChild === activeChild) {
        return;
      }
      gracefulForwardedChild = activeChild;
    }

    const termination = terminateProcessTree(activeChild, {
      force,
      killProcess,
      platform,
      reportDiagnostic,
      signal: firstSignal,
      spawnProcess,
    });
    if (force) {
      forceTermination = termination;
    } else {
      gracefulTermination = termination;
    }

    if (!force && forceKillTimeoutMs >= 0) {
      clearForceTimer();
      forceTimer = timerOperations.setTimeout(() => {
        forceTimer = null;
        forceRequested = true;
        forwardToActiveTree(true);
      }, forceKillTimeoutMs);
      forceTimer?.unref?.();
    }
  };

  const recordSignal = (receivedSignal) => {
    if (firstSignal === null) {
      firstSignal = receivedSignal;
      forwardToActiveTree(false);
      return;
    }
    forceRequested = true;
    forwardToActiveTree(true);
  };
  const onSigint = () => recordSignal("SIGINT");
  const onSigterm = () => recordSignal("SIGTERM");

  const detachChild = (child) => {
    if (activeChild === child) {
      clearForceTimer();
      activeChild = null;
      gracefulForwardedChild = null;
      gracefulTermination = null;
      forceForwardedChild = null;
      forceTermination = null;
    }
  };

  const settleChild = async (child) => {
    if (activeChild !== child) {
      return;
    }

    try {
      if (!firstSignal) {
        return;
      }

      const pid = child?.pid;
      if (!Number.isInteger(pid) || pid <= 0) {
        attachDiagnostic(reportDiagnostic, {
          action: "settle",
          error: new Error("managed child has no valid pid"),
          pid: pid ?? null,
        });
        return;
      }

      forceRequested = true;
      clearForceTimer();

      if (platform === "win32") {
        if (!forceTermination && gracefulTermination) {
          const gracefulResult = await waitWithTimeout(
            gracefulTermination,
            treeExitTimeoutMs,
            timerOperations,
          );
          if (
            !gracefulResult.timedOut &&
            gracefulResult.outcome?.ok
          ) {
            return;
          }
          if (gracefulResult.timedOut) {
            attachDiagnostic(reportDiagnostic, {
              action: "graceful-timeout",
              error: new Error("timed out waiting for taskkill"),
              pid,
              target: "process-tree",
            });
          }
        }

        if (!forceTermination) {
          forceForwardedChild = child;
          forceTermination = terminateProcessTree(child, {
            force: true,
            killProcess,
            platform,
            reportDiagnostic,
            signal: firstSignal,
            spawnProcess,
          });
        }
        const forceResult = await waitWithTimeout(
          forceTermination,
          treeExitTimeoutMs,
          timerOperations,
        );
        if (forceResult.timedOut) {
          attachDiagnostic(reportDiagnostic, {
            action: "settle-timeout",
            error: new Error("timed out waiting for taskkill"),
            pid,
            target: "process-tree",
          });
        }
        return;
      }

      let groupState = getProcessGroupState(pid, { killProcess });
      let lastProbeError = groupState.error;
      if (!groupState.alive) {
        return;
      }

      forceForwardedChild = child;
      await terminateProcessTree(child, {
        force: true,
        killProcess,
        platform,
        reportDiagnostic,
        signal: firstSignal,
        spawnProcess,
      });

      const deadline = Date.now() + treeExitTimeoutMs;
      while (true) {
        groupState = getProcessGroupState(pid, { killProcess });
        lastProbeError = groupState.error ?? lastProbeError;
        if (!groupState.alive) {
          return;
        }
        if (Date.now() >= deadline) {
          if (lastProbeError) {
            attachDiagnostic(reportDiagnostic, {
              action: "probe",
              error: lastProbeError,
              pid,
              target: "process-group",
            });
          }
          attachDiagnostic(reportDiagnostic, {
            action: "settle-timeout",
            error: new Error("timed out waiting for process group to exit"),
            pid,
            target: "process-group",
          });
          return;
        }
        await waitForTimer(
          timerOperations,
          Math.min(TREE_EXIT_POLL_INTERVAL_MS, deadline - Date.now()),
        );
      }
    } catch (error) {
      attachDiagnostic(reportDiagnostic, {
        action: "settle",
        error,
        pid: child?.pid ?? null,
        target: "process-tree",
      });
    } finally {
      detachChild(child);
    }
  };

  return {
    get diagnostics() {
      return [...diagnostics];
    },
    get detachedCommands() {
      return platform !== "win32";
    },
    get signal() {
      return firstSignal;
    },
    attachChild(child) {
      if (activeChild && activeChild !== child) {
        throw new Error("a managed child is already active");
      }
      activeChild = child;
      gracefulForwardedChild = null;
      gracefulTermination = null;
      forceForwardedChild = null;
      forceTermination = null;
      if (firstSignal) {
        forwardToActiveTree(forceRequested);
      }
    },
    detachChild,
    install() {
      if (installed) {
        return;
      }
      installed = true;
      process.on("SIGINT", onSigint);
      process.on("SIGTERM", onSigterm);
    },
    remove() {
      if (!installed) {
        return;
      }
      installed = false;
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      clearForceTimer();
    },
    settleChild,
  };
}

function shouldDetachCommand(signalLifecycle) {
  return signalLifecycle
    ? signalLifecycle.detachedCommands
    : process.platform !== "win32";
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {import("node:child_process").SpawnOptions & {
 *   signalLifecycle?: ReturnType<typeof createSignalLifecycle>,
 *   spawnProcess?: typeof spawn,
 * }} [options]
 */
export function runManagedSpawn(
  command,
  args,
  {
    signalLifecycle,
    spawnProcess = spawn,
    ...spawnOptions
  } = {},
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawnProcess(command, args, {
      ...spawnOptions,
      detached: shouldDetachCommand(signalLifecycle),
    });
    signalLifecycle?.attachChild(child);

    const settleLifecycle = async () => {
      if (typeof signalLifecycle?.settleChild === "function") {
        await signalLifecycle.settleChild(child);
      } else {
        signalLifecycle?.detachChild(child);
      }
    };
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        void settleLifecycle().then(
          () =>
            reject(
              attachSignalToError(
                error,
                signalLifecycle?.signal,
              ),
            ),
          () =>
            reject(
              attachSignalToError(
                error,
                signalLifecycle?.signal,
              ),
            ),
        );
      }
    });
    child.once("close", (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      void settleLifecycle().then(() => {
        const interruptedSignal = signalLifecycle?.signal ?? signal;
        resolve({
          exitCode: exitCode ?? (interruptedSignal ? 1 : 0),
          signal: interruptedSignal ?? null,
        });
      }, (error) => {
        reject(
          attachSignalToError(
            error,
            signalLifecycle?.signal,
          ),
        );
      });
    });
  });
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {import("node:child_process").ExecFileOptions & {
 *   execFileProcess?: typeof spawnExecFileProcess,
 *   signalLifecycle?: ReturnType<typeof createSignalLifecycle>,
 * }} [options]
 */
export function runManagedExecFile(
  command,
  args,
  {
    execFileProcess = spawnExecFileProcess,
    signalLifecycle,
    ...execFileOptions
  } = {},
) {
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    const settleLifecycle = async () => {
      if (typeof signalLifecycle?.settleChild === "function") {
        await signalLifecycle.settleChild(child);
      } else {
        signalLifecycle?.detachChild(child);
      }
    };
    const finish = (error, stdout, stderr) => {
      if (settled) {
        return;
      }
      settled = true;
      void settleLifecycle().then(
        () => {
          if (error) {
            reject(
              attachSignalToError(
                error,
                signalLifecycle?.signal,
              ),
            );
          } else {
            resolve({ stdout, stderr });
          }
        },
        (settleError) =>
          reject(
            attachSignalToError(
              error ?? settleError,
              signalLifecycle?.signal,
            ),
          ),
      );
    };

    child = execFileProcess(
      command,
      args,
      {
        ...execFileOptions,
        detached: shouldDetachCommand(signalLifecycle),
      },
      finish,
    );
    signalLifecycle?.attachChild(child);
    child.once("error", (error) => finish(error));
  });
}

function spawnExecFileProcess(
  command,
  args,
  {
    encoding = "utf8",
    maxBuffer = 1024 * 1024,
    ...spawnOptions
  },
  callback,
) {
  const child = spawn(command, args, {
    ...spawnOptions,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutChunks = [];
  const stderrChunks = [];
  let bufferedBytes = 0;
  let bufferError = null;

  const collect = (chunks) => (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(buffer);
    bufferedBytes += buffer.byteLength;
    if (!bufferError && bufferedBytes > maxBuffer) {
      bufferError = new Error(
        `Console command output exceeded maxBuffer (${maxBuffer})`,
      );
      child.kill("SIGKILL");
    }
  };
  child.stdout.on("data", collect(stdoutChunks));
  child.stderr.on("data", collect(stderrChunks));
  child.once("close", (exitCode, signal) => {
    const stdoutBuffer = Buffer.concat(stdoutChunks);
    const stderrBuffer = Buffer.concat(stderrChunks);
    const stdout =
      encoding === "buffer" || encoding === null
        ? stdoutBuffer
        : stdoutBuffer.toString(encoding);
    const stderr =
      encoding === "buffer" || encoding === null
        ? stderrBuffer
        : stderrBuffer.toString(encoding);
    let error = bufferError;

    if (!error && (exitCode !== 0 || signal)) {
      const commandLine = [command, ...args].join(" ");
      error = new Error(
        signal
          ? `Command failed by ${signal}: ${commandLine}\n${stderr}`
          : `Command failed with exit code ${exitCode}: ${commandLine}\n${stderr}`,
      );
      Object.defineProperties(error, {
        code: {
          configurable: true,
          enumerable: true,
          value: exitCode,
        },
        cmd: {
          configurable: true,
          enumerable: true,
          value: commandLine,
        },
        killed: {
          configurable: true,
          enumerable: true,
          value: Boolean(signal),
        },
        signal: {
          configurable: true,
          enumerable: true,
          value: signal,
        },
        stderr: {
          configurable: true,
          enumerable: true,
          value: stderr,
        },
        stdout: {
          configurable: true,
          enumerable: true,
          value: stdout,
        },
      });
    }
    callback(error, stdout, stderr);
  });
  return child;
}

export function throwIfSignalRecorded(signalLifecycle, stage) {
  if (!signalLifecycle?.signal) {
    return;
  }
  const error = new Error(
    `Console operation interrupted by ${signalLifecycle.signal} during ${stage}`,
  );
  Object.defineProperties(error, {
    signal: {
      configurable: true,
      enumerable: true,
      value: signalLifecycle.signal,
    },
    stage: {
      configurable: true,
      enumerable: true,
      value: stage,
    },
  });
  throw error;
}
