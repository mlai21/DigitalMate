export const TASK_COMPLETION_RECOVERY_TIMEOUT_MS = 5_000;

export class TaskCompletionAmbiguousError extends Error {
  readonly code = "task_completion_ambiguous";

  constructor() {
    super("task_completion_ambiguous");
    this.name = "TaskCompletionAmbiguousError";
  }
}

export class TaskCompletionNotCommittedError extends Error {
  readonly code = "task_completion_not_committed";

  constructor() {
    super("task_completion_not_committed");
    this.name = "TaskCompletionNotCommittedError";
  }
}

export function isTaskCompletionAmbiguousError(
  error: unknown,
): error is TaskCompletionAmbiguousError {
  return error instanceof TaskCompletionAmbiguousError
    || (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "task_completion_ambiguous"
    );
}
