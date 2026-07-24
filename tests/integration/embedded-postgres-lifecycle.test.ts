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

  it("reports undrained counters but still stops PostgreSQL", async () => {
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
    expect(database.stop).toHaveBeenCalledOnce();
    expect(pool.listenerCount("connect")).toBe(0);
  });

  it("bounds a missing client end event and removes lifecycle listeners", async () => {
    const client = new EventEmitter() as PoolClient;
    const pool = Object.assign(new EventEmitter(), {
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
      end: vi.fn(async () => undefined),
    }) as unknown as Pool;
    const database = {
      stop: vi.fn(async () => undefined),
    } as unknown as EmbeddedPostgres;
    const lifecycle = trackEmbeddedPostgresPool(pool, {
      clientEndTimeoutMs: 5,
    });
    pool.emit("connect", client);

    await expect(lifecycle.stop(database)).rejects.toThrow(
      "embedded_postgres_client_end_timeout:1",
    );

    expect(database.stop).toHaveBeenCalledOnce();
    expect(pool.listenerCount("connect")).toBe(0);
    expect(client.listenerCount("end")).toBe(0);
  });

  it("preserves a pool.end failure while still stopping PostgreSQL", async () => {
    const primaryError = new Error("pool end failed");
    const pool = Object.assign(new EventEmitter(), {
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
      end: vi.fn(async () => {
        throw primaryError;
      }),
    }) as unknown as Pool;
    const database = {
      stop: vi.fn(async () => undefined),
    } as unknown as EmbeddedPostgres;
    const lifecycle = trackEmbeddedPostgresPool(pool);

    await expect(lifecycle.stop(database)).rejects.toBe(primaryError);
    expect(database.stop).toHaveBeenCalledOnce();
    expect(pool.listenerCount("connect")).toBe(0);
  });

  it("aggregates pool and PostgreSQL stop failures without swallowing either", async () => {
    const poolError = new Error("pool end failed");
    const stopError = new Error("postgres stop failed");
    const pool = Object.assign(new EventEmitter(), {
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
      end: vi.fn(async () => {
        throw poolError;
      }),
    }) as unknown as Pool;
    const database = {
      stop: vi.fn(async () => {
        throw stopError;
      }),
    } as unknown as EmbeddedPostgres;
    const lifecycle = trackEmbeddedPostgresPool(pool);

    const failure = await lifecycle.stop(database).catch((error) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      poolError,
      stopError,
    ]);
  });

  it("bounds a half-open pool.end and still cleans every listener", async () => {
    const client = new EventEmitter() as PoolClient;
    const pool = Object.assign(new EventEmitter(), {
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
      end: vi.fn(() => new Promise<void>(() => undefined)),
    }) as unknown as Pool;
    const database = {
      stop: vi.fn(async () => undefined),
    } as unknown as EmbeddedPostgres;
    const lifecycle = trackEmbeddedPostgresPool(pool, {
      poolEndTimeoutMs: 5,
    });
    pool.emit("connect", client);

    await expect(lifecycle.stop(database)).rejects.toThrow(
      "embedded_postgres_pool_end_timeout:5",
    );

    expect(database.stop).toHaveBeenCalledOnce();
    expect(pool.listenerCount("connect")).toBe(0);
    expect(client.listenerCount("end")).toBe(0);
  });

  it("aggregates a pool.end timeout with a later PostgreSQL stop failure", async () => {
    const stopError = new Error("postgres stop failed after timeout");
    const pool = Object.assign(new EventEmitter(), {
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
      end: vi.fn(() => new Promise<void>(() => undefined)),
    }) as unknown as Pool;
    const database = {
      stop: vi.fn(async () => {
        throw stopError;
      }),
    } as unknown as EmbeddedPostgres;
    const lifecycle = trackEmbeddedPostgresPool(pool, {
      poolEndTimeoutMs: 5,
    });

    const failure = await lifecycle.stop(database).catch((error) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
    expect((failure as AggregateError).errors[0]).toMatchObject({
      message: "embedded_postgres_pool_end_timeout:5",
    });
    expect((failure as AggregateError).errors[1]).toBe(stopError);
  });
});
