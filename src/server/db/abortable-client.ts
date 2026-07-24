import type { Pool, PoolClient } from "pg";

export type AbortablePoolClientGuard = {
  readonly destroyed: boolean;
  destroy(): void;
  dispose(): void;
};

export function guardPoolClientWithAbort(
  client: PoolClient,
  signal?: AbortSignal,
): AbortablePoolClientGuard {
  let destroyed = false;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    client.release(true);
  };
  if (signal?.aborted) {
    destroy();
  } else {
    signal?.addEventListener("abort", destroy, { once: true });
  }
  return {
    get destroyed() {
      return destroyed;
    },
    destroy,
    dispose() {
      signal?.removeEventListener("abort", destroy);
    },
  };
}

export async function connectPoolClient(
  pool: Pool,
  signal?: AbortSignal,
): Promise<PoolClient> {
  signal?.throwIfAborted();
  if (!signal) return pool.connect();

  return new Promise<PoolClient>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void pool.connect().then(
      (client) => {
        if (settled) {
          client.release();
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(client);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
