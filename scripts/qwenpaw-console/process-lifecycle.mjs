import { execFile, spawn } from "node:child_process";

const DEFAULT_FORCE_KILL_TIMEOUT_MS = 5_000;
const DEFAULT_TREE_EXIT_TIMEOUT_MS = 2_000;
const TREE_EXIT_POLL_INTERVAL_MS = 20;

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

function attachDiagnostic(diagnostics, diagnostic) {
  diagnostics.push({
    ...diagnostic,
    timestamp: Date.now(),
  });
}

function terminateProcessTree(
  child,
  {
    diagnostics,
    force,
    killProcess,
    platform,
    signal,
    spawnProcess,
  },
) {
  const pid = child?.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    attachDiagnostic(diagnostics, {
      action: force ? "force" : "graceful",
      error: new Error("managed child has no valid pid"),
      pid: pid ?? null,
    });
    return Promise.resolve();
  }

  if (platform === "win32") {
    const { command, args } = getWindowsTreeKillCommand(pid, { force });
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };

      try {
        const killer = spawnProcess(command, args, {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.once("error", (error) => {
          attachDiagnostic(diagnostics, {
            action: force ? "force" : "graceful",
            command: [command, ...args].join(" "),
            error,
            pid,
          });
          finish();
        });
        killer.once("close", finish);
      } catch (error) {
        attachDiagnostic(diagnostics, {
          action: force ? "force" : "graceful",
          command: [command, ...args].join(" "),
          error,
          pid,
        });
        finish();
      }
    });
  }

  const forwardedSignal = force ? "SIGKILL" : signal;
  try {
    killProcess(-pid, forwardedSignal);
  } catch (groupError) {
    attachDiagnostic(diagnostics, {
      action: force ? "force" : "graceful",
      error: groupError,
      pid,
      target: "process-group",
    });
    try {
      killProcess(pid, forwardedSignal);
    } catch (childError) {
      attachDiagnostic(diagnostics, {
        action: force ? "force" : "graceful",
        error: childError,
        pid,
        target: "direct-child-fallback",
      });
    }
  }
  return Promise.resolve();
}

function isMissingProcessError(error) {
  return error?.code === "ESRCH";
}

function isProcessGroupAlive(pid, { diagnostics, killProcess }) {
  try {
    killProcess(-pid, 0);
    return true;
  } catch (error) {
    if (isMissingProcessError(error)) {
      return false;
    }
    attachDiagnostic(diagnostics, {
      action: "probe",
      error,
      pid,
      target: "process-group",
    });
    return true;
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
    const finish = (timedOut) => {
      if (completed) {
        return;
      }
      completed = true;
      if (timeout !== null) {
        timerOperations.clearTimeout(timeout);
      }
      resolve(timedOut);
    };
    timeout = timerOperations.setTimeout(
      () => finish(true),
      timeoutMs,
    );
    void promise.then(
      () => finish(false),
      () => finish(false),
    );
  });
}

export function createSignalLifecycle({
  forceKillTimeoutMs = DEFAULT_FORCE_KILL_TIMEOUT_MS,
  killProcess = process.kill.bind(process),
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
  let forceForwardedChild = null;
  let installed = false;
  const diagnostics = [];

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

    void terminateProcessTree(activeChild, {
      diagnostics,
      force,
      killProcess,
      platform,
      signal: firstSignal,
      spawnProcess,
    });

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
      forceForwardedChild = null;
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
        attachDiagnostic(diagnostics, {
          action: "settle",
          error: new Error("managed child has no valid pid"),
          pid: pid ?? null,
        });
        return;
      }

      forceRequested = true;
      clearForceTimer();

      if (platform === "win32") {
        forceForwardedChild = child;
        const timeoutReached = await waitWithTimeout(
          terminateProcessTree(child, {
            diagnostics,
            force: true,
            killProcess,
            platform,
            signal: firstSignal,
            spawnProcess,
          }),
          treeExitTimeoutMs,
          timerOperations,
        );
        if (timeoutReached) {
          attachDiagnostic(diagnostics, {
            action: "settle-timeout",
            error: new Error("timed out waiting for taskkill"),
            pid,
            target: "process-tree",
          });
        }
        return;
      }

      if (!isProcessGroupAlive(pid, { diagnostics, killProcess })) {
        return;
      }

      forceForwardedChild = child;
      await terminateProcessTree(child, {
        diagnostics,
        force: true,
        killProcess,
        platform,
        signal: firstSignal,
        spawnProcess,
      });

      const deadline = Date.now() + treeExitTimeoutMs;
      while (isProcessGroupAlive(pid, { diagnostics, killProcess })) {
        if (Date.now() >= deadline) {
          attachDiagnostic(diagnostics, {
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
      attachDiagnostic(diagnostics, {
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
      forceForwardedChild = null;
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
          () => reject(error),
          () => reject(error),
        );
      }
    });
    child.once("close", (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      void settleLifecycle().then(() => {
        const interruptedSignal = signal ?? signalLifecycle?.signal;
        resolve({
          exitCode: exitCode ?? (interruptedSignal ? 1 : 0),
          signal: interruptedSignal ?? null,
        });
      }, (error) => {
        reject(error);
      });
    });
  });
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {import("node:child_process").ExecFileOptions & {
 *   execFileProcess?: typeof execFile,
 *   signalLifecycle?: ReturnType<typeof createSignalLifecycle>,
 * }} [options]
 */
export function runManagedExecFile(
  command,
  args,
  {
    execFileProcess = execFile,
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
            reject(error);
          } else {
            resolve({ stdout, stderr });
          }
        },
        (settleError) => reject(error ?? settleError),
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
