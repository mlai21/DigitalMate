import { describe, expect, it, vi } from "vitest";

import type { AdminCompatRuntime } from "@/server/admin/compat/router";
import {
  createCoreAdminCompatRouter,
  type CoreAdminCompatDependencies,
} from "@/server/admin/compat/register-core";
import type { AdminCompatResources } from "@/server/admin/compat/types";
import type {
  AdminChannelConfigBatchWriter,
  AdminChannelConfigReader,
  AdminChannelConfigWriter,
} from "@/server/admin/compat/handlers/channels";
import { createAdminAuthStatusResponse } from "@/server/admin/compat/security";
import { CHANNEL_TYPES } from "@/server/channels/manifests/catalog";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_ID = "10000000-0000-4000-8000-000000000011";
const OPERATION_ID = "30000000-0000-4000-8000-000000000031";

const readChannels: AdminChannelConfigReader = async () =>
  Object.fromEntries(
    CHANNEL_TYPES.map((type) => [
      type,
      {
        type,
        enabled: false,
        revision: 0,
        config: {
          bot_prefix: "",
          filter_tool_messages: true,
          filter_thinking: true,
        },
        secrets: {},
        health: {
          status: "disabled",
          detail: {},
        },
      },
    ]),
  ) as unknown as Awaited<ReturnType<AdminChannelConfigReader>>;

function dependencies(
  overrides: Partial<CoreAdminCompatDependencies> = {},
): CoreAdminCompatDependencies {
  return {
    createAuthStatusResponse: async () =>
      Response.json({ authenticated: true }),
    digitalMateVersion: "0.1.0",
    upstreamTag: "v2.0.0.post3",
    upstreamCommit:
      "fef7e64d984f4332d0b84a343cd209bd3ea5d316",
    compatApiRevision: "test",
    readChannelConfigs: readChannels,
    updateChannelConfig: vi.fn(),
    updateChannelConfigs: vi.fn(),
    ...overrides,
  };
}

function runtime(): AdminCompatRuntime {
  return {
    security: {
      defaultUserId: USER_ID,
      appSecret: "test-app-secret-for-channel-contract",
      appPasswordEnabled: false,
      production: false,
      trustProxyHeaders: false,
      loadSessionGeneration: async () => 0,
    },
    withUserDataLease: async (_userId, work) =>
      work({} as AdminCompatResources, new AbortController().signal),
    resolveDefaultScope: async () => ({
      userId: USER_ID,
      agentId: AGENT_ID,
    }),
  };
}

async function request(
  path: string,
  options: { method?: string; body?: unknown; agent?: string | null } = {},
): Promise<Request> {
  const headers = new Headers();
  if (options.agent !== null) {
    headers.set("x-digitalmate-agent-id", options.agent ?? AGENT_ID);
  }
  if (options.body !== undefined) {
    const status = await createAdminAuthStatusResponse(
      new Request("http://localhost/api/admin/compat/auth/status"),
      runtime().security,
    );
    const { csrf_token } = (await status.json()) as {
      csrf_token: string;
    };
    headers.set("content-type", "application/json");
    headers.set("origin", "http://localhost");
    headers.set("x-csrf-token", csrf_token);
  }
  return new Request(`http://localhost/api/admin/compat${path}`, {
    method: options.method,
    headers,
    body:
      options.body === undefined
        ? undefined
        : JSON.stringify(options.body),
  });
}

describe("admin compatibility channel contract", () => {
  it("returns the fixed 17 types and built-in strict schemas", async () => {
    const router = createCoreAdminCompatRouter(dependencies());
    const types = await router.dispatch(
      await request("/config/channels/types"),
      runtime(),
    );
    const schemas = await router.dispatch(
      await request("/config/channels/schemas"),
      runtime(),
    );

    expect(await types.json()).toEqual(CHANNEL_TYPES);
    expect(Object.keys(await schemas.json())).toEqual(CHANNEL_TYPES);
  });

  it("requires the canonical default-agent header on every channel route", async () => {
    const router = createCoreAdminCompatRouter(dependencies());
    const response = await router.dispatch(
      await request("/config/channels", { agent: null }),
      runtime(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "invalid_request",
        message: "agent_header_required",
      },
    });
  });

  it("lists virtual revision-zero defaults without plaintext secrets", async () => {
    const router = createCoreAdminCompatRouter(dependencies());
    const response = await router.dispatch(
      await request("/config/channels"),
      runtime(),
    );
    const body = (await response.json()) as Record<
      string,
      Record<string, unknown>
    >;

    expect(response.status).toBe(200);
    expect(body.telegram).toMatchObject({
      enabled: false,
      revision: 0,
      isBuiltin: true,
      filter_tool_messages: true,
      filter_thinking: true,
      health: { status: "disabled" },
      bot_token: { configured: false, lastRotatedAt: null },
    });
    expect(JSON.stringify(body)).not.toContain("ciphertext");
  });

  it("gets only an approved channel and fails closed for console", async () => {
    const router = createCoreAdminCompatRouter(dependencies());
    const valid = await router.dispatch(
      await request("/config/channels/telegram"),
      runtime(),
    );
    const invalid = await router.dispatch(
      await request("/config/channels/console"),
      runtime(),
    );

    expect(valid.status).toBe(200);
    expect(invalid.status).toBe(404);
  });

  it("turns a save into a typed secret change without ever returning its value", async () => {
    const update = vi.fn<AdminChannelConfigWriter>(
      async (input) => ({
        type: input.type,
        enabled: input.enabled,
        revision: 1,
        config: input.config,
        secrets: {
          bot_token: {
            configured: true,
            lastRotatedAt: "2026-07-25T00:00:00.000Z",
          },
          http_proxy_auth: {
            configured: false,
            lastRotatedAt: null,
          },
        },
        health: {
          status: "blocked",
          detail: { code: "runtime_not_implemented" },
        },
      }),
    );
    const router = createCoreAdminCompatRouter(
      dependencies({ updateChannelConfig: update }),
    );
    const response = await router.dispatch(
      await request("/config/channels/telegram", {
        method: "PUT",
        body: {
          operation_id: OPERATION_ID,
          revision: 0,
          enabled: true,
          bot_token: "a-secret-token",
          http_proxy_auth: "",
          clear_secret: [],
        },
      }),
      runtime(),
    );

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { userId: USER_ID, agentId: AGENT_ID },
        type: "telegram",
        operationId: OPERATION_ID,
        expectedRevision: 0,
        enabled: true,
        secretChanges: [
          {
            fieldName: "bot_token",
            operation: "set",
            value: "a-secret-token",
          },
        ],
      }),
      expect.any(AbortSignal),
    );
    const serialized = JSON.stringify(await response.json());
    expect(serialized).not.toContain("a-secret-token");
    expect(serialized).toContain('"configured":true');
  });

  it("uses explicit clear_secret and rejects conflicting set/clear", async () => {
    const update = vi.fn<AdminChannelConfigWriter>(async (input) => ({
      type: input.type,
      enabled: input.enabled,
      revision: input.expectedRevision + 1,
      config: input.config,
      secrets: {},
      health: { status: "disabled", detail: {} },
    }));
    const router = createCoreAdminCompatRouter(
      dependencies({ updateChannelConfig: update }),
    );
    const cleared = await router.dispatch(
      await request("/config/channels/telegram", {
        method: "PUT",
        body: {
          operation_id: OPERATION_ID,
          revision: 1,
          clear_secret: ["bot_token"],
        },
      }),
      runtime(),
    );
    const conflicting = await router.dispatch(
      await request("/config/channels/telegram", {
        method: "PUT",
        body: {
          operation_id: OPERATION_ID,
          revision: 1,
          bot_token: "new-token",
          clear_secret: ["bot_token"],
        },
      }),
      runtime(),
    );

    expect(cleared.status).toBe(200);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        secretChanges: [
          { fieldName: "bot_token", operation: "delete" },
        ],
      }),
      expect.any(AbortSignal),
    );
    expect(conflicting.status).toBe(400);
  });

  it("rejects unknown, nested secret and prototype-like keys without value reflection", async () => {
    const router = createCoreAdminCompatRouter(dependencies());
    const secret = "must-not-appear-in-errors";
    const attempts = [
      { unknown: secret },
      { bot_prefix: { bot_token: secret } },
      JSON.parse(`{"__proto__":{"bot_token":"${secret}"}}`) as unknown,
    ];

    for (const partial of attempts) {
      const response = await router.dispatch(
        await request("/config/channels/telegram", {
          method: "PUT",
          body: {
            operation_id: OPERATION_ID,
            revision: 0,
            ...(partial as object),
          },
        }),
        runtime(),
      );
      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).not.toContain(secret);
    }
  });

  it("enforces the strict 16 KiB body limit before validation", async () => {
    const router = createCoreAdminCompatRouter(dependencies());
    const response = await router.dispatch(
      await request("/config/channels/telegram", {
        method: "PUT",
        body: {
          operation_id: OPERATION_ID,
          revision: 0,
          bot_prefix: "x".repeat(16 * 1024),
        },
      }),
      runtime(),
    );

    expect(response.status).toBe(413);
  });

  it("supports the upstream complete-channel PUT shape after validating every entry", async () => {
    const update = vi.fn<AdminChannelConfigBatchWriter>(
      async (inputs) =>
        Object.fromEntries(
          inputs.map((input) => [
            input.type,
            {
              type: input.type,
              enabled: input.enabled,
              revision: input.expectedRevision + 1,
              config: input.config,
              secrets: {},
              health: {
                status: input.enabled ? "blocked" : "disabled",
                detail: input.enabled
                  ? { code: "runtime_not_implemented" }
                  : {},
              },
            },
          ]),
        ) as unknown as Awaited<
          ReturnType<AdminChannelConfigBatchWriter>
        >,
    );
    const router = createCoreAdminCompatRouter(
      dependencies({ updateChannelConfigs: update }),
    );
    const body = Object.fromEntries(
      CHANNEL_TYPES.map((type, index) => [
        type,
        {
          operation_id:
            `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          revision: 0,
          enabled: false,
        },
      ]),
    );
    const response = await router.dispatch(
      await request("/config/channels", {
        method: "PUT",
        body,
      }),
      runtime(),
    );

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[0]).toHaveLength(17);
    expect(Object.keys(await response.json())).toEqual(CHANNEL_TYPES);
  });
});
