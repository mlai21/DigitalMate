import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import { createAdminChannelConfigService } from "@/server/admin/channel-config";
import type {
  AdminChannelConfigWrite,
} from "@/server/admin/compat/handlers/channels";
import {
  CHANNEL_TYPES,
} from "@/server/channels/manifests/catalog";
import {
  createChannelSecretsKey,
} from "@/server/security/encrypted-secret";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_ID = "10000000-0000-4000-8000-000000000011";
const KEY_STATE = createChannelSecretsKey(
  Buffer.alloc(32, 43).toString("base64"),
);

describe("admin channel config transaction states", () => {
  it("destroys a read client when BEGIN has an unknown outcome", async () => {
    const query = vi.fn(async (sql: unknown) => {
      if (String(sql) === "BEGIN") {
        throw new Error("begin_response_lost");
      }
      return { rows: [] };
    });
    const release = vi.fn();
    const service = createAdminChannelConfigService(
      poolWithClient(query, release),
      null,
    );

    await expect(
      service.read({ userId: USER_ID, agentId: AGENT_ID }),
    ).rejects.toThrow();
    expect(query.mock.calls.map(([sql]) => String(sql)))
      .not.toContain("ROLLBACK");
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(true);
  });

  it("destroys a read client when rollback fails", async () => {
    const query = vi.fn(async (sql: unknown) => {
      const text = String(sql);
      if (text === "ROLLBACK") {
        throw new Error("rollback_response_lost");
      }
      if (text.startsWith("SET LOCAL lock_timeout")) {
        throw new Error("primary_read_failure");
      }
      return { rows: [] };
    });
    const release = vi.fn();
    const service = createAdminChannelConfigService(
      poolWithClient(query, release),
      null,
    );

    await expect(
      service.read({ userId: USER_ID, agentId: AGENT_ID }),
    ).rejects.toThrow("primary_read_failure");
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(true);
  });

  it("destroys a read client when COMMIT has an unknown outcome", async () => {
    const query = vi.fn(async (sql: unknown) => {
      if (String(sql) === "COMMIT") {
        throw new Error("commit_response_lost");
      }
      return { rows: [] };
    });
    const release = vi.fn();
    const service = createAdminChannelConfigService(
      poolWithClient(query, release),
      null,
    );

    await expect(
      service.read({ userId: USER_ID, agentId: AGENT_ID }),
    ).rejects.toThrow();
    expect(query.mock.calls.map(([sql]) => String(sql)))
      .not.toContain("ROLLBACK");
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(true);
  });

  it.each([
    ["single", false],
    ["bulk", true],
  ] as const)(
    "destroys a %s write client when BEGIN has an unknown outcome",
    async (_label, bulk) => {
      if (KEY_STATE.status !== "ready") throw new Error("key_not_ready");
      const query = vi.fn(async (sql: unknown) => {
        if (String(sql) === "BEGIN") {
          throw new Error("begin_response_lost");
        }
        return { rows: [] };
      });
      const release = vi.fn();
      const service = createAdminChannelConfigService(
        poolWithClient(query, release),
        KEY_STATE.key,
      );

      const pending = bulk
        ? service.updateMany(bulkInputs())
        : service.update(singleInput());
      await expect(pending).rejects.toThrow();
      expect(query.mock.calls.map(([sql]) => String(sql)))
        .not.toContain("ROLLBACK");
      expect(release).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledWith(true);
    },
  );

  it.each([
    ["single", false],
    ["bulk", true],
  ] as const)(
    "destroys a %s write client when rollback fails",
    async (_label, bulk) => {
      if (KEY_STATE.status !== "ready") throw new Error("key_not_ready");
      const query = vi.fn(async (sql: unknown) => {
        const text = String(sql);
        if (text === "ROLLBACK") {
          throw new Error("rollback_response_lost");
        }
        if (text.startsWith("SET LOCAL lock_timeout")) {
          throw new Error("primary_write_failure");
        }
        return { rows: [] };
      });
      const release = vi.fn();
      const service = createAdminChannelConfigService(
        poolWithClient(query, release),
        KEY_STATE.key,
      );

      const pending = bulk
        ? service.updateMany(bulkInputs())
        : service.update(singleInput());
      await expect(pending).rejects.toThrow("primary_write_failure");
      expect(release).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledWith(true);
    },
  );
});

function singleInput(): AdminChannelConfigWrite {
  return {
    scope: { userId: USER_ID, agentId: AGENT_ID },
    type: "telegram",
    operationId: "30000000-0000-4000-8000-000000000001",
    expectedRevision: 0,
    enabled: false,
    config: {},
    secretChanges: [],
  };
}

function bulkInputs(): AdminChannelConfigWrite[] {
  return CHANNEL_TYPES.map((type, index) => ({
    scope: { userId: USER_ID, agentId: AGENT_ID },
    type,
    operationId:
      `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    expectedRevision: 0,
    enabled: false,
    config: {},
    secretChanges: [],
  }));
}

function poolWithClient(
  query: ReturnType<typeof vi.fn>,
  release: ReturnType<typeof vi.fn>,
): Pool {
  return {
    connect: vi.fn(async () => ({
      query,
      release,
    } as unknown as PoolClient)),
  } as unknown as Pool;
}
