import type EmbeddedPostgres from "embedded-postgres";
import type { Pool, PoolClient } from "pg";

export type EmbeddedPostgresLifecycle = {
  stop(database: EmbeddedPostgres): Promise<void>;
};

export type EmbeddedPostgresLifecycleOptions = {
  poolEndTimeoutMs?: number;
  clientEndTimeoutMs?: number;
};

type TrackedClientEnd = {
  ended: Promise<void>;
  onEnd: () => void;
};

const defaultClientEndTimeoutMs = 5_000;
const defaultPoolEndTimeoutMs = 5_000;

export function trackEmbeddedPostgresPool(
  pool: Pool,
  options: EmbeddedPostgresLifecycleOptions = {},
): EmbeddedPostgresLifecycle {
  const clientEnds = new Map<PoolClient, TrackedClientEnd>();
  const trackClient = (client: PoolClient) => {
    if (clientEnds.has(client)) return;
    let markEnded: (() => void) | undefined;
    const ended = new Promise<void>((resolve) => {
      markEnded = resolve;
    });
    const onEnd = () => {
      clientEnds.delete(client);
      markEnded?.();
    };
    clientEnds.set(client, { ended, onEnd });
    client.once("end", onEnd);
  };
  pool.on("connect", trackClient);

  return {
    async stop(database) {
      const errors: unknown[] = [];
      try {
        await captureFailure(errors, () =>
          endPoolAndDrainClients(
            pool,
            clientEnds,
            options.poolEndTimeoutMs ?? defaultPoolEndTimeoutMs,
            options.clientEndTimeoutMs ?? defaultClientEndTimeoutMs,
          ),
        );
        await captureFailure(
          errors,
          () => new Promise<void>((resolve) => setImmediate(resolve)),
        );
        await captureFailure(errors, async () => {
          if (
            pool.totalCount !== 0 ||
            pool.idleCount !== 0 ||
            pool.waitingCount !== 0
          ) {
            throw new Error(
              `embedded_postgres_pool_not_drained:${pool.totalCount}:${pool.idleCount}:${pool.waitingCount}`,
            );
          }
        });
      } finally {
        try {
          pool.off("connect", trackClient);
        } catch (error) {
          errors.push(error);
        }
        for (const [client, tracked] of clientEnds) {
          try {
            client.off("end", tracked.onEnd);
          } catch (error) {
            errors.push(error);
          }
        }
        clientEnds.clear();
        await captureFailure(errors, () => database.stop());
      }
      throwTeardownErrors(errors);
    },
  };
}

async function endPoolAndDrainClients(
  pool: Pool,
  clientEnds: Map<PoolClient, TrackedClientEnd>,
  poolEndTimeoutMs: number,
  clientEndTimeoutMs: number,
): Promise<void> {
  await endPoolWithTimeout(pool, poolEndTimeoutMs);
  await waitForClientEnds(clientEnds, clientEndTimeoutMs);
}

async function endPoolWithTimeout(
  pool: Pool,
  timeoutMs: number,
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new Error(`embedded_postgres_pool_end_timeout:${timeoutMs}`),
      );
    }, timeoutMs);
  });
  try {
    await Promise.race([
      Promise.resolve().then(() => pool.end()),
      timeout,
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function waitForClientEnds(
  clientEnds: Map<PoolClient, TrackedClientEnd>,
  timeoutMs: number,
): Promise<void> {
  if (clientEnds.size === 0) return;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new Error(
          `embedded_postgres_client_end_timeout:${clientEnds.size}`,
        ),
      );
    }, timeoutMs);
  });
  try {
    await Promise.race([
      Promise.all([...clientEnds.values()].map(({ ended }) => ended)),
      timeout,
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function captureFailure(
  errors: unknown[],
  action: () => Promise<unknown>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    errors.push(error);
  }
}

function throwTeardownErrors(errors: unknown[]): void {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(
    errors,
    "embedded_postgres_teardown_failed",
  );
}
