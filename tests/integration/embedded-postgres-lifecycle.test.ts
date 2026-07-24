import { EventEmitter } from "node:events";
import type EmbeddedPostgres from "embedded-postgres";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { trackEmbeddedPostgresPool } from "./embedded-postgres-lifecycle";

describe("embedded PostgreSQL lifecycle", () => {
  it("waits for every connected client end event before stopping PostgreSQL", async () => {
    const order: string[] = [];
    const client = new EventEmitter() as PoolClient;
    const poolEvents = new EventEmitter();
    const pool = Object.assign(poolEvents, {
      totalCount: 1,
      idleCount: 1,
      waitingCount: 0,
      end: vi.fn(async () => {
        order.push("pool-end");
      }),
    }) as unknown as Pool;
    const database = {
      stop: vi.fn(async () => {
        order.push("postgres-stop");
      }),
    } as unknown as EmbeddedPostgres;
    const lifecycle = trackEmbeddedPostgresPool(pool);
    pool.emit("connect", client);

    const stopping = lifecycle.stop(database);
    await Promise.resolve();
    try {
      expect(database.stop).not.toHaveBeenCalled();
    } finally {
      order.push("client-end");
      client.emit("end");
      Object.assign(pool, { totalCount: 0, idleCount: 0 });
      await stopping;
    }
    expect(order).toEqual(["pool-end", "client-end", "postgres-stop"]);
  });

  it("fails teardown and keeps PostgreSQL running when pool counters do not converge", async () => {
    const pool = Object.assign(new EventEmitter(), {
      totalCount: 1,
      idleCount: 0,
      waitingCount: 0,
      end: vi.fn(async () => undefined),
    }) as unknown as Pool;
    const database = {
      stop: vi.fn(async () => undefined),
    } as unknown as EmbeddedPostgres;
    const lifecycle = trackEmbeddedPostgresPool(pool);

    await expect(lifecycle.stop(database)).rejects.toThrow(
      "embedded_postgres_pool_not_drained:1:0:0",
    );
    expect(database.stop).not.toHaveBeenCalled();
  });
});
