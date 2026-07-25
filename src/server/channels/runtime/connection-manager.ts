import type { AgentScope } from "@/server/agents/types";
import {
  getChannelManifest,
  isChannelType,
  type ChannelType,
} from "@/server/channels/manifests/catalog";
import type { Pool } from "pg";
import {
  EncryptedSecret,
  type ChannelSecretsKey,
} from "@/server/security/encrypted-secret";

import type { ChannelAdapter } from "./adapter";
import { nextRetryAt } from "./retry";
import type {
  ChannelHealth,
  ChannelHealthErrorCode,
} from "./types";

type MaybePromise<T> = T | Promise<T>;
type ManagedAdapter = Pick<
  ChannelAdapter<Record<string, unknown>>,
  "health" | "start" | "stop" | "validateConfig"
>;

export type RuntimeChannelConnection = Readonly<{
  id: string;
  scope: AgentScope;
  channelType: ChannelType;
  enabled: boolean;
  revision: number;
  config: Readonly<Record<string, unknown>>;
  runtimeError?: Readonly<{
    code: ChannelHealthErrorCode;
    detail: string;
  }>;
}>;

export type ChannelConfigChanged = Readonly<{
  connectionId: string;
  revision: number;
}>;

export type RuntimeChannelHealthStatus =
  | "disabled"
  | "starting"
  | "connected"
  | "degraded"
  | "disconnected"
  | "blocked";

export type RuntimeChannelHealthUpdate = Readonly<{
  status: RuntimeChannelHealthStatus;
  detail: Readonly<{
    checkedAt: string;
    reconnectAttempts: number;
    code?: ChannelHealthErrorCode;
    message?: string;
    nextAttemptAt?: string;
  }>;
  lastConnectedAt?: Date;
  lastDisconnectedAt?: Date;
  lastEventAt?: Date;
}>;

export type ChannelConnectionRuntimeStore = Readonly<{
  listEnabled(): Promise<RuntimeChannelConnection[]>;
  get(connectionId: string): Promise<RuntimeChannelConnection | null>;
  updateHealth(
    connection: RuntimeChannelConnection,
    health: RuntimeChannelHealthUpdate,
  ): Promise<void>;
  subscribe(
    listener: (change: ChannelConfigChanged) => void,
  ): Promise<() => MaybePromise<void>>;
}>;

export class ChannelConnectionError extends Error {
  readonly code: ChannelHealthErrorCode;
  readonly detail: string;

  constructor(input: Readonly<{
    code: ChannelHealthErrorCode;
    detail: string;
  }>) {
    super(input.code);
    this.name = "ChannelConnectionError";
    this.code = input.code;
    this.detail = input.detail;
  }
}

type ConnectionState = {
  connection: RuntimeChannelConnection;
  adapter: ManagedAdapter;
  revision: number;
  phase:
    | "stopped"
    | "starting"
    | "running"
    | "degraded"
    | "stopping";
  reconnectAttempts: number;
  controller: AbortController | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  tail: Promise<void>;
};

export function createChannelConnectionManager(input: Readonly<{
  store: ChannelConnectionRuntimeStore;
  createAdapter(
    connection: RuntimeChannelConnection,
  ): ManagedAdapter;
  now?: () => Date;
  random?: () => number;
  onError?: (
    error: unknown,
    context: Readonly<{
      connectionId?: string;
      operation: string;
    }>,
  ) => void;
}>) {
  const now = input.now ?? (() => new Date());
  const random = input.random ?? Math.random;
  const states = new Map<string, ConnectionState>();
  let closed = false;
  let startPromise: Promise<void> | null = null;
  let shutdownPromise: Promise<void> | null = null;
  let unsubscribe: (() => MaybePromise<void>) | null = null;

  const manager = {
    startAll(): Promise<void> {
      if (closed) {
        return Promise.reject(
          new Error("channel_connection_manager_stopped"),
        );
      }
      if (startPromise) return startPromise;
      startPromise = (async () => {
        unsubscribe = await input.store.subscribe((change) => {
          void manager.onConfigChanged(change).catch((error) => {
            input.onError?.(error, {
              connectionId: change.connectionId,
              operation: "config_changed",
            });
          });
        });
        const connections = await input.store.listEnabled();
        await Promise.all(
          connections.map((connection) =>
            applyConnection(connection, "initial")
          ),
        );
      })();
      return startPromise;
    },

    async onConfigChanged(
      change: ChannelConfigChanged,
    ): Promise<void> {
      if (closed) return;
      validateChange(change);
      const state = states.get(change.connectionId);
      if (state && change.revision <= state.revision) return;

      const connection = await input.store.get(
        change.connectionId,
      );
      if (
        !connection
        || connection.revision < change.revision
      ) {
        return;
      }
      if (state && connection.revision <= state.revision) return;
      await applyConnection(connection, "reconfigure");
    },

    async refreshHealth(connectionId: string): Promise<void> {
      const state = states.get(connectionId);
      if (!state || closed) return;
      await enqueue(state, async () => {
        if (closed || !state.connection.enabled) return;
        try {
          const health = await state.adapter.health();
          await applyAdapterHealth(state, health);
        } catch (error) {
          await handleFailure(state, error);
        }
      });
    },

    shutdown(): Promise<void> {
      if (shutdownPromise) return shutdownPromise;
      closed = true;
      for (const state of states.values()) {
        cancelRetry(state);
        state.controller?.abort(
          new Error("channel_connection_shutdown"),
        );
      }
      shutdownPromise = (async () => {
        const listener = unsubscribe;
        unsubscribe = null;
        if (listener) {
          await Promise.resolve(listener()).catch((error) => {
            input.onError?.(error, {
              operation: "unsubscribe",
            });
          });
        }
        await startPromise?.catch(() => undefined);
        const currentStates = [...states.values()];
        const stopped = await Promise.allSettled(
          currentStates.map((state) =>
            enqueue(state, async () => {
              cancelRetry(state);
              await stopAdapter(state, "shutdown");
            })
          ),
        );
        stopped.forEach((result, index) => {
          if (result.status === "rejected") {
            input.onError?.(result.reason, {
              connectionId:
                currentStates[index]?.connection.id,
              operation: "shutdown",
            });
          }
        });
      })();
      return shutdownPromise;
    },
  };

  return manager;

  async function applyConnection(
    connection: RuntimeChannelConnection,
    reason: "initial" | "reconfigure",
  ): Promise<void> {
    let state = states.get(connection.id);
    if (!state) {
      state = {
        connection,
        adapter: input.createAdapter(connection),
        revision: 0,
        phase: "stopped",
        reconnectAttempts: 0,
        controller: null,
        retryTimer: null,
        tail: Promise.resolve(),
      };
      states.set(connection.id, state);
    }
    await enqueue(state, async () => {
      if (
        closed
        || connection.revision <= state!.revision
      ) {
        return;
      }
      cancelRetry(state!);
      state!.connection = connection;
      state!.revision = connection.revision;
      if (reason === "reconfigure") {
        try {
          await stopAdapter(
            state!,
            connection.enabled ? "reconfigure" : "disabled",
          );
        } catch (error) {
          if (connection.enabled) {
            await handleFailure(state!, error);
          } else {
            await updateHealth(state!, {
              status: "disabled",
              detail: {
                checkedAt: now().toISOString(),
                reconnectAttempts: 0,
              },
            });
          }
          return;
        }
      }
      if (!connection.enabled) {
        state!.phase = "stopped";
        state!.reconnectAttempts = 0;
        await updateHealth(state!, {
          status: "disabled",
          detail: {
            checkedAt: now().toISOString(),
            reconnectAttempts: 0,
          },
        });
        return;
      }
      await startAdapter(state!);
    });
  }

  async function startAdapter(
    state: ConnectionState,
  ): Promise<void> {
    if (closed || !state.connection.enabled) return;
    state.phase = "starting";
    const startedAt = now();
    await updateHealth(state, {
      status: "starting",
      detail: {
        checkedAt: startedAt.toISOString(),
        reconnectAttempts: state.reconnectAttempts,
      },
    });

    const controller = new AbortController();
    state.controller = controller;
    try {
      if (state.connection.runtimeError) {
        throw new ChannelConnectionError(
          state.connection.runtimeError,
        );
      }
      const config = state.adapter.validateConfig(
        state.connection.config,
      );
      await state.adapter.start({
        connectionId: state.connection.id,
        agentId: state.connection.scope.agentId,
        config,
        signal: controller.signal,
        now,
      });
      if (closed) {
        await stopAdapter(state, "shutdown");
        return;
      }
      const health = await state.adapter.health();
      await applyAdapterHealth(state, health);
    } catch (error) {
      if (closed || controller.signal.aborted) return;
      await handleFailure(state, error);
    }
  }

  async function applyAdapterHealth(
    state: ConnectionState,
    health: ChannelHealth,
  ): Promise<void> {
    validateHealth(health);
    const status = mapHealthStatus(
      health.status,
      state.connection.enabled,
    );
    const attempts = status === "connected"
      ? 0
      : Math.max(
          state.reconnectAttempts,
          health.reconnectAttempts,
        );
    state.reconnectAttempts = attempts;
    state.phase = status === "connected"
      ? "running"
      : status === "disabled"
        ? "stopped"
        : "degraded";
    const detail: RuntimeChannelHealthUpdate["detail"] = {
      checkedAt: health.checkedAt.toISOString(),
      reconnectAttempts: attempts,
      ...(health.error
        ? {
            code: health.error.code,
            message: redactChannelHealthDetail(
              health.error.detail,
            ),
          }
        : {}),
      ...(health.nextAttemptAt
        ? {
            nextAttemptAt:
              health.nextAttemptAt.toISOString(),
          }
        : {}),
    };
    await updateHealth(state, {
      status,
      detail,
      ...(health.lastConnectedAt
        ? { lastConnectedAt: health.lastConnectedAt }
        : {}),
      ...(health.lastEventAt
        ? { lastEventAt: health.lastEventAt }
        : {}),
      ...(status === "disconnected"
        ? { lastDisconnectedAt: health.checkedAt }
        : {}),
    });
    if (status === "connected" || status === "disabled") {
      cancelRetry(state);
      return;
    }
    scheduleRetry(
      state,
      health.nextAttemptAt,
    );
  }

  async function handleFailure(
    state: ConnectionState,
    error: unknown,
  ): Promise<void> {
    state.phase = "degraded";
    state.reconnectAttempts += 1;
    const mapped = mapConnectionError(error);
    const checkedAt = now();
    const status = mapped.code === "runtime_prerequisite_missing"
      ? "blocked"
      : "degraded";
    const nextAttempt = status === "blocked"
      ? null
      : nextRetryAt({
          attempt: state.reconnectAttempts,
          now: checkedAt,
          random: random(),
        });
    await updateHealth(state, {
      status,
      detail: {
        checkedAt: checkedAt.toISOString(),
        reconnectAttempts: state.reconnectAttempts,
        code: mapped.code,
        message: mapped.detail,
        ...(nextAttempt
          ? { nextAttemptAt: nextAttempt.toISOString() }
          : {}),
      },
      lastDisconnectedAt: checkedAt,
    });
    if (status === "blocked") {
      cancelRetry(state);
    } else {
      scheduleRetry(state, nextAttempt!);
    }
  }

  function scheduleRetry(
    state: ConnectionState,
    requestedAt?: Date,
  ): void {
    cancelRetry(state);
    if (closed || !state.connection.enabled) return;
    const retryAt = requestedAt ?? nextRetryAt({
      attempt: Math.max(1, state.reconnectAttempts),
      now: now(),
      random: random(),
    });
    const delay = Math.max(0, retryAt.getTime() - now().getTime());
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      void enqueue(state, async () => {
        if (closed || !state.connection.enabled) return;
        try {
          await stopAdapter(state, "reconfigure");
          await startAdapter(state);
        } catch (error) {
          await handleFailure(state, error);
        }
      }).catch((error) => {
        input.onError?.(error, {
          connectionId: state.connection.id,
          operation: "retry",
        });
      });
    }, delay);
    state.retryTimer.unref?.();
  }

  async function stopAdapter(
    state: ConnectionState,
    reason: "disabled" | "reconfigure" | "shutdown",
  ): Promise<void> {
    cancelRetry(state);
    if (state.phase === "stopped") return;
    state.phase = "stopping";
    state.controller?.abort(
      new Error(`channel_connection_${reason}`),
    );
    state.controller = null;
    try {
      await state.adapter.stop(reason);
    } finally {
      state.phase = "stopped";
    }
  }

  async function updateHealth(
    state: ConnectionState,
    health: RuntimeChannelHealthUpdate,
  ): Promise<void> {
    await input.store.updateHealth(state.connection, health);
  }
}

function enqueue(
  state: ConnectionState,
  work: () => Promise<void>,
): Promise<void> {
  const execution = state.tail
    .catch(() => undefined)
    .then(work);
  state.tail = execution.catch(() => undefined);
  return execution;
}

function cancelRetry(state: ConnectionState): void {
  if (state.retryTimer) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
}

function mapHealthStatus(
  status: ChannelHealth["status"],
  enabled: boolean,
): RuntimeChannelHealthStatus {
  if (!enabled) return "disabled";
  switch (status) {
    case "healthy":
      return "connected";
    case "connecting":
      return "starting";
    case "degraded":
      return "degraded";
    case "disconnected":
    case "stopped":
      return "disconnected";
  }
}

function mapConnectionError(error: unknown): {
  code: ChannelHealthErrorCode;
  detail: string;
} {
  if (error instanceof ChannelConnectionError) {
    return {
      code: error.code,
      detail: redactChannelHealthDetail(error.detail),
    };
  }
  return {
    code: "unknown",
    detail: "连接启动失败，等待下一次重试。",
  };
}

export function redactChannelHealthDetail(
  detail: string,
): string {
  const withoutBody = detail.replace(
    /\b(?:(?:platform|raw|response)\s*)?body\s*[:=][\s\S]*$/gi,
    "[响应内容已隐藏]",
  );
  const withoutAuthorization = withoutBody.replace(
    /\bauthorization\s*:\s*[^\s,;]+(?:\s+[^\s,;]+)?/gi,
    "Authorization: [已隐藏]",
  );
  const withoutQueries = withoutAuthorization.replace(
    /https?:\/\/[^\s"'<>]+/gi,
    (candidate) => {
      try {
        const url = new URL(candidate);
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch {
        return "[URL 已隐藏]";
      }
    },
  );
  const withoutSecrets = withoutQueries
    .replace(
      /\b(?:access[_-]?token|api[_-]?key|password|secret|signature|token)\b\s*[:=]\s*[^\s,;]+/gi,
      "[敏感字段已隐藏]",
    )
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim();
  return (withoutSecrets || "连接异常").slice(0, 500);
}

function validateChange(change: ChannelConfigChanged): void {
  if (
    change.connectionId.trim().length === 0
    || change.connectionId.length > 256
    || !Number.isSafeInteger(change.revision)
    || change.revision <= 0
  ) {
    throw new Error("channel_config_notification_invalid");
  }
}

function validateHealth(health: ChannelHealth): void {
  if (
    !Number.isFinite(health.checkedAt.getTime())
    || !Number.isInteger(health.reconnectAttempts)
    || health.reconnectAttempts < 0
    || (
      health.nextAttemptAt
      && !Number.isFinite(health.nextAttemptAt.getTime())
    )
  ) {
    throw new Error("channel_adapter_health_invalid");
  }
}

type RuntimeConnectionRow = {
  id: string;
  user_id: string;
  agent_id: string;
  channel_type: string;
  enabled: boolean;
  config: Record<string, unknown>;
  revision: number;
  field_name: string | null;
  ciphertext: Buffer | null;
  nonce: Buffer | null;
  auth_tag: Buffer | null;
  key_version: number | null;
};

export function createPostgresChannelConnectionRuntimeStore(
  pool: Pool,
  secretKey: ChannelSecretsKey | null,
): ChannelConnectionRuntimeStore {
  return {
    async listEnabled(): Promise<RuntimeChannelConnection[]> {
      return readRuntimeConnections(
        pool,
        secretKey,
        `connection.enabled = true
         AND connection.deleted_at IS NULL`,
        [],
      );
    },

    async get(
      connectionId: string,
    ): Promise<RuntimeChannelConnection | null> {
      const rows = await readRuntimeConnections(
        pool,
        secretKey,
        `connection.id = $1
         AND connection.deleted_at IS NULL`,
        [connectionId],
      );
      return rows[0] ?? null;
    },

    async updateHealth(
      connection,
      health,
    ): Promise<void> {
      const safeDetail = {
        ...health.detail,
        ...(health.detail.message
          ? {
              message: redactChannelHealthDetail(
                health.detail.message,
              ),
            }
          : {}),
      };
      const result = await pool.query(
        `UPDATE channel_connections
         SET health_status = $5,
             health_detail = $6::jsonb,
             last_connected_at =
               COALESCE($7, last_connected_at),
             last_disconnected_at =
               COALESCE($8, last_disconnected_at),
             last_event_at =
               COALESCE($9, last_event_at),
             updated_at = now()
         WHERE id = $1
           AND user_id = $2
           AND agent_id = $3
           AND revision = $4
           AND deleted_at IS NULL`,
        [
          connection.id,
          connection.scope.userId,
          connection.scope.agentId,
          connection.revision,
          health.status,
          JSON.stringify(safeDetail),
          health.lastConnectedAt ?? null,
          health.lastDisconnectedAt ?? null,
          health.lastEventAt ?? null,
        ],
      );
      if (result.rowCount !== 1) {
        throw new Error("channel_connection_health_stale");
      }
    },

    async subscribe(listener) {
      const client = await pool.connect();
      let released = false;
      const onNotification = (
        notification: Readonly<{
          channel: string;
          payload?: string;
        }>,
      ) => {
        if (
          notification.channel !== "channel_config_changed"
          || notification.payload === undefined
        ) {
          return;
        }
        const change = parseConfigNotification(
          notification.payload,
        );
        if (change) listener(change);
      };
      client.on("notification", onNotification);
      try {
        await client.query("LISTEN channel_config_changed");
      } catch (error) {
        client.removeListener("notification", onNotification);
        client.release(true);
        throw error;
      }
      return async () => {
        if (released) return;
        released = true;
        client.removeListener("notification", onNotification);
        let destroy = false;
        try {
          await client.query(
            "UNLISTEN channel_config_changed",
          );
        } catch {
          destroy = true;
        }
        client.release(destroy);
      };
    },
  };
}

async function readRuntimeConnections(
  pool: Pool,
  secretKey: ChannelSecretsKey | null,
  predicate: string,
  parameters: readonly unknown[],
): Promise<RuntimeChannelConnection[]> {
  const result = await pool.query<RuntimeConnectionRow>(
    `SELECT connection.id, connection.user_id,
            connection.agent_id, connection.channel_type,
            connection.enabled, connection.config,
            connection.revision, secret.field_name,
            secret.ciphertext, secret.nonce,
            secret.auth_tag, secret.key_version
     FROM channel_connections AS connection
     LEFT JOIN channel_secrets AS secret
       ON secret.connection_id = connection.id
     WHERE ${predicate}
     ORDER BY connection.id, secret.field_name`,
    [...parameters],
  );
  const grouped = new Map<
    string,
    {
      row: RuntimeConnectionRow;
      secrets: RuntimeConnectionRow[];
    }
  >();
  for (const row of result.rows) {
    const value = grouped.get(row.id) ?? {
      row,
      secrets: [],
    };
    if (row.field_name !== null) value.secrets.push(row);
    grouped.set(row.id, value);
  }
  return [...grouped.values()].map(({ row, secrets }) =>
    materializeRuntimeConnection(row, secrets, secretKey)
  );
}

function materializeRuntimeConnection(
  row: RuntimeConnectionRow,
  secrets: readonly RuntimeConnectionRow[],
  secretKey: ChannelSecretsKey | null,
): RuntimeChannelConnection {
  if (!isChannelType(row.channel_type)) {
    throw new Error("channel_connection_type_invalid");
  }
  const scope = {
    userId: row.user_id,
    agentId: row.agent_id,
  };
  const config: Record<string, unknown> = {
    ...row.config,
    enabled: row.enabled,
  };
  let runtimeError:
    | RuntimeChannelConnection["runtimeError"]
    | undefined;
  const declaredSecrets = new Set(
    getChannelManifest(row.channel_type).secretFields,
  );
  for (const secret of secrets) {
    if (
      !secret.field_name
      || !declaredSecrets.has(secret.field_name)
      || !secret.ciphertext
      || !secret.nonce
      || !secret.auth_tag
      || !secret.key_version
    ) {
      runtimeError = {
        code: "runtime_prerequisite_missing",
        detail: "渠道凭据存储记录无效。",
      };
      continue;
    }
    if (!secretKey) {
      runtimeError = {
        code: "runtime_prerequisite_missing",
        detail: "渠道凭据解密密钥不可用。",
      };
      continue;
    }
    try {
      const encrypted = EncryptedSecret.fromStorage({
        ciphertext: secret.ciphertext,
        nonce: secret.nonce,
        authTag: secret.auth_tag,
        keyVersion: secret.key_version,
      });
      config[secret.field_name] = secretKey.decrypt(
        encrypted,
        {
          ...scope,
          connectionId: row.id,
          fieldName: secret.field_name,
        },
      );
    } catch {
      runtimeError = {
        code: "runtime_prerequisite_missing",
        detail: "渠道凭据无法解密。",
      };
    }
  }
  return {
    id: row.id,
    scope,
    channelType: row.channel_type,
    enabled: row.enabled,
    revision: Number(row.revision),
    config,
    ...(runtimeError ? { runtimeError } : {}),
  };
}

function parseConfigNotification(
  payload: string,
): ChannelConfigChanged | null {
  if (Buffer.byteLength(payload, "utf8") > 4_096) return null;
  try {
    const value = JSON.parse(payload) as unknown;
    if (
      typeof value !== "object"
      || value === null
      || !("connection_id" in value)
      || typeof value.connection_id !== "string"
      || !("revision" in value)
      || !Number.isSafeInteger(value.revision)
      || Number(value.revision) <= 0
    ) {
      return null;
    }
    return {
      connectionId: value.connection_id,
      revision: Number(value.revision),
    };
  } catch {
    return null;
  }
}
