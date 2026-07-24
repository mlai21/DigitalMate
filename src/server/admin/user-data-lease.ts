import type {
  UserDataLease,
  UserDataRequestFence,
} from "@/server/db/repositories";
import { createRepositories } from "@/server/db/repositories";

type UserDataLeaseRepositories = {
  userDataMutations: {
    beginRequest(userId: string): Promise<UserDataRequestFence>;
    acquireSharedLease(
      fence: UserDataRequestFence,
      options?: { signal?: AbortSignal },
    ): Promise<UserDataLease>;
  };
};

export const USER_DATA_WORK_TIMEOUT_MS = 120_000;

export type FencedUserDataLease = UserDataLease & {
  requestFence: UserDataRequestFence;
};

export async function acquireUserDataLease(
  repositories: UserDataLeaseRepositories,
  userId: string,
  options: { signal?: AbortSignal } = {},
): Promise<FencedUserDataLease> {
  const fence = await repositories.userDataMutations.beginRequest(userId);
  options.signal?.throwIfAborted();
  const lease = await repositories.userDataMutations.acquireSharedLease(fence, {
    signal: options.signal,
  });
  return {
    ...lease,
    requestFence: { userId: lease.userId, epoch: lease.epoch },
  };
}

export async function withUserDataLease<T>(
  repositories: UserDataLeaseRepositories,
  userId: string,
  work: (lease: UserDataLease, signal: AbortSignal) => Promise<T>,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    timeoutCode?: string;
  } = {},
): Promise<T> {
  const lifecycle = createBoundedAbortLifecycle({
    sourceSignal: options.signal,
    timeoutMs: options.timeoutMs ?? USER_DATA_WORK_TIMEOUT_MS,
    timeoutCode: options.timeoutCode ?? "user_data_work_timeout",
  });
  let lease: FencedUserDataLease | undefined;
  try {
    lease = await acquireUserDataLease(repositories, userId, {
      signal: lifecycle.signal,
    });
    lifecycle.signal.throwIfAborted();
    const result = await work(lease, lifecycle.signal);
    lifecycle.signal.throwIfAborted();
    return result;
  } finally {
    if (lease) await lease.release();
    lifecycle.dispose();
  }
}

export async function withUserDataFence<T>(
  repositories: UserDataLeaseRepositories,
  fence: UserDataRequestFence,
  work: (lease: UserDataLease, signal: AbortSignal) => Promise<T>,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    timeoutCode?: string;
  } = {},
): Promise<T> {
  const lifecycle = createBoundedAbortLifecycle({
    sourceSignal: options.signal,
    timeoutMs: options.timeoutMs ?? USER_DATA_WORK_TIMEOUT_MS,
    timeoutCode: options.timeoutCode ?? "user_data_work_timeout",
  });
  let lease: UserDataLease | undefined;
  try {
    lifecycle.signal.throwIfAborted();
    lease = await repositories.userDataMutations.acquireSharedLease(
      fence,
      { signal: lifecycle.signal },
    );
    lifecycle.signal.throwIfAborted();
    const result = await work(lease, lifecycle.signal);
    lifecycle.signal.throwIfAborted();
    return result;
  } finally {
    if (lease) await lease.release();
    lifecycle.dispose();
  }
}

export async function withFreshUserDataLease<T>(
  userId: string,
  work: (
    repositories: ReturnType<typeof createRepositories>,
    signal: AbortSignal,
  ) => Promise<T>,
  options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
    timeoutCode?: string;
  },
): Promise<T> {
  const repositories = createRepositories();
  return withUserDataLease(
    repositories,
    userId,
    (_lease, signal) => work(repositories, signal),
    options,
  );
}

function createBoundedAbortLifecycle(input: {
  sourceSignal?: AbortSignal;
  timeoutMs: number;
  timeoutCode: string;
}): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const abortFromSource = () => {
    if (!controller.signal.aborted) {
      controller.abort(toAbortReason(input.sourceSignal?.reason, input.timeoutCode));
    }
  };
  if (input.sourceSignal?.aborted) {
    abortFromSource();
  } else {
    input.sourceSignal?.addEventListener("abort", abortFromSource, { once: true });
  }

  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(new Error(input.timeoutCode));
    }
  }, input.timeoutMs);
  timer.unref?.();

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      input.sourceSignal?.removeEventListener("abort", abortFromSource);
    },
  };
}

function toAbortReason(reason: unknown, fallbackCode: string): Error {
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === "string" && reason ? reason : fallbackCode);
}
