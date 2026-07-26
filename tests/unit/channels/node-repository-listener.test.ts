import { EventEmitter } from "node:events";

import type { Pool, PoolClient } from "pg";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  createChannelNodeRepository,
} from "@/server/channels/nodes/repository";

const NODE_ID = "30000000-0000-4000-8000-000000000001";

afterEach(() => {
  vi.useRealTimers();
});

describe("channel node revocation listener", () => {
  it("handles a listener connection error and restores LISTEN with bounded backoff", async () => {
    vi.useFakeTimers();
    const first = fakePoolClient();
    const second = fakePoolClient([NODE_ID]);
    const connect = vi.fn()
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client);
    const repository = createChannelNodeRepository({
      connect,
    } as unknown as Pool);
    const listener = vi.fn();
    const unsubscribe =
      await repository.subscribeToRevocations(listener);

    expect(first.query).toHaveBeenCalledWith(
      "LISTEN channel_runtime_node_revoked",
    );
    expect(() => {
      first.events.emit(
        "error",
        new Error("listener_connection_lost"),
      );
    }).not.toThrow();
    expect(first.release).toHaveBeenCalledWith(true);

    await vi.advanceTimersByTimeAsync(100);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(second.query).toHaveBeenCalledWith(
      "LISTEN channel_runtime_node_revoked",
    );
    expect(listener).toHaveBeenCalledWith(NODE_ID);
    listener.mockClear();
    second.events.emit("notification", {
      channel: "channel_runtime_node_revoked",
      payload: NODE_ID,
    });
    expect(listener).toHaveBeenCalledWith(NODE_ID);

    await unsubscribe();
    expect(second.query).toHaveBeenCalledWith(
      "UNLISTEN channel_runtime_node_revoked",
    );
    expect(second.release).toHaveBeenCalledWith(false);
  });
});

function fakePoolClient(revokedIds: string[] = []) {
  const events = new EventEmitter();
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes("FROM channel_runtime_nodes")
      ? revokedIds.map((id) => ({ id }))
      : [],
    rowCount: 0,
  }));
  const release = vi.fn();
  const client = Object.assign(events, {
    query,
    release,
  }) as unknown as PoolClient;
  return { client, events, query, release };
}
