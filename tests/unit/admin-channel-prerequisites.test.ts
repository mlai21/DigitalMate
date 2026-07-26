import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  createAdminChannelHealthResolver,
} from "@/server/admin/channel-prerequisites";
import type {
  AdminChannelConfigSnapshot,
} from "@/server/admin/compat/handlers/channels";
import type {
  ChannelType,
} from "@/server/channels/manifests/catalog";

const scope = {
  userId: "10000000-0000-4000-8000-000000000001",
  agentId: "10000000-0000-4000-8000-000000000011",
};

function snapshot(
  type: ChannelType,
  overrides: Partial<AdminChannelConfigSnapshot> = {},
): AdminChannelConfigSnapshot {
  return {
    type,
    enabled: true,
    revision: 1,
    config: {},
    secrets: {},
    health: {
      status: "starting",
      detail: {},
    },
    ...overrides,
  };
}

describe("special channel prerequisites", () => {
  it.each([
    ["imessage", "macos_node_required"],
    ["sip", "media_node_required"],
  ] as const)(
    "blocks %s without a live compatible node",
    async (type, reason) => {
      const pool = {
        query: vi.fn(async () => ({
          rows: [{
            id: "20000000-0000-4000-8000-000000000021",
            node_id: null,
            node_status: null,
            last_heartbeat_at: null,
            supported_channel_types: null,
          }],
        })),
      } as unknown as Pool;
      const resolve = createAdminChannelHealthResolver(
        pool,
        {
          publicBaseUrl: "https://mate.example.com",
          now: () =>
            new Date("2026-07-27T00:00:30.000Z"),
        },
      );

      await expect(
        resolve(scope, type, snapshot(type)),
      ).resolves.toMatchObject({
        status: "blocked",
        reason,
      });
    },
  );

  it.each(["imessage", "sip"] as const)(
    "accepts %s only while its compatible node heartbeat is fresh",
    async (type) => {
      const query = vi.fn(async () => ({
        rows: [{
          id: "20000000-0000-4000-8000-000000000021",
          node_id: "20000000-0000-4000-8000-000000000022",
          node_status: "connected",
          last_heartbeat_at:
            "2026-07-27T00:00:00.000Z",
          supported_channel_types: [type],
        }],
      }));
      const pool = { query } as unknown as Pool;
      const resolve = createAdminChannelHealthResolver(
        pool,
        {
          publicBaseUrl: "https://mate.example.com",
          now: () =>
            new Date("2026-07-27T00:00:30.000Z"),
        },
      );

      await expect(
        resolve(scope, type, snapshot(type)),
      ).resolves.toEqual({
        status: "starting",
        detail: {},
      });
      expect(query).toHaveBeenCalledTimes(1);
    },
  );

  it("requires HTTPS and complete Twilio credentials for Voice", async () => {
    const pool = {
      query: vi.fn(),
    } as unknown as Pool;
    const withoutHttps =
      createAdminChannelHealthResolver(pool, {
        publicBaseUrl: "http://localhost:3000",
      });
    const withHttps =
      createAdminChannelHealthResolver(pool, {
        publicBaseUrl: "https://mate.example.com",
      });
    const configured = snapshot("voice", {
      config: {
        twilio_account_sid: "AC123",
        phone_number: "+8613800000000",
        phone_number_sid: "PN123",
      },
      secrets: {
        twilio_auth_token: {
          configured: true,
          lastRotatedAt: "2026-07-27T00:00:00.000Z",
        },
      },
    });

    await expect(
      withoutHttps(scope, "voice", configured),
    ).resolves.toMatchObject({
      status: "blocked",
      reason: "public_https_required",
    });
    await expect(
      withHttps(scope, "voice", snapshot("voice")),
    ).resolves.toMatchObject({
      status: "blocked",
      reason: "twilio_configuration_required",
    });
    await expect(
      withHttps(scope, "voice", configured),
    ).resolves.toEqual({
      status: "starting",
      detail: {},
    });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("requires a live OneBot companion socket", async () => {
    const connectionId =
      "20000000-0000-4000-8000-000000000021";
    const pool = {
      query: vi.fn(async () => ({
        rows: [{
          id: connectionId,
          node_id: null,
          node_status: null,
          last_heartbeat_at: null,
          supported_channel_types: null,
        }],
      })),
    } as unknown as Pool;
    const disconnected =
      createAdminChannelHealthResolver(pool, {
        publicBaseUrl: "https://mate.example.com",
        isOneBotConnected: () => false,
      });
    const connected =
      createAdminChannelHealthResolver(pool, {
        publicBaseUrl: "https://mate.example.com",
        isOneBotConnected: (candidate) =>
          candidate === connectionId,
      });

    await expect(
      disconnected(scope, "onebot", snapshot("onebot")),
    ).resolves.toMatchObject({
      status: "blocked",
      reason: "companion_service_required",
    });
    await expect(
      connected(scope, "onebot", snapshot("onebot")),
    ).resolves.toEqual({
      status: "starting",
      detail: {},
    });
  });
});
