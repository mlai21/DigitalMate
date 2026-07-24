import type { Pool, PoolClient, QueryResult } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRepositories } from "@/server/db/repositories";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const AGENT_ID = "01000000-0000-4000-8000-000000000001";
const TASK_RUN_ID = "70000000-0000-4000-8000-000000000001";
const ARTIFACT_IDS = [
  "71000000-0000-4000-8000-000000000001",
  "71000000-0000-4000-8000-000000000002",
];
const SCOPE = { userId: USER_ID, agentId: AGENT_ID };
const RECOVERY_TIMEOUT_MS = 5_000;

type MainStage = "connect" | "BEGIN" | "artifact_update" | "task_update" | "COMMIT";
type RecoveryStage = "connect" | "task_select" | "artifact_select";
type Outcome =
  | { status: "resolved" }
  | { status: "rejected"; error: unknown };

afterEach(() => {
  vi.useRealTimers();
});

describe("cancellable task completion transaction", () => {
  it("rejects an already-aborted operation without reserving a pool client", async () => {
    const connect = vi.fn();
    const repositories = createRepositories({ connect } as unknown as Pool);
    const controller = new AbortController();
    controller.abort(new Error("task_already_aborted"));

    await expect(
      repositories.taskRuns.completeWithArtifacts(
        SCOPE,
        TASK_RUN_ID,
        "任务完成",
        ARTIFACT_IDS,
        controller.signal,
      ),
    ).rejects.toThrow("task_already_aborted");

    expect(connect).not.toHaveBeenCalled();
  });

  it.each<MainStage>([
    "connect",
    "BEGIN",
    "artifact_update",
    "task_update",
  ])("cancels a half-open %s stage before COMMIT and destroys acquired clients", async (stage) => {
    const fixture = createMainStageFixture(stage);
    const repositories = createRepositories(fixture.pool);
    const controller = new AbortController();
    let outcome: Outcome | undefined;
    const observed = repositories.taskRuns.completeWithArtifacts(
      SCOPE,
      TASK_RUN_ID,
      "任务完成",
      ARTIFACT_IDS,
      controller.signal,
    ).then(
      () => {
        outcome = { status: "resolved" };
      },
      (error: unknown) => {
        outcome = { status: "rejected", error };
      },
    );

    await fixture.reached;
    controller.abort(new Error(`abort_${stage}`));
    await flushAsyncWork();

    try {
      expect(outcome).toMatchObject({
        status: "rejected",
        error: expect.objectContaining({ message: `abort_${stage}` }),
      });
      if (stage === "connect") {
        expect(fixture.release).not.toHaveBeenCalled();
      } else {
        expect(fixture.release).toHaveBeenCalledWith(true);
      }
      expect(fixture.queries).not.toContain("COMMIT");
      expect(fixture.queries).not.toContain("ROLLBACK");
    } finally {
      fixture.unblock();
      await observed;
      await flushAsyncWork();
    }

    if (stage === "connect") {
      expect(fixture.release).toHaveBeenCalledWith();
    }
  });

  it("uses independent verification when an abort races a half-open COMMIT response", async () => {
    const fixture = createCommitRecoveryFixture({
      mainCommit: "half_open",
      taskStatus: "succeeded",
      artifactStatuses: ARTIFACT_IDS.map((id) => ({ id, status: "ready" })),
    });
    const repositories = createRepositories(fixture.pool);
    const controller = new AbortController();
    let outcome: Outcome | undefined;
    const observed = repositories.taskRuns.completeWithArtifacts(
      SCOPE,
      TASK_RUN_ID,
      "任务完成",
      ARTIFACT_IDS,
      controller.signal,
    ).then(
      () => {
        outcome = { status: "resolved" };
      },
      (error: unknown) => {
        outcome = { status: "rejected", error };
      },
    );

    await fixture.mainCommitReached;
    controller.abort(new Error("outer_task_timeout"));
    await flushAsyncWork();

    try {
      expect(outcome).toEqual({ status: "resolved" });
      expect(fixture.transactionRelease).toHaveBeenCalledWith(true);
      expect(fixture.verificationQueries).toEqual(["task_select", "artifact_select"]);
      expect(fixture.verificationRelease).toHaveBeenCalledWith();
    } finally {
      fixture.unblockMainCommit();
      await observed;
    }
  });
});

describe("bounded task completion recovery", () => {
  it.each<RecoveryStage>([
    "connect",
    "task_select",
    "artifact_select",
  ])("times out a half-open verification %s stage as ambiguous without reusing the outer signal", async (stage) => {
    vi.useFakeTimers();
    const fixture = createCommitRecoveryFixture({
      mainCommit: "throws",
      recoveryStage: stage,
      taskStatus: "succeeded",
      artifactStatuses: ARTIFACT_IDS.map((id) => ({ id, status: "ready" })),
    });
    const repositories = createRepositories(fixture.pool);
    const outerController = new AbortController();
    let outcome: Outcome | undefined;
    const observed = repositories.taskRuns.completeWithArtifacts(
      SCOPE,
      TASK_RUN_ID,
      "任务完成",
      ARTIFACT_IDS,
      outerController.signal,
    ).then(
      () => {
        outcome = { status: "resolved" };
      },
      (error: unknown) => {
        outcome = { status: "rejected", error };
      },
    );

    await fixture.recoveryReached;
    outerController.abort(new Error("outer_aborted_after_commit"));
    await vi.advanceTimersByTimeAsync(RECOVERY_TIMEOUT_MS);
    await flushMicrotasks();

    try {
      expect(outcome).toMatchObject({
        status: "rejected",
        error: expect.objectContaining({ code: "task_completion_ambiguous" }),
      });
      if (stage === "connect") {
        expect(fixture.verificationRelease).not.toHaveBeenCalled();
      } else {
        expect(fixture.verificationRelease).toHaveBeenCalledWith(true);
      }
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      fixture.unblockRecovery();
      await observed;
      await flushMicrotasks();
    }

    if (stage === "connect") {
      expect(fixture.verificationRelease).toHaveBeenCalledWith();
    }
    await expect(fixture.pool.connect()).resolves.toBeDefined();
  });
});

function createMainStageFixture(stage: MainStage) {
  const reached = deferred<void>();
  const connectDeferred = deferred<PoolClient>();
  const queryDeferred = deferred<QueryResult<never>>();
  let queryPending = false;
  const queries: string[] = [];
  const release = vi.fn((destroy?: boolean) => {
    if (destroy && queryPending) {
      queryPending = false;
      queryDeferred.reject(new Error("transaction_connection_destroyed"));
    }
  });
  const client = {
    query: vi.fn((sql: unknown) => {
      const phase = classifyMainStage(String(sql));
      queries.push(phase);
      if (phase === stage) {
        queryPending = true;
        reached.resolve();
        return queryDeferred.promise;
      }
      return Promise.resolve(mainStageResult(phase));
    }),
    release,
  } as unknown as PoolClient;
  const reusableClient = {
    query: vi.fn(),
    release: vi.fn(),
  } as unknown as PoolClient;
  let connectCalls = 0;
  const pool = {
    connect: vi.fn(() => {
      connectCalls += 1;
      if (connectCalls > 1) return Promise.resolve(reusableClient);
      if (stage === "connect") {
        reached.resolve();
        return connectDeferred.promise;
      }
      return Promise.resolve(client);
    }),
  } as unknown as Pool;

  return {
    pool,
    reached: reached.promise,
    release,
    queries,
    unblock() {
      if (stage === "connect") {
        connectDeferred.resolve(client);
      } else if (queryPending) {
        queryPending = false;
        queryDeferred.resolve(mainStageResult(stage));
      }
    },
  };
}

function createCommitRecoveryFixture(input: {
  mainCommit: "half_open" | "throws";
  recoveryStage?: RecoveryStage;
  taskStatus: "running" | "succeeded";
  artifactStatuses: Array<{ id: string; status: "pending" | "ready" }>;
}) {
  const mainCommitReached = deferred<void>();
  const mainCommitDeferred = deferred<QueryResult<never>>();
  let mainCommitPending = false;
  const transactionRelease = vi.fn((destroy?: boolean) => {
    if (destroy && mainCommitPending) {
      mainCommitPending = false;
      mainCommitDeferred.reject(new Error("transaction_connection_destroyed"));
    }
  });
  const transactionClient = {
    query: vi.fn((sql: unknown) => {
      const stage = classifyMainStage(String(sql));
      if (stage === "COMMIT") {
        mainCommitReached.resolve();
        if (input.mainCommit === "throws") {
          return Promise.reject(new Error("connection_lost_after_commit"));
        }
        mainCommitPending = true;
        return mainCommitDeferred.promise;
      }
      return Promise.resolve(mainStageResult(stage));
    }),
    release: transactionRelease,
  } as unknown as PoolClient;

  const recoveryReached = deferred<void>();
  const recoveryConnectDeferred = deferred<PoolClient>();
  const recoveryQueryDeferred = deferred<QueryResult<never>>();
  let recoveryQueryPending = false;
  const verificationQueries: string[] = [];
  const verificationRelease = vi.fn((destroy?: boolean) => {
    if (destroy && recoveryQueryPending) {
      recoveryQueryPending = false;
      recoveryQueryDeferred.reject(new Error("verification_connection_destroyed"));
    }
  });
  const verificationClient = {
    query: vi.fn((sql: unknown) => {
      const stage: Exclude<RecoveryStage, "connect"> = String(sql).includes("FROM task_runs")
        ? "task_select"
        : "artifact_select";
      verificationQueries.push(stage);
      if (input.recoveryStage === stage) {
        recoveryQueryPending = true;
        recoveryReached.resolve();
        return recoveryQueryDeferred.promise;
      }
      return Promise.resolve(recoveryStageResult(stage, input));
    }),
    release: verificationRelease,
  } as unknown as PoolClient;
  const reusableClient = {
    query: vi.fn(),
    release: vi.fn(),
  } as unknown as PoolClient;

  let connectCalls = 0;
  const pool = {
    connect: vi.fn(() => {
      connectCalls += 1;
      if (connectCalls === 1) return Promise.resolve(transactionClient);
      if (connectCalls === 2 && input.recoveryStage === "connect") {
        recoveryReached.resolve();
        return recoveryConnectDeferred.promise;
      }
      if (connectCalls === 2) return Promise.resolve(verificationClient);
      return Promise.resolve(reusableClient);
    }),
  } as unknown as Pool;

  return {
    pool,
    mainCommitReached: mainCommitReached.promise,
    recoveryReached: input.recoveryStage ? recoveryReached.promise : Promise.resolve(),
    transactionRelease,
    verificationQueries,
    verificationRelease,
    unblockMainCommit() {
      if (mainCommitPending) {
        mainCommitPending = false;
        mainCommitDeferred.resolve({ rows: [] } as unknown as QueryResult<never>);
      }
    },
    unblockRecovery() {
      if (input.recoveryStage === "connect") {
        recoveryConnectDeferred.resolve(verificationClient);
      } else if (recoveryQueryPending && input.recoveryStage) {
        recoveryQueryPending = false;
        recoveryQueryDeferred.resolve(recoveryStageResult(input.recoveryStage, input));
      }
    },
  };
}

function classifyMainStage(sql: string): MainStage {
  if (sql === "BEGIN" || sql === "COMMIT") return sql;
  if (sql.includes("UPDATE task_artifacts")) return "artifact_update";
  if (sql.includes("UPDATE task_runs")) return "task_update";
  throw new Error(`unexpected transaction query: ${sql}`);
}

function mainStageResult(stage: MainStage): QueryResult<never> {
  if (stage === "artifact_update") {
    return { rows: ARTIFACT_IDS.map((id) => ({ id })) } as unknown as QueryResult<never>;
  }
  if (stage === "task_update") {
    return { rows: [{ id: TASK_RUN_ID }] } as unknown as QueryResult<never>;
  }
  return { rows: [] } as unknown as QueryResult<never>;
}

function recoveryStageResult(
  stage: RecoveryStage,
  input: {
    taskStatus: "running" | "succeeded";
    artifactStatuses: Array<{ id: string; status: "pending" | "ready" }>;
  },
): QueryResult<never> {
  if (stage === "task_select") {
    return { rows: [{ status: input.taskStatus }] } as unknown as QueryResult<never>;
  }
  return { rows: input.artifactStatuses } as unknown as QueryResult<never>;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
