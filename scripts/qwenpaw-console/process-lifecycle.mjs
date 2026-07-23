import { spawn } from "node:child_process";

const DEFAULT_FORCE_KILL_TIMEOUT_MS = 5_000;
const DEFAULT_TREE_EXIT_TIMEOUT_MS = 2_000;
const TREE_EXIT_POLL_INTERVAL_MS = 20;
const MANAGED_PROCESS_DISPOSE = Symbol("managedProcessDispose");

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

function createMutableErrorWrapper(error, fallbackMessage) {
  const wrapped = new Error(
    error instanceof Error ? error.message : fallbackMessage,
    { cause: error },
  );
  if (error instanceof Error) {
    wrapped.name = error.name;
  }
  if (!error || typeof error !== "object") {
    return wrapped;
  }

  for (const property of Reflect.ownKeys(error)) {
    if (
      property === "cause" ||
      property === "message" ||
      property === "name" ||
      property === "stack"
    ) {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(error, property);
    if (!descriptor) {
      continue;
    }
    try {
      if ("value" in descriptor) {
        Object.defineProperty(wrapped, property, {
          configurable: true,
          enumerable: descriptor.enumerable,
          value: descriptor.value,
          writable: true,
        });
      } else {
        Object.defineProperty(wrapped, property, {
          configurable: true,
          enumerable: descriptor.enumerable,
          get: descriptor.get,
          set: descriptor.set,
        });
      }
    } catch {
      // Individual diagnostic fields must not prevent preserving the error.
    }
  }
  return wrapped;
}

export function attachErrorDetails(
  error,
  details,
  fallbackMessage = "Console operation failed",
) {
  let target =
    error && typeof error === "object"
      ? error
      : createMutableErrorWrapper(error, fallbackMessage);
  const attach = (candidate) => {
    for (const property of Reflect.ownKeys(details)) {
      Object.defineProperty(candidate, property, {
        configurable: true,
        enumerable: true,
        value: Reflect.get(details, property),
        writable: true,
      });
    }
    return candidate;
  };

  try {
    return attach(target);
  } catch {
    target = createMutableErrorWrapper(error, fallbackMessage);
    return attach(target);
  }
}

function readErrorDetail(error, property) {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  try {
    return Reflect.get(error, property);
  } catch {
    return undefined;
  }
}

export function appendCleanupError(error, cleanupEntry) {
  const existingCleanupErrors = readErrorDetail(
    error,
    "cleanupErrors",
  );
  const cleanupErrors = Array.isArray(existingCleanupErrors)
    ? [...existingCleanupErrors, cleanupEntry]
    : [cleanupEntry];
  const existingCleanupError = readErrorDetail(error, "cleanupError");
  return attachErrorDetails(error, {
    cleanupError:
      existingCleanupError === undefined
        ? cleanupEntry.error
        : existingCleanupError,
    cleanupErrors,
  });
}

export function formatCleanupErrorDetails(error) {
  const cleanupErrors = readErrorDetail(error, "cleanupErrors");
  if (!Array.isArray(cleanupErrors)) {
    return [];
  }
  return cleanupErrors.map(
    (cleanupEntry) =>
      `Console cleanup failed at ${cleanupEntry.stage} (${cleanupEntry.path}): ${
        cleanupEntry.error instanceof Error
          ? cleanupEntry.error.message
          : "unknown cleanup error"
      }`,
  );
}

export function attachSignalToError(error, signal) {
  if (!signal) {
    return error;
  }

  return attachErrorDetails(
    error,
    { signal },
    "Console operation interrupted",
  );
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
    return {
      abort() {},
      completion: Promise.resolve({ error, ok: false }),
      helper: null,
      settled: true,
      suppressDiagnostics() {},
    };
  }

  if (platform === "win32") {
    const { command, args } = getWindowsTreeKillCommand(pid, { force });
    let helper = null;
    let settled = false;
    let abortTermination = () => {};
    let suppressTerminationDiagnostics = () => {};
    const completion = new Promise((resolve) => {
      let diagnosticsSuppressed = false;
      let onClose;
      let onError;
      const removeHelperListeners = () => {
        if (!helper) {
          return;
        }
        if (onError) {
          helper.off?.("error", onError);
        }
        if (onClose) {
          helper.off?.("close", onClose);
        }
      };
      const settle = (outcome) => {
        if (settled) {
          return;
        }
        settled = true;
        removeHelperListeners();
        resolve(outcome);
      };
      const finish = ({
        error,
        exitCode,
        signal: exitSignal,
      } = {}) => {
        if (settled) {
          return;
        }
        let outcome;
        if (error) {
          if (!diagnosticsSuppressed) {
            attachDiagnostic(reportDiagnostic, {
              action: force ? "force" : "graceful",
              command: [command, ...args].join(" "),
              error,
              pid,
            });
          }
          outcome = { error, ok: false };
        } else if (
          (typeof exitCode === "number" && exitCode !== 0) ||
          exitSignal
        ) {
          if (!diagnosticsSuppressed) {
            attachDiagnostic(reportDiagnostic, {
              action: force ? "force" : "graceful",
              command: [command, ...args].join(" "),
              exitCode: exitCode ?? null,
              pid,
              signal: exitSignal ?? null,
            });
          }
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
        settle(outcome);
      };
      abortTermination = () => {
        settle({ aborted: true, ok: false });
      };
      suppressTerminationDiagnostics = () => {
        diagnosticsSuppressed = true;
      };

      try {
        helper = spawnProcess(command, args, {
          stdio: "ignore",
          windowsHide: true,
        });
        onError = (error) => {
          finish({
            error,
          });
        };
        onClose = (exitCode, exitSignal) => {
          finish({ exitCode, signal: exitSignal });
        };
        helper.once("error", onError);
        helper.once("close", onClose);
      } catch (error) {
        finish({
          error,
        });
      }
    });
    return {
      abort: () => abortTermination(),
      completion,
      get helper() {
        return helper;
      },
      get settled() {
        return settled;
      },
      suppressDiagnostics: () => suppressTerminationDiagnostics(),
    };
  }

  const forwardedSignal = force ? "SIGKILL" : signal;
  try {
    killProcess(-pid, forwardedSignal);
    return {
      abort() {},
      completion: Promise.resolve({ ok: true }),
      helper: null,
      settled: true,
      suppressDiagnostics() {},
    };
  } catch (groupError) {
    attachDiagnostic(reportDiagnostic, {
      action: force ? "force" : "graceful",
      error: groupError,
      pid,
      target: "process-group",
    });
    try {
      killProcess(pid, forwardedSignal);
      return {
        abort() {},
        completion: Promise.resolve({
          error: groupError,
          fallback: "direct-child",
          ok: false,
        }),
        helper: null,
        settled: true,
        suppressDiagnostics() {},
      };
    } catch (childError) {
      attachDiagnostic(reportDiagnostic, {
        action: force ? "force" : "graceful",
        error: childError,
        pid,
        target: "direct-child-fallback",
      });
      return {
        abort() {},
        completion: Promise.resolve({
          error: childError,
          groupError,
          ok: false,
        }),
        helper: null,
        settled: true,
        suppressDiagnostics() {},
      };
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

async function stopTerminationHelper(
  termination,
  {
    action,
    pid,
    reportDiagnostic,
    timeoutMs,
    timerOperations,
  },
) {
  const helper = termination?.helper;
  if (termination?.settled) {
    return;
  }
  if (!helper) {
    termination?.abort?.();
    return;
  }

  termination.suppressDiagnostics?.();
  const stopHelper = (signal) => {
    try {
      const killed = helper.kill?.(signal);
      if (killed === false || typeof helper.kill !== "function") {
        attachDiagnostic(reportDiagnostic, {
          action: `${action}-helper-kill`,
          error: new Error("taskkill helper did not accept termination"),
          pid,
          target: "taskkill-helper",
        });
      }
    } catch (error) {
      attachDiagnostic(reportDiagnostic, {
        action: `${action}-helper-kill`,
        error,
        pid,
        target: "taskkill-helper",
      });
    }
  };

  stopHelper("SIGTERM");
  let stopped = await waitWithTimeout(
    termination.completion,
    timeoutMs,
    timerOperations,
  );
  if (!stopped.timedOut) {
    return;
  }

  stopHelper("SIGKILL");
  stopped = await waitWithTimeout(
    termination.completion,
    timeoutMs,
    timerOperations,
  );
  if (stopped.timedOut) {
    termination.abort?.();
    helper.unref?.();
  }
}

function abortTerminationHelper(termination) {
  if (!termination || termination.settled) {
    return;
  }
  termination.suppressDiagnostics?.();
  try {
    termination.helper?.kill?.("SIGKILL");
  } catch {
    // Direct detach must remain synchronous and best-effort.
  }
  termination.abort?.();
  termination.helper?.unref?.();
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
  let internalForceForwardedChild = null;
  let forceForwardedChild = null;
  let forceTermination = null;
  let closedChild = null;
  let watchedChild = null;
  let terminationWatchdogChild = null;
  let terminationWatchdogPromise = null;
  let terminationFailure = null;
  let installed = false;
  const childResolutionWaiters = new Set();
  const terminationFailureListeners = new Set();
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

  const resolveChildWaiters = (child, outcome) => {
    for (const waiter of [...childResolutionWaiters]) {
      if (waiter.child === child) {
        waiter.finish(outcome);
      }
    }
  };

  const waitForChildResolution = (child, timeoutMs) => {
    if (closedChild === child) {
      return Promise.resolve({ closed: true });
    }
    if (activeChild !== child) {
      return Promise.resolve({ detached: true });
    }

    return new Promise((resolve) => {
      let timeout = null;
      let settled = false;
      const waiter = {
        child,
        finish(outcome) {
          if (settled) {
            return;
          }
          settled = true;
          childResolutionWaiters.delete(waiter);
          if (timeout !== null) {
            timerOperations.clearTimeout(timeout);
          }
          resolve(outcome);
        },
      };
      childResolutionWaiters.add(waiter);
      timeout = timerOperations.setTimeout(
        () => waiter.finish({ timedOut: true }),
        timeoutMs,
      );
      timeout?.unref?.();
    });
  };

  const markChildClosed = (child) => {
    if (activeChild !== child) {
      return;
    }
    closedChild = child;
    resolveChildWaiters(child, { closed: true });
  };

  const beginForceTermination = (child) => {
    if (activeChild !== child) {
      return null;
    }
    if (
      forceForwardedChild === child &&
      forceTermination
    ) {
      return forceTermination;
    }

    forceForwardedChild = child;
    forceRequested = true;
    clearForceTimer();
    forceTermination = terminateProcessTree(child, {
      force: true,
      killProcess,
      platform,
      reportDiagnostic,
      signal: firstSignal,
      spawnProcess,
    });
    return forceTermination;
  };

  const notifyTerminationFailure = (child, error) => {
    if (
      activeChild !== child ||
      terminationFailure
    ) {
      return;
    }
    terminationFailure = error;
    attachDiagnostic(reportDiagnostic, {
      action: "runner-timeout",
      error,
      pid: child?.pid ?? null,
      target: "process-tree",
    });
    for (const listener of [...terminationFailureListeners]) {
      try {
        listener(error);
      } catch {
        // Runner failure listeners must not interrupt lifecycle cleanup.
      }
    }
    detachChild(child);
  };

  const createTerminationTimeoutError = (child, reason) =>
    attachErrorDetails(
      new Error(
        `Console managed process ${child?.pid ?? "unknown"} did not terminate: ${reason}`,
      ),
      {
        code: "ERR_CONSOLE_PROCESS_TERMINATION_TIMEOUT",
      },
    );

  const startWindowsWatchdog = (child) => {
    if (
      platform !== "win32" ||
      watchedChild !== child ||
      activeChild !== child ||
      terminationWatchdogChild === child
    ) {
      return terminationWatchdogPromise;
    }
    if (!gracefulTermination && !forceTermination) {
      return null;
    }

    terminationWatchdogChild = child;
    terminationWatchdogPromise = (async () => {
      const pid = child?.pid;
      try {
        if (gracefulTermination) {
          const gracefulResult = await waitWithTimeout(
            gracefulTermination.completion,
            treeExitTimeoutMs,
            timerOperations,
          );
          if (gracefulResult.timedOut) {
            attachDiagnostic(reportDiagnostic, {
              action: "graceful-timeout",
              error: new Error("timed out waiting for taskkill"),
              pid: pid ?? null,
              target: "process-tree",
            });
            await stopTerminationHelper(gracefulTermination, {
              action: "graceful",
              pid: pid ?? null,
              reportDiagnostic,
              timeoutMs: treeExitTimeoutMs,
              timerOperations,
            });
          }
          if (activeChild !== child || closedChild === child) {
            return;
          }

          if (
            !gracefulResult.timedOut &&
            gracefulResult.outcome?.ok &&
            !forceTermination
          ) {
            const childResult = await waitForChildResolution(
              child,
              treeExitTimeoutMs,
            );
            if (childResult.closed || childResult.detached) {
              return;
            }
          }
        }

        if (activeChild !== child || closedChild === child) {
          return;
        }
        const activeForceTermination =
          forceTermination ?? beginForceTermination(child);
        if (!activeForceTermination) {
          return;
        }
        const forceResult = await waitWithTimeout(
          activeForceTermination.completion,
          treeExitTimeoutMs,
          timerOperations,
        );
        if (forceResult.timedOut) {
          attachDiagnostic(reportDiagnostic, {
            action: "settle-timeout",
            error: new Error("timed out waiting for taskkill"),
            pid: pid ?? null,
            target: "process-tree",
          });
          await stopTerminationHelper(activeForceTermination, {
            action: "force",
            pid: pid ?? null,
            reportDiagnostic,
            timeoutMs: treeExitTimeoutMs,
            timerOperations,
          });
        }
        if (activeChild !== child || closedChild === child) {
          return;
        }

        if (
          !forceResult.timedOut &&
          forceResult.outcome?.ok
        ) {
          const childResult = await waitForChildResolution(
            child,
            treeExitTimeoutMs,
          );
          if (childResult.closed || childResult.detached) {
            return;
          }
        }

        let directKillAccepted = false;
        try {
          if (typeof child?.kill !== "function") {
            throw new Error("managed child does not expose kill()");
          }
          directKillAccepted = child.kill("SIGKILL") !== false;
          if (!directKillAccepted) {
            throw new Error(
              "managed child did not accept direct SIGKILL",
            );
          }
        } catch (error) {
          attachDiagnostic(reportDiagnostic, {
            action: "direct-child-fallback",
            error,
            pid: pid ?? null,
            target: "direct-child",
          });
        }

        if (directKillAccepted) {
          const childResult = await waitForChildResolution(
            child,
            treeExitTimeoutMs,
          );
          if (childResult.closed || childResult.detached) {
            return;
          }
        }
        notifyTerminationFailure(
          child,
          createTerminationTimeoutError(
            child,
            directKillAccepted
              ? "direct SIGKILL was accepted but the child did not close"
              : "taskkill and direct SIGKILL both failed",
          ),
        );
      } catch (error) {
        attachDiagnostic(reportDiagnostic, {
          action: "watchdog",
          error,
          pid: pid ?? null,
          target: "process-tree",
        });
        notifyTerminationFailure(
          child,
          attachErrorDetails(
            error,
            {
              code: "ERR_CONSOLE_PROCESS_TERMINATION_TIMEOUT",
            },
            "Console process termination watchdog failed",
          ),
        );
      }
    })();
    return terminationWatchdogPromise;
  };

  const waitForPosixTreeExit = async (child, pid, timeoutMs) => {
    if (!Number.isInteger(pid) || pid <= 0) {
      return {
        exited: false,
        invalidPid: true,
        lastProbeError: null,
      };
    }

    const deadline = Date.now() + timeoutMs;
    let lastProbeError = null;
    while (activeChild === child) {
      const groupState = getProcessGroupState(pid, { killProcess });
      lastProbeError = groupState.error ?? lastProbeError;
      if (closedChild === child && !groupState.alive) {
        return {
          exited: true,
          invalidPid: false,
          lastProbeError,
        };
      }
      if (Date.now() >= deadline) {
        return {
          exited: false,
          invalidPid: false,
          lastProbeError,
        };
      }
      await waitForTimer(
        timerOperations,
        Math.min(TREE_EXIT_POLL_INTERVAL_MS, deadline - Date.now()),
      );
    }

    return {
      detached: true,
      exited: false,
      invalidPid: false,
      lastProbeError,
    };
  };

  const startPosixWatchdog = (child) => {
    if (
      platform === "win32" ||
      watchedChild !== child ||
      activeChild !== child ||
      terminationWatchdogChild === child
    ) {
      return terminationWatchdogPromise;
    }
    if (!gracefulTermination && !forceTermination) {
      return null;
    }

    terminationWatchdogChild = child;
    terminationWatchdogPromise = (async () => {
      const pid = child?.pid;
      try {
        if (gracefulTermination) {
          const gracefulOutcome = await gracefulTermination.completion;
          if (activeChild !== child) {
            return;
          }
          if (gracefulOutcome?.ok) {
            const gracefulExit = await waitForPosixTreeExit(
              child,
              pid,
              forceKillTimeoutMs,
            );
            if (gracefulExit.exited || gracefulExit.detached) {
              return;
            }
          }
        }

        if (activeChild !== child) {
          return;
        }
        const activeForceTermination =
          forceTermination ?? beginForceTermination(child);
        await activeForceTermination?.completion;
        if (activeChild !== child) {
          return;
        }

        let treeExit = await waitForPosixTreeExit(
          child,
          pid,
          treeExitTimeoutMs,
        );
        if (treeExit.exited || treeExit.detached) {
          return;
        }

        let directKillAccepted = false;
        if (closedChild !== child) {
          try {
            if (typeof child?.kill !== "function") {
              throw new Error("managed child does not expose kill()");
            }
            directKillAccepted = child.kill("SIGKILL") !== false;
            if (!directKillAccepted) {
              throw new Error(
                "managed child did not accept direct SIGKILL",
              );
            }
          } catch (error) {
            attachDiagnostic(reportDiagnostic, {
              action: "direct-child-fallback",
              error,
              pid: pid ?? null,
              target: "direct-child",
            });
          }
        }

        if (directKillAccepted) {
          treeExit = await waitForPosixTreeExit(
            child,
            pid,
            treeExitTimeoutMs,
          );
          if (treeExit.exited || treeExit.detached) {
            return;
          }
        }

        if (treeExit.lastProbeError) {
          attachDiagnostic(reportDiagnostic, {
            action: "probe",
            error: treeExit.lastProbeError,
            pid: pid ?? null,
            target: "process-group",
          });
        }
        attachDiagnostic(reportDiagnostic, {
          action: "settle-timeout",
          error: new Error(
            treeExit.invalidPid
              ? "managed child has no valid pid"
              : "timed out waiting for process group and child to exit",
          ),
          pid: pid ?? null,
          target: treeExit.invalidPid
            ? "direct-child"
            : "process-group",
        });
        notifyTerminationFailure(
          child,
          createTerminationTimeoutError(
            child,
            treeExit.invalidPid
              ? "managed child has no valid pid"
              : closedChild === child
                ? "the child closed but its process group did not exit"
                : directKillAccepted
                  ? "direct SIGKILL was accepted but the process tree did not exit"
                  : "process-group and direct SIGKILL both failed",
          ),
        );
      } catch (error) {
        attachDiagnostic(reportDiagnostic, {
          action: "watchdog",
          error,
          pid: pid ?? null,
          target: "process-tree",
        });
        notifyTerminationFailure(
          child,
          attachErrorDetails(
            error,
            {
              code: "ERR_CONSOLE_PROCESS_TERMINATION_TIMEOUT",
            },
            "Console process termination watchdog failed",
          ),
        );
      }
    })();
    return terminationWatchdogPromise;
  };

  const startTerminationWatchdog = (child) =>
    platform === "win32"
      ? startWindowsWatchdog(child)
      : startPosixWatchdog(child);

  const forwardToActiveTree = (force) => {
    if (!firstSignal || !activeChild) {
      return;
    }
    if (force) {
      beginForceTermination(activeChild);
      startTerminationWatchdog(activeChild);
      return;
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
    startTerminationWatchdog(activeChild);

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
      abortTerminationHelper(gracefulTermination);
      if (forceTermination !== gracefulTermination) {
        abortTerminationHelper(forceTermination);
      }
      resolveChildWaiters(child, { detached: true });
      activeChild = null;
      gracefulForwardedChild = null;
      gracefulTermination = null;
      internalForceForwardedChild = null;
      forceForwardedChild = null;
      forceTermination = null;
      closedChild = null;
      watchedChild = null;
      terminationWatchdogChild = null;
      terminationWatchdogPromise = null;
      terminationFailureListeners.clear();
    }
  };

  const settleChild = async (child) => {
    if (activeChild !== child) {
      return;
    }
    markChildClosed(child);
    await Promise.resolve();

    const watchdogPromise =
      terminationWatchdogChild === child
        ? terminationWatchdogPromise
        : null;
    if (watchdogPromise) {
      await watchdogPromise;
      const failure = terminationFailure;
      detachChild(child);
      if (failure) {
        throw failure;
      }
      return;
    }

    try {
      if (
        !firstSignal &&
        internalForceForwardedChild !== child
      ) {
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
        if (gracefulTermination) {
          const gracefulResult = await waitWithTimeout(
            gracefulTermination.completion,
            treeExitTimeoutMs,
            timerOperations,
          );
          if (
            !gracefulResult.timedOut &&
            gracefulResult.outcome?.ok &&
            !forceTermination
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
            await stopTerminationHelper(gracefulTermination, {
              action: "graceful",
              pid,
              reportDiagnostic,
              timeoutMs: treeExitTimeoutMs,
              timerOperations,
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
          forceTermination.completion,
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
          await stopTerminationHelper(forceTermination, {
            action: "force",
            pid,
            reportDiagnostic,
            timeoutMs: treeExitTimeoutMs,
            timerOperations,
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
      }).completion;

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
      internalForceForwardedChild = null;
      forceForwardedChild = null;
      forceTermination = null;
      closedChild = null;
      watchedChild = null;
      terminationWatchdogChild = null;
      terminationWatchdogPromise = null;
      terminationFailure = null;
      terminationFailureListeners.clear();
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
    forceTerminateChild(child) {
      if (activeChild !== child) {
        throw new Error("cannot terminate an unmanaged child");
      }
      if (internalForceForwardedChild === child) {
        return forceTermination?.completion;
      }
      internalForceForwardedChild = child;
      forceForwardedChild = child;
      clearForceTimer();
      forceTermination = terminateProcessTree(child, {
        force: true,
        killProcess,
        platform,
        reportDiagnostic,
        signal: firstSignal,
        spawnProcess,
      });
      startTerminationWatchdog(child);
      return forceTermination.completion;
    },
    watchChildTermination(child, listener) {
      if (activeChild !== child) {
        throw new Error("cannot watch an unmanaged child");
      }
      if (typeof listener !== "function") {
        throw new Error("termination failure listener must be a function");
      }
      watchedChild = child;
      terminationFailureListeners.add(listener);
      if (terminationFailure) {
        queueMicrotask(() => listener(terminationFailure));
      } else {
        startTerminationWatchdog(child);
      }
      return () => {
        terminationFailureListeners.delete(listener);
      };
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
    let stopWatchingTermination = () => {};
    let onChildClose;
    let onChildError;
    const child = spawnProcess(command, args, {
      ...spawnOptions,
      detached: shouldDetachCommand(signalLifecycle),
    });
    const removeChildListeners = () => {
      if (onChildError) {
        child.off?.("error", onChildError);
      }
      if (onChildClose) {
        child.off?.("close", onChildClose);
      }
    };
    signalLifecycle?.attachChild(child);
    stopWatchingTermination =
      signalLifecycle?.watchChildTermination?.(
        child,
        (terminationError) => {
          if (settled) {
            return;
          }
          settled = true;
          stopWatchingTermination();
          removeChildListeners();
          reject(
            attachSignalToError(
              terminationError,
              signalLifecycle?.signal,
            ),
          );
        },
      ) ?? stopWatchingTermination;

    const settleLifecycle = async () => {
      if (typeof signalLifecycle?.settleChild === "function") {
        await signalLifecycle.settleChild(child);
      } else {
        signalLifecycle?.detachChild(child);
      }
    };
    onChildError = (error) => {
      if (!settled) {
        settled = true;
        stopWatchingTermination();
        removeChildListeners();
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
    };
    onChildClose = (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      stopWatchingTermination();
      removeChildListeners();
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
    };
    child.once("error", onChildError);
    child.once("close", onChildClose);
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
  const managedLifecycle =
    signalLifecycle ?? createSignalLifecycle();
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let pendingPrimaryError = null;
    let stopWatchingTermination = () => {};
    let onChildError;
    const removeChildListeners = () => {
      if (onChildError) {
        child?.off?.("error", onChildError);
      }
      child?.[MANAGED_PROCESS_DISPOSE]?.();
    };
    const settleLifecycle = async () => {
      if (typeof managedLifecycle?.settleChild === "function") {
        await managedLifecycle.settleChild(child);
      } else {
        managedLifecycle?.detachChild(child);
      }
    };
    const finish = (error, stdout, stderr) => {
      if (settled) {
        return;
      }
      settled = true;
      stopWatchingTermination();
      removeChildListeners();
      void settleLifecycle().then(
        () => {
          if (error) {
            reject(
              attachSignalToError(
                error,
                managedLifecycle?.signal,
              ),
            );
          } else {
            resolve({ stdout, stderr });
          }
        },
        (settleError) => {
          const primaryError = pendingPrimaryError
            ? attachErrorDetails(pendingPrimaryError, {
                terminationError: settleError,
              })
            : error ?? settleError;
          reject(
            attachSignalToError(
              primaryError,
              managedLifecycle?.signal,
            ),
          );
        },
      );
    };

    child = execFileProcess(
      command,
      args,
      {
        ...execFileOptions,
        detached: shouldDetachCommand(managedLifecycle),
        onMaxBuffer: (overflowedChild, overflowError) => {
          pendingPrimaryError = overflowError;
          return managedLifecycle.forceTerminateChild(
            overflowedChild,
          );
        },
      },
      finish,
    );
    managedLifecycle.attachChild(child);
    stopWatchingTermination =
      managedLifecycle.watchChildTermination?.(
        child,
        (terminationError) => {
          if (settled) {
            return;
          }
          settled = true;
          stopWatchingTermination();
          removeChildListeners();
          managedLifecycle.detachChild(child);
          const primaryError = pendingPrimaryError
            ? attachErrorDetails(pendingPrimaryError, {
                terminationError,
              })
            : terminationError;
          reject(
            attachSignalToError(
              primaryError,
              managedLifecycle.signal,
            ),
          );
        },
      ) ?? stopWatchingTermination;
    onChildError = (error) => finish(error);
    child.once("error", onChildError);
  });
}

function spawnExecFileProcess(
  command,
  args,
  {
    encoding = "utf8",
    maxBuffer = 1024 * 1024,
    onMaxBuffer,
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
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let bufferError = null;
  const commandLine = [command, ...args].join(" ");
  const decodeChunks = (chunks) => {
    const buffer = Buffer.concat(chunks);
    return encoding === "buffer" || encoding === null
      ? buffer
      : buffer.toString(encoding);
  };

  const collect = (streamName, chunks) => (chunk) => {
    if (bufferError) {
      return;
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const bufferedBytes =
      streamName === "stdout" ? stdoutBytes : stderrBytes;
    const remainingBytes = Math.max(0, maxBuffer - bufferedBytes);
    if (remainingBytes > 0) {
      chunks.push(buffer.subarray(0, remainingBytes));
    }
    const nextBufferedBytes = bufferedBytes + buffer.byteLength;
    if (streamName === "stdout") {
      stdoutBytes = Math.min(nextBufferedBytes, maxBuffer);
    } else {
      stderrBytes = Math.min(nextBufferedBytes, maxBuffer);
    }
    if (nextBufferedBytes > maxBuffer) {
      bufferError = new Error(
        `${streamName} maxBuffer length exceeded (${maxBuffer})`,
      );
      Object.defineProperty(bufferError, "code", {
        configurable: true,
        enumerable: true,
        value: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      });
      Object.defineProperties(bufferError, {
        cmd: {
          configurable: true,
          enumerable: true,
          value: commandLine,
        },
        killed: {
          configurable: true,
          enumerable: true,
          value: true,
        },
        signal: {
          configurable: true,
          enumerable: true,
          value: null,
        },
        stderr: {
          configurable: true,
          enumerable: true,
          value: decodeChunks(stderrChunks),
        },
        stdout: {
          configurable: true,
          enumerable: true,
          value: decodeChunks(stdoutChunks),
        },
      });
      try {
        onMaxBuffer?.(child, bufferError);
      } catch {
        child.kill("SIGKILL");
      }
    }
  };
  const onStdoutData = collect("stdout", stdoutChunks);
  const onStderrData = collect("stderr", stderrChunks);
  let disposed = false;
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    child.stdout?.off?.("data", onStdoutData);
    child.stderr?.off?.("data", onStderrData);
    child.off?.("close", onClose);
  };
  const onClose = (exitCode, signal) => {
    dispose();
    const stdout = decodeChunks(stdoutChunks);
    const stderr = decodeChunks(stderrChunks);
    let error = bufferError;

    if (!error && (exitCode !== 0 || signal)) {
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
    if (bufferError && error === bufferError) {
      Object.defineProperties(error, {
        cmd: {
          configurable: true,
          enumerable: true,
          value: commandLine,
        },
        killed: {
          configurable: true,
          enumerable: true,
          value: true,
        },
        signal: {
          configurable: true,
          enumerable: true,
          value: null,
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
  };
  Object.defineProperty(child, MANAGED_PROCESS_DISPOSE, {
    configurable: true,
    value: dispose,
  });
  child.stdout.on("data", onStdoutData);
  child.stderr.on("data", onStderrData);
  child.once("close", onClose);
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
