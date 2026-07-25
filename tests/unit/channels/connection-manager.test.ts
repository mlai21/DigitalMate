import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  ChannelConnectionError,
  createChannelConnectionManager,
  createPostgresChannelConnectionRuntimeStore,
  redactChannelHealthDetail,
  type ChannelConnectionRuntimeStore,
  type RuntimeChannelConnection,
  type RuntimeChannelHealthUpdate,
} from "@/server/channels/runtime/connection-manager";
import type { ChannelAdapter } from "@/server/channels/runtime/adapter";
import {
  getChannelManifest,
  type ChannelType,
} from "@/server/channels/manifests/catalog";
import type { ChannelHealth } from "@/server/channels/runtime/types";

afterEach(() => {
  vi.useRealTimers();
});

describe("channel connection manager", () => {
  it("restarts only the target connection when its revision increases", async () => {
    const harness = managerHarness();
    await harness.manager.startAll();
    harness.connections.set(CONNECTION_A, {
      ...harness.connections.get(CONNECTION_A)!,
      revision: 2,
      config: {
        enabled: true,
        marker: "revision-2",
      },
    });

    await harness.manager.onConfigChanged({
      connectionId: CONNECTION_A,
      revision: 2,
    });

    expect(harness.adapters.get(CONNECTION_A)!.stop)
      .toHaveBeenCalledWith("reconfigure");
    expect(harness.adapters.get(CONNECTION_A)!.start)
      .toHaveBeenCalledTimes(2);
    expect(harness.adapters.get(CONNECTION_B)!.start)
      .toHaveBeenCalledTimes(1);
    await harness.manager.shutdown();
  });

  it("is idempotent under concurrent start and ignores stale revisions", async () => {
    const harness = managerHarness();

    await Promise.all([
      harness.manager.startAll(),
      harness.manager.startAll(),
      harness.manager.startAll(),
    ]);
    await harness.manager.onConfigChanged({
      connectionId: CONNECTION_A,
      revision: 1,
    });

    expect(harness.adapters.get(CONNECTION_A)!.start)
      .toHaveBeenCalledTimes(1);
    expect(harness.adapters.get(CONNECTION_B)!.start)
      .toHaveBeenCalledTimes(1);
    expect(harness.subscribe).toHaveBeenCalledTimes(1);
    await harness.manager.shutdown();
  });

  it("exposes only the active adapter at the exact revision", async () => {
    const harness = managerHarness();
    await harness.manager.startAll();
    const adapter = harness.adapters.get(CONNECTION_A)!;

    expect(
      harness.manager.getAdapter(CONNECTION_A, 1),
    ).toBe(adapter);
    expect(
      harness.manager.getAdapter(CONNECTION_A, 2),
    ).toBeNull();
    expect(
      harness.manager.getAdapter("missing", 1),
    ).toBeNull();

    await harness.manager.shutdown();
    expect(
      harness.manager.getAdapter(CONNECTION_A, 1),
    ).toBeNull();
  });

  it("keeps the new revision and reports degraded when new credentials fail", async () => {
    vi.useFakeTimers();
    const harness = managerHarness();
    await harness.manager.startAll();
    const connection = {
      ...harness.connections.get(CONNECTION_A)!,
      revision: 2,
      config: {
        enabled: true,
        bot_token: "invalid",
      },
    };
    harness.connections.set(CONNECTION_A, connection);
    harness.adapters.get(CONNECTION_A)!.validateConfig
      .mockImplementationOnce(() => {
        throw new ChannelConnectionError({
          code: "credential_invalid",
          detail:
            "POST https://api.example.test/send?token=secret body={\"token\":\"secret\"}",
        });
      });

    await harness.manager.onConfigChanged({
      connectionId: CONNECTION_A,
      revision: 2,
    });

    expect(connection.revision).toBe(2);
    const health = harness.healthUpdates.at(-1)!;
    expect(health.status).toBe("degraded");
    expect(health.detail).toMatchObject({
      code: "credential_invalid",
      reconnectAttempts: 1,
      nextAttemptAt: expect.any(String),
    });
    const serialized = JSON.stringify(health);
    expect(serialized).not.toContain("token=secret");
    expect(serialized).not.toContain("\"token\":\"secret\"");
    expect(harness.adapters.get(CONNECTION_B)!.start)
      .toHaveBeenCalledTimes(1);
    await harness.manager.shutdown();
  });

  it("reconnects with backoff and does not restart unrelated connections", async () => {
    vi.useFakeTimers();
    const harness = managerHarness();
    harness.adapters.set(
      CONNECTION_A,
      fakeAdapter("telegram"),
    );
    harness.adapters.get(CONNECTION_A)!.start
      .mockRejectedValueOnce(new ChannelConnectionError({
        code: "network_unreachable",
        detail: "temporary network error",
      }))
      .mockResolvedValueOnce(undefined);

    await harness.manager.startAll();
    expect(harness.adapters.get(CONNECTION_A)!.start)
      .toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.adapters.get(CONNECTION_A)!.start)
      .toHaveBeenCalledTimes(2);
    expect(harness.adapters.get(CONNECTION_B)!.start)
      .toHaveBeenCalledTimes(1);
    expect(harness.healthUpdates.at(-1)?.status).toBe(
      "connected",
    );
    await harness.manager.shutdown();
  });

  it("stops a disabled connection without starting it again", async () => {
    const harness = managerHarness();
    await harness.manager.startAll();
    harness.connections.set(CONNECTION_A, {
      ...harness.connections.get(CONNECTION_A)!,
      enabled: false,
      revision: 2,
      config: { enabled: false },
    });

    await harness.manager.onConfigChanged({
      connectionId: CONNECTION_A,
      revision: 2,
    });

    expect(harness.adapters.get(CONNECTION_A)!.stop)
      .toHaveBeenCalledWith("disabled");
    expect(harness.adapters.get(CONNECTION_A)!.start)
      .toHaveBeenCalledTimes(1);
    expect(harness.healthUpdates.at(-1)?.status).toBe("disabled");
    await harness.manager.shutdown();
  });

  it("blocks safely without retrying when a runtime prerequisite is missing", async () => {
    vi.useFakeTimers();
    const harness = managerHarness();
    harness.connections.set(CONNECTION_A, {
      ...harness.connections.get(CONNECTION_A)!,
      runtimeError: {
        code: "runtime_prerequisite_missing",
        detail: "渠道凭据解密密钥不可用。",
      },
    });

    await harness.manager.startAll();
    const adapter = harness.adapters.get(CONNECTION_A)!;
    const health = harness.healthUpdates.find(
      (update) => update.status === "blocked",
    )!;

    expect(adapter.validateConfig).not.toHaveBeenCalled();
    expect(adapter.start).not.toHaveBeenCalled();
    expect(health).toMatchObject({
      status: "blocked",
      detail: {
        code: "runtime_prerequisite_missing",
        reconnectAttempts: 1,
      },
    });
    expect(health.detail).not.toHaveProperty("nextAttemptAt");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(adapter.start).not.toHaveBeenCalled();
    await harness.manager.shutdown();
  });

  it("maps adapter health into a safe Console health snapshot", async () => {
    const harness = managerHarness({
      health: {
        status: "degraded",
        checkedAt: new Date("2026-07-26T00:00:00.000Z"),
        reconnectAttempts: 3,
        nextAttemptAt:
          new Date("2026-07-26T00:00:10.000Z"),
        lastConnectedAt:
          new Date("2026-07-25T23:59:00.000Z"),
        lastEventAt:
          new Date("2026-07-25T23:59:30.000Z"),
        error: {
          code: "rate_limited",
          detail:
            "https://api.example.test/path?access_token=secret raw body: {secret}",
        },
      },
    });
    await harness.manager.startAll();

    await harness.manager.refreshHealth(CONNECTION_A);

    const health = harness.healthUpdates.at(-1)!;
    expect(health).toMatchObject({
      status: "degraded",
      lastConnectedAt:
        new Date("2026-07-25T23:59:00.000Z"),
      lastEventAt:
        new Date("2026-07-25T23:59:30.000Z"),
      detail: {
        code: "rate_limited",
        reconnectAttempts: 3,
        nextAttemptAt: "2026-07-26T00:00:10.000Z",
      },
    });
    expect(JSON.stringify(health)).not.toContain("access_token");
    expect(JSON.stringify(health)).not.toContain("{secret}");
    await harness.manager.shutdown();
  });

  it("persists Gateway resume state in connection health detail", async () => {
    const harness = managerHarness({
      health: {
        status: "healthy",
        checkedAt: new Date("2026-07-26T00:00:00.000Z"),
        reconnectAttempts: 0,
        resumeState: {
          sessionId: "qq-session-1",
          sequence: 501,
        },
      },
    });
    await harness.manager.startAll();
    await harness.manager.refreshHealth(CONNECTION_A);

    expect(harness.healthUpdates.at(-1)).toMatchObject({
      status: "connected",
      detail: {
        gatewaySessionId: "qq-session-1",
        gatewaySequence: 501,
      },
    });
    await harness.manager.shutdown();
  });

  it("does not restart a Gateway after its configured retry limit is exhausted", async () => {
    vi.useFakeTimers();
    const harness = managerHarness({
      health: {
        status: "disconnected",
        checkedAt: new Date("2026-07-26T00:00:00.000Z"),
        reconnectAttempts: 100,
        retryExhausted: true,
        error: {
          code: "network_unreachable",
          detail: "qq_reconnect_exhausted",
        },
      },
    });
    await harness.manager.startAll();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(harness.adapters.get(CONNECTION_A)!.start)
      .toHaveBeenCalledTimes(1);
    expect(harness.healthUpdates.at(-1)).toMatchObject({
      status: "disconnected",
      detail: {
        retryExhausted: true,
        reconnectAttempts: 100,
      },
    });
    await harness.manager.shutdown();
  });

  it("restores a valid Gateway session from persisted health detail", async () => {
    const query = vi.fn(async (sql: string) => {
      void sql;
      return {
        rowCount: 1,
        rows: [{
          id: CONNECTION_A,
          user_id: USER_ID,
          agent_id: AGENT_ID,
          channel_type: "qq",
          enabled: true,
          config: {},
          revision: 1,
          health_detail: {
            gatewaySessionId: "qq-session-1",
            gatewaySequence: 501,
          },
          field_name: null,
          ciphertext: null,
          nonce: null,
          auth_tag: null,
          key_version: null,
        }],
      };
    });
    const store = createPostgresChannelConnectionRuntimeStore(
      { query } as never,
      null,
    );

    await expect(store.listEnabled()).resolves.toEqual([
      expect.objectContaining({
        id: CONNECTION_A,
        resumeState: {
          sessionId: "qq-session-1",
          sequence: 501,
        },
      }),
    ]);
    expect(String(query.mock.calls[0]?.[0]))
      .toContain("connection.health_detail");
  });

  it("waits for every adapter to stop during graceful shutdown", async () => {
    const harness = managerHarness();
    await harness.manager.startAll();
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    harness.adapters.get(CONNECTION_A)!.stop
      .mockImplementationOnce(async () => stopGate);

    let settled = false;
    const firstShutdown = harness.manager.shutdown();
    expect(harness.manager.shutdown()).toBe(firstShutdown);
    const shutdown = firstShutdown.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    releaseStop();
    await shutdown;
    expect(harness.adapters.get(CONNECTION_A)!.stop)
      .toHaveBeenCalledWith("shutdown");
    expect(harness.adapters.get(CONNECTION_B)!.stop)
      .toHaveBeenCalledWith("shutdown");
  });

  it("redacts secrets, URL queries, and raw response bodies", () => {
    const redacted = redactChannelHealthDetail(
      "Authorization: Bearer abc https://host/path?token=secret response body: {\"password\":\"x\"}",
    );

    expect(redacted).not.toContain("abc");
    expect(redacted).not.toContain("token=secret");
    expect(redacted).not.toContain("password");
    expect(redacted).toContain("https://host/path");
  });
});

const CONNECTION_A =
  "20000000-0000-4000-8000-000000000001";
const CONNECTION_B =
  "20000000-0000-4000-8000-000000000002";
const USER_ID =
  "10000000-0000-4000-8000-000000000001";
const AGENT_ID =
  "10000000-0000-4000-8000-000000000011";

function managerHarness(options: {
  health?: ChannelHealth;
} = {}) {
  const connections = new Map<string, RuntimeChannelConnection>([
    [
      CONNECTION_A,
      runtimeConnection(CONNECTION_A, "telegram"),
    ],
    [
      CONNECTION_B,
      runtimeConnection(CONNECTION_B, "slack"),
    ],
  ]);
  const healthUpdates: RuntimeChannelHealthUpdate[] = [];
  let notification:
    | ((input: { connectionId: string; revision: number }) => void)
    | undefined;
  const subscribe = vi.fn(async (
    listener: (
      input: { connectionId: string; revision: number },
    ) => void,
  ) => {
    notification = listener;
    return vi.fn(async () => undefined);
  });
  const store: ChannelConnectionRuntimeStore = {
    listEnabled: vi.fn(async () =>
      [...connections.values()].filter(
        (connection) => connection.enabled,
      )
    ),
    get: vi.fn(async (connectionId) =>
      connections.get(connectionId) ?? null
    ),
    updateHealth: vi.fn(async (_connection, health) => {
      healthUpdates.push(health);
    }),
    subscribe,
  };
  const adapters = new Map<string, ReturnType<typeof fakeAdapter>>();
  const manager = createChannelConnectionManager({
    store,
    createAdapter: (connection) => {
      const existing = adapters.get(connection.id);
      if (existing) return existing;
      const adapter = fakeAdapter(
        connection.channelType,
        options.health,
      );
      adapters.set(connection.id, adapter);
      return adapter;
    },
    now: () => new Date("2026-07-26T00:00:00.000Z"),
    random: () => 0.5,
  });
  return {
    manager,
    connections,
    adapters,
    healthUpdates,
    subscribe,
    notify(input: { connectionId: string; revision: number }) {
      notification?.(input);
    },
  };
}

function runtimeConnection(
  id: string,
  channelType: "telegram" | "slack",
): RuntimeChannelConnection {
  return {
    id,
    scope: {
      userId: USER_ID,
      agentId: AGENT_ID,
    },
    channelType,
    enabled: true,
    revision: 1,
    config: {
      enabled: true,
    },
  };
}

function fakeAdapter(
  channelType: ChannelType,
  health: ChannelHealth = {
    status: "healthy",
    checkedAt: new Date("2026-07-26T00:00:00.000Z"),
    lastConnectedAt:
      new Date("2026-07-26T00:00:00.000Z"),
    reconnectAttempts: 0,
  },
) {
  return {
    manifest: getChannelManifest(channelType),
    validateConfig: vi.fn((config: unknown) =>
      config as Record<string, unknown>
    ),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async (): Promise<void> => undefined),
    health: vi.fn(async () => health),
    normalizeInbound: vi.fn(),
    acknowledge: vi.fn(),
    send: vi.fn(),
    resolveRecipient: vi.fn(),
  } satisfies ChannelAdapter<Record<string, unknown>>;
}
