import type { Pool, PoolClient, QueryResult } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createChannelConnectionAuditService } from "@/server/admin/audit";
import { createChannelSecretsKey } from "@/server/security/encrypted-secret";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_ID = "10000000-0000-4000-8000-000000000011";
const CONNECTION_ID = "10000000-0000-4000-8000-000000000021";
const SECRET = "audit-cancellation-secret";
const KEY_STATE = createChannelSecretsKey(
  Buffer.alloc(32, 29).toString("base64"),
);
type DatabaseStage =
  | "BEGIN"
  | "lock_timeout"
  | "statement_timeout"
  | "user_lock"
  | "connection_lock"
  | "secret_read"
  | "connection_update"
  | "secret_write"
  | "audit_write"
  | "COMMIT";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("bounded cancellable channel config audit", () => {
  it("rejects an already-aborted update before reserving a pool client", async () => {
    if (KEY_STATE.status !== "ready") throw new Error("test_key_not_ready");
    const connect = vi.fn();
    const service = createChannelConnectionAuditService(
      { connect } as unknown as Pool,
      KEY_STATE.key,
    );
    const controller = new AbortController();
    controller.abort(new Error(`sensitive-${SECRET}`));

    await expect(
      service.update(updateInput(), controller.signal),
    ).rejects.toMatchObject(safeFailure());
    expect(connect).not.toHaveBeenCalled();
  });

  it("cancels a pending pool checkout and releases a late client once", async () => {
    if (KEY_STATE.status !== "ready") throw new Error("test_key_not_ready");
    const pendingClient = deferred<PoolClient>();
    const release = vi.fn();
    const lateClient = {
      query: vi.fn(),
      release,
    } as unknown as PoolClient;
    const service = createChannelConnectionAuditService(
      {
        connect: vi.fn(() => pendingClient.promise),
      } as unknown as Pool,
      KEY_STATE.key,
    );
    const controller = new AbortController();
    const observed = observe(
      service.update(updateInput(), controller.signal),
    );

    controller.abort(new Error(`sensitive-${SECRET}`));
    const outcome = await settlesWithin(observed, 100);
    expect(outcome).toMatchObject({
      status: "rejected",
      error: safeFailure(),
    });
    expect(release).not.toHaveBeenCalled();

    pendingClient.resolve(lateClient);
    await flushAsyncWork();
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith();
  });

  it.each<DatabaseStage>([
    "BEGIN",
    "lock_timeout",
    "statement_timeout",
    "user_lock",
    "connection_lock",
    "secret_read",
    "connection_update",
    "secret_write",
    "audit_write",
    "COMMIT",
  ])(
    "destroys an acquired client when aborting a pending %s stage without double release",
    async (pendingStage) => {
      if (KEY_STATE.status !== "ready") throw new Error("test_key_not_ready");
      const pendingQuery = deferred<QueryResult<never>>();
      let queryPending = false;
      const queries: DatabaseStage[] = [];
      const release = vi.fn((destroy?: boolean) => {
        if (destroy && queryPending) {
          queryPending = false;
          pendingQuery.reject(new Error("connection_destroyed"));
        }
      });
      const client = {
        query: vi.fn((sql: unknown) => {
          const stage = classifyDatabaseStage(String(sql));
          queries.push(stage);
          if (stage === pendingStage) {
            queryPending = true;
            return pendingQuery.promise;
          }
          return Promise.resolve(databaseStageResult(
            stage,
            String(sql),
          ));
        }),
        release,
      } as unknown as PoolClient;
      const service = createChannelConnectionAuditService(
        {
          connect: vi.fn(async () => client),
        } as unknown as Pool,
        KEY_STATE.key,
      );
      const controller = new AbortController();
      const observed = observe(
        service.update(updateInput(), controller.signal),
      );

      await waitUntil(() => queryPending);
      controller.abort(new Error(`sensitive-${SECRET}`));
      const outcome = await settlesWithin(observed, 100);
      expect(outcome).toMatchObject({
        status: "rejected",
        error: safeFailure(),
      });
      expect(release).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledWith(true);
      if (pendingStage !== "COMMIT") {
        expect(queries).not.toContain("COMMIT");
      }
    },
  );

  it.each(["synchronous", "asynchronous"] as const)(
    "destroys the client when BEGIN has an %s unknown outcome",
    async (failureKind) => {
      if (KEY_STATE.status !== "ready") throw new Error("test_key_not_ready");
      const query = failureKind === "synchronous"
        ? vi.fn((sql: unknown) => {
            if (String(sql) === "BEGIN") {
              throw new Error("begin_response_lost");
            }
            return Promise.resolve({ rows: [] });
          })
        : vi.fn(async (sql: unknown) => {
            if (String(sql) === "BEGIN") {
              throw new Error("begin_response_lost");
            }
            return { rows: [] };
          });
      const release = vi.fn();
      const service = createChannelConnectionAuditService(
        {
          connect: vi.fn(async () => ({
            query,
            release,
          } as unknown as PoolClient)),
        } as unknown as Pool,
        KEY_STATE.key,
      );

      await expect(service.update(updateInput())).rejects.toThrow();
      expect(query.mock.calls.map(([sql]) => String(sql)))
        .not.toContain("ROLLBACK");
      expect(release).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledWith(true);
    },
  );

  it("destroys the client when rollback fails and preserves the primary conflict", async () => {
    if (KEY_STATE.status !== "ready") throw new Error("test_key_not_ready");
    const query = vi.fn(async (sql: unknown) => {
      const text = String(sql);
      if (text === "ROLLBACK") {
        throw new Error("rollback_response_lost");
      }
      if (text.includes("FROM channel_connections")) {
        return { rows: [] };
      }
      return { rows: [] };
    });
    const release = vi.fn();
    const service = createChannelConnectionAuditService(
      {
        connect: vi.fn(async () => ({
          query,
          release,
        } as unknown as PoolClient)),
      } as unknown as Pool,
      KEY_STATE.key,
    );

    await expect(service.update(updateInput())).rejects.toMatchObject({
      status: 409,
      code: "config_revision_conflict",
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(true);
  });

  it("applies an unavoidable hard timeout to a pending pool checkout", async () => {
    if (KEY_STATE.status !== "ready") throw new Error("test_key_not_ready");
    vi.useFakeTimers();
    const pendingClient = deferred<PoolClient>();
    const release = vi.fn();
    const service = createChannelConnectionAuditService(
      {
        connect: vi.fn(() => pendingClient.promise),
      } as unknown as Pool,
      KEY_STATE.key,
      { lifecycleTimeoutMs: 20 },
    );
    let outcome:
      | Awaited<ReturnType<typeof observe>>
      | undefined;
    const observed = observe(service.update(updateInput())).then(
      (value) => {
        outcome = value;
        return value;
      },
    );

    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    try {
      expect(outcome).toMatchObject({
        status: "rejected",
        error: safeFailure(),
      });
    } finally {
      pendingClient.resolve({
        query: vi.fn(() => Promise.resolve({ rows: [] })),
        release,
      } as unknown as PoolClient);
      await observed;
      await Promise.resolve();
    }
    expect(release).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clamps an injected lifecycle timeout below the compatibility ceiling", async () => {
    if (KEY_STATE.status !== "ready") throw new Error("test_key_not_ready");
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const service = createChannelConnectionAuditService(
      {
        connect: vi.fn(async () => {
          throw new Error("connect_failed");
        }),
      } as unknown as Pool,
      KEY_STATE.key,
      { lifecycleTimeoutMs: Number.MAX_SAFE_INTEGER },
    );

    await expect(service.update(updateInput())).rejects.toThrow(
      "connect_failed",
    );
    const scheduledDelays = timeoutSpy.mock.calls
      .map((call) => call[1])
      .filter((delay): delay is number => typeof delay === "number");
    expect(scheduledDelays).toContainEqual(
      expect.toSatisfy(
        (delay: number) => delay > 0 && delay < 120_000,
      ),
    );
  });

  it("sets transaction-local lock and statement timeouts below 120 seconds", async () => {
    if (KEY_STATE.status !== "ready") throw new Error("test_key_not_ready");
    const queries: string[] = [];
    const release = vi.fn();
    const client = {
      query: vi.fn((sql: unknown) => {
        const text = String(sql);
        queries.push(text);
        if (text.includes("FROM channel_connections")) {
          return Promise.resolve({
            rows: [connectionRow(1, { endpoint: "old" })],
          });
        }
        if (text.startsWith("UPDATE channel_connections")) {
          return Promise.resolve({
            rows: [connectionRow(2, { endpoint: "safe" })],
          });
        }
        if (
          text.includes(
            "FROM channel_secret_exposure_fingerprints",
          )
          && text.includes("count(*)")
        ) {
          return Promise.resolve({ rows: [{ count: "0" }] });
        }
        return Promise.resolve({ rows: [] });
      }),
      release,
    } as unknown as PoolClient;
    const service = createChannelConnectionAuditService(
      {
        connect: vi.fn(async () => client),
      } as unknown as Pool,
      KEY_STATE.key,
    );

    await expect(service.update(updateInput())).resolves.toEqual({
      revision: 2,
    });
    const timeoutQueries = queries.filter((query) =>
      /^SET LOCAL (?:lock|statement)_timeout = '\d+ms'$/.test(query)
    );
    expect(timeoutQueries).toHaveLength(2);
    for (const query of timeoutQueries) {
      const timeout = Number(query.match(/'(\d+)ms'/)?.[1]);
      expect(timeout).toBeGreaterThan(0);
      expect(timeout).toBeLessThan(120_000);
    }
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith();
  });
});

function updateInput() {
  return {
    scope: { userId: USER_ID, agentId: AGENT_ID },
    connectionId: CONNECTION_ID,
    expectedRevision: 1,
    config: { endpoint: "safe" },
    secretFieldNames: ["bot_token"],
    secretChanges: [
      {
        fieldName: "bot_token",
        operation: "set" as const,
        value: SECRET,
      },
    ],
    auditConfigFields: ["endpoint"],
  };
}

function connectionRow(
  revision: number,
  config: Record<string, unknown>,
) {
  return {
    id: CONNECTION_ID,
    user_id: USER_ID,
    agent_id: AGENT_ID,
    channel_type: "telegram",
    display_name: "Telegram",
    enabled: true,
    config,
    revision,
  };
}

function classifyDatabaseStage(sql: string): DatabaseStage {
  if (sql === "BEGIN" || sql === "COMMIT") return sql;
  if (sql.startsWith("SET LOCAL lock_timeout")) return "lock_timeout";
  if (sql.startsWith("SET LOCAL statement_timeout")) {
    return "statement_timeout";
  }
  if (sql.includes("pg_advisory_xact_lock")) {
    return "user_lock";
  }
  if (sql.includes("FROM channel_connections")) {
    return "connection_lock";
  }
  if (
    sql.includes("FROM channel_secrets")
    || sql.includes(
      "FROM channel_secret_exposure_fingerprints",
    )
  ) {
    return "secret_read";
  }
  if (sql.startsWith("UPDATE channel_connections")) {
    return "connection_update";
  }
  if (
    sql.includes("INSERT INTO channel_secrets")
    || sql.includes(
      "INSERT INTO channel_secret_exposure_fingerprints",
    )
  ) {
    return "secret_write";
  }
  if (sql.includes("INSERT INTO admin_audit_logs")) {
    return "audit_write";
  }
  throw new Error(`unexpected audit query: ${sql}`);
}

function databaseStageResult(
  stage: DatabaseStage,
  sql: string,
) {
  if (
    stage === "secret_read"
    && sql.includes("count(*)")
  ) {
    return { rows: [{ count: "0" }] };
  }
  if (stage === "connection_lock") {
    return { rows: [connectionRow(1, { endpoint: "old" })] };
  }
  if (stage === "connection_update") {
    return { rows: [connectionRow(2, { endpoint: "safe" })] };
  }
  return { rows: [] };
}

function safeFailure() {
  return {
    status: 500,
    code: "channel_config_update_failed",
    message: "channel_config_update_failed",
  };
}

function observe(promise: Promise<unknown>) {
  return promise.then(
    (value) => ({ status: "resolved" as const, value }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
}

async function settlesWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | { status: "timed_out" }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<{ status: "timed_out" }>((resolve) => {
        timer = setTimeout(
          () => resolve({ status: "timed_out" }),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await flushAsyncWork();
  }
  throw new Error("condition_not_reached");
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
