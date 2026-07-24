import type EmbeddedPostgres from "embedded-postgres";
import type { Pool, PoolClient } from "pg";

export type EmbeddedPostgresLifecycle = {
  stop(database: EmbeddedPostgres): Promise<void>;
};

export function trackEmbeddedPostgresPool(pool: Pool): EmbeddedPostgresLifecycle {
  const clientEnds = new Map<PoolClient, Promise<void>>();
  const trackClient = (client: PoolClient) => {
    let markEnded: (() => void) | undefined;
    const ended = new Promise<void>((resolve) => {
      markEnded = resolve;
    });
    clientEnds.set(client, ended);
    client.once("end", () => {
      clientEnds.delete(client);
      markEnded?.();
    });
  };
  pool.on("connect", trackClient);

  return {
    async stop(database) {
      await pool.end();
      pool.off("connect", trackClient);
      await Promise.all([...clientEnds.values()]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (pool.totalCount !== 0 || pool.idleCount !== 0 || pool.waitingCount !== 0) {
        throw new Error(
          `embedded_postgres_pool_not_drained:${pool.totalCount}:${pool.idleCount}:${pool.waitingCount}`,
        );
      }
      await database.stop();
    },
  };
}
