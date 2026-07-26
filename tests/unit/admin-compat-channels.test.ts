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
import {
  ChannelAdapterRegistry,
  registerNodeProxyChannelAdapters,
  registerProtocolChannelAdapters,
  registerStandardChannelAdapters,
} from "@/server/channels/runtime/registry";
import {
  createWechatQrAuthService,
} from "@/server/admin/wechat-qrcode";
import {
  WechatTransportError,
} from "@/server/channels/adapters/wechat/client";

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
  it("registers every M4-A standard channel adapter exactly once", () => {
    const registry = new ChannelAdapterRegistry();

    registerStandardChannelAdapters(registry);

    expect(registry.registeredTypes()).toEqual(
      expect.arrayContaining([
        "telegram",
        "discord",
        "slack",
        "mattermost",
        "feishu",
        "dingtalk",
        "qq",
      ]),
    );
    expect(registry.registeredTypes()).toHaveLength(7);
    expect(() => registerStandardChannelAdapters(registry)).toThrow(
      "duplicate_channel_adapter:telegram",
    );
  });

  it("registers every protocol and gateway channel adapter exactly once", () => {
    const registry = new ChannelAdapterRegistry();

    registerProtocolChannelAdapters(registry);

    expect(registry.registeredTypes()).toEqual([
      "mqtt",
      "matrix",
      "voice",
      "wecom",
      "xiaoyi",
      "yuanbao",
      "wechat",
      "onebot",
    ]);
    expect(() => registerProtocolChannelAdapters(registry)).toThrow(
      "duplicate_channel_adapter:mqtt",
    );
  });

  it("registers iMessage and SIP as node proxies instead of server-local adapters", () => {
    const registry = new ChannelAdapterRegistry();

    registerNodeProxyChannelAdapters(registry);

    expect(registry.registeredTypes()).toEqual([
      "imessage",
      "sip",
    ]);
    expect(() =>
      registerNodeProxyChannelAdapters(registry)
    ).toThrow("duplicate_channel_adapter:imessage");
  });

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
    const schemaBody = (await schemas.json()) as Record<
      string,
      {
        config_fields: Array<{
          name: string;
          default: unknown;
          type: string;
        }>;
      }
    >;
    expect(Object.keys(schemaBody)).toEqual(CHANNEL_TYPES);
    expect(
      schemaBody.slack.config_fields.find(
        (field) => field.name === "allow_from",
      )?.default,
    ).toBeNull();

    const expectedProtocolSecrets = {
      mqtt: ["password", "tls_keyfile"],
      matrix: ["access_token", "password"],
      wecom: ["secret"],
      xiaoyi: ["sk"],
      yuanbao: ["app_secret"],
      wechat: ["bot_token", "bot_token_file"],
    } as const;
    for (const [channel, expected] of Object.entries(
      expectedProtocolSecrets,
    )) {
      expect(
        schemaBody[channel].config_fields
          .filter((field) => field.type === "password")
          .map((field) => field.name),
      ).toEqual(expected);
    }
  });

  it("stores confirmed WeChat QR credentials without returning plaintext", async () => {
    const update = vi.fn<AdminChannelConfigWriter>(
      async (input) => ({
        type: input.type,
        enabled: input.enabled,
        revision: input.expectedRevision + 1,
        config: input.config,
        secrets: {
          bot_token: {
            configured: true,
            lastRotatedAt:
              "2026-07-26T00:00:00.000Z",
          },
        },
        health: { status: "disabled", detail: {} },
      }),
    );
    const client = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      getQrCode: vi.fn(async () => ({
        qrcode: "platform-qrcode-secret",
        qrcode_img_content:
          Buffer.from("png-fixture").toString("base64"),
      })),
      getQrCodeStatus: vi.fn(async () => ({
        status: "confirmed",
        bot_token: "wechat-confirmed-secret",
        baseurl: "https://ilinkai.weixin.qq.com",
      })),
      getUpdates: vi.fn(),
      sendText: vi.fn(),
      getConfig: vi.fn(),
      sendTyping: vi.fn(),
    };
    const qrAuth = createWechatQrAuthService({
      hmacKey: "test-wechat-qr-hmac-key",
      readChannels,
      updateChannel: update,
      clientFactory: () => client,
      randomToken: () =>
        "abcdefghijklmnopqrstuvwxyzABCDEF0123456789_-",
    });
    const router = createCoreAdminCompatRouter(
      dependencies({
        updateChannelConfig: update,
        wechatQrAuth: qrAuth,
      }),
    );
    const qrResponse = await router.dispatch(
      await request("/config/channels/wechat/qrcode"),
      runtime(),
    );
    const qr = await qrResponse.json() as {
      poll_token: string;
    };
    expect(JSON.stringify(qr)).not.toContain(
      "platform-qrcode-secret",
    );

    const statusResponse = await router.dispatch(
      await request(
        `/config/channels/wechat/qrcode/status?token=${
          encodeURIComponent(qr.poll_token)
        }`,
      ),
      runtime(),
    );
    const serialized = JSON.stringify(
      await statusResponse.json(),
    );
    expect(statusResponse.status).toBe(200);
    expect(JSON.parse(serialized)).toMatchObject({
      status: "confirmed",
      credentials: {
        bot_token: "configured",
        base_url: "https://ilinkai.weixin.qq.com",
      },
    });
    expect(serialized).not.toContain(
      "wechat-confirmed-secret",
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "wechat",
        secretChanges: [{
          fieldName: "bot_token",
          operation: "set",
          value: "wechat-confirmed-secret",
        }],
      }),
      expect.any(AbortSignal),
    );

    const replay = await router.dispatch(
      await request(
        `/config/channels/wechat/qrcode/status?token=${
          encodeURIComponent(qr.poll_token)
        }`,
      ),
      runtime(),
    );
    await expect(replay.json()).resolves.toEqual({
      status: "expired",
    });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("preserves WeChat QR waiting/scanned/expired states and reports eligibility blocks", async () => {
    const update = vi.fn<AdminChannelConfigWriter>();
    const statuses = ["waiting", "scanned", "expired"];
    const client = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      getQrCode: vi.fn(async () => ({
        qrcode: "platform-qrcode-secret",
        qrcode_img_content:
          Buffer.from("png-fixture").toString("base64"),
      })),
      getQrCodeStatus: vi.fn(async () => ({
        status: statuses.shift(),
      })),
      getUpdates: vi.fn(),
      sendText: vi.fn(),
      getConfig: vi.fn(),
      sendTyping: vi.fn(),
    };
    const qrAuth = createWechatQrAuthService({
      hmacKey: "test-wechat-qr-hmac-key",
      readChannels,
      updateChannel: update,
      clientFactory: () => client,
      randomToken: () =>
        "abcdefghijklmnopqrstuvwxyzABCDEF0123456789_-",
    });
    const router = createCoreAdminCompatRouter(
      dependencies({
        wechatQrAuth: qrAuth,
      }),
    );
    const created = await router.dispatch(
      await request("/config/channels/wechat/qrcode"),
      runtime(),
    );
    const { poll_token: pollToken } =
      await created.json() as { poll_token: string };
    for (const expected of [
      "waiting",
      "scanned",
      "expired",
    ]) {
      const response = await router.dispatch(
        await request(
          `/config/channels/wechat/qrcode/status?token=${
            encodeURIComponent(pollToken)
          }`,
        ),
        runtime(),
      );
      await expect(response.json()).resolves.toEqual({
        status: expected,
      });
    }
    expect(update).not.toHaveBeenCalled();

    const blocked = createWechatQrAuthService({
      hmacKey: "test-wechat-qr-hmac-key",
      readChannels,
      updateChannel: update,
      clientFactory: () => ({
        ...client,
        getQrCode: vi.fn(async () => {
          throw new WechatTransportError({
            code: "permission_denied",
            retryable: false,
            detail: "wechat_http_403",
          });
        }),
      }),
    });
    const blockedRouter = createCoreAdminCompatRouter(
      dependencies({ wechatQrAuth: blocked }),
    );
    const blockedResponse = await blockedRouter.dispatch(
      await request("/config/channels/wechat/qrcode"),
      runtime(),
    );
    expect(blockedResponse.status).toBe(409);
    await expect(blockedResponse.json()).resolves.toEqual({
      error: {
        code: "channel_blocked",
        message: "wechat_ilink_eligibility_required",
      },
    });
  });

  it("expires a WeChat QR login session locally after five minutes", async () => {
    let current = Date.parse("2026-07-26T00:00:00.000Z");
    const getQrCodeStatus = vi.fn(async () => ({
      status: "confirmed",
      bot_token: "must-not-be-read-after-expiry",
    }));
    const qrAuth = createWechatQrAuthService({
      hmacKey: "test-wechat-qr-hmac-key",
      readChannels,
      updateChannel: vi.fn(),
      now: () => new Date(current),
      randomToken: () =>
        "abcdefghijklmnopqrstuvwxyzABCDEF0123456789_-",
      clientFactory: () => ({
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        getQrCode: vi.fn(async () => ({
          qrcode: "platform-qrcode-secret",
          qrcode_img_content:
            Buffer.from("png-fixture").toString("base64"),
        })),
        getQrCodeStatus,
        getUpdates: vi.fn(),
        sendText: vi.fn(),
        getConfig: vi.fn(),
        sendTyping: vi.fn(),
      }),
    });
    const created = await qrAuth.create({
      userId: USER_ID,
      agentId: AGENT_ID,
    });
    current += 5 * 60 * 1_000 + 1;

    await expect(qrAuth.poll({
      userId: USER_ID,
      agentId: AGENT_ID,
    }, created.poll_token)).resolves.toEqual({
      status: "expired",
    });
    expect(getQrCodeStatus).not.toHaveBeenCalled();
  });

  it("rejects a WeChat confirmation that crosses the five-minute deadline in flight", async () => {
    let current = Date.parse("2026-07-26T00:00:00.000Z");
    let confirm:
      | ((value: Readonly<Record<string, unknown>>) => void)
      | undefined;
    const getQrCodeStatus = vi.fn(() =>
      new Promise<Readonly<Record<string, unknown>>>(
        (resolve) => {
          confirm = resolve;
        },
      ));
    const update = vi.fn<AdminChannelConfigWriter>();
    const qrAuth = createWechatQrAuthService({
      hmacKey: "test-wechat-qr-hmac-key",
      readChannels,
      updateChannel: update,
      now: () => new Date(current),
      randomToken: () =>
        "abcdefghijklmnopqrstuvwxyzABCDEF0123456789_-",
      clientFactory: () => ({
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        getQrCode: vi.fn(async () => ({
          qrcode: "platform-qrcode-secret",
          qrcode_img_content:
            Buffer.from("png-fixture").toString("base64"),
        })),
        getQrCodeStatus,
        getUpdates: vi.fn(),
        sendText: vi.fn(),
        getConfig: vi.fn(),
        sendTyping: vi.fn(),
      }),
    });
    const scope = {
      userId: USER_ID,
      agentId: AGENT_ID,
    };
    const created = await qrAuth.create(scope);
    current += 5 * 60 * 1_000 - 1_000;
    const polling = qrAuth.poll(
      scope,
      created.poll_token,
    );
    await vi.waitFor(() => {
      expect(getQrCodeStatus).toHaveBeenCalledTimes(1);
    });
    current += 2_000;
    confirm?.({
      status: "confirmed",
      bot_token: "too-late-secret",
      baseurl: "https://ilinkai.weixin.qq.com",
    });

    await expect(polling).resolves.toEqual({
      status: "expired",
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("keeps confirmed WeChat credentials until the encrypted config write succeeds", async () => {
    let updateAttempts = 0;
    const update = vi.fn<AdminChannelConfigWriter>(
      async (input) => {
        updateAttempts += 1;
        if (updateAttempts === 1) {
          throw new Error("temporary_database_failure");
        }
        return {
          type: input.type,
          enabled: input.enabled,
          revision: input.expectedRevision + 1,
          config: input.config,
          secrets: {
            bot_token: {
              configured: true,
              lastRotatedAt:
                "2026-07-26T00:00:00.000Z",
            },
          },
          health: { status: "disabled", detail: {} },
        };
      },
    );
    const getQrCodeStatus = vi.fn(async () => ({
      status: "confirmed",
      bot_token: "wechat-confirmed-secret",
      baseurl: "https://ilinkai.weixin.qq.com",
    }));
    const qrAuth = createWechatQrAuthService({
      hmacKey: "test-wechat-qr-hmac-key",
      readChannels,
      updateChannel: update,
      randomToken: () =>
        "abcdefghijklmnopqrstuvwxyzABCDEF0123456789_-",
      clientFactory: () => ({
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        getQrCode: vi.fn(async () => ({
          qrcode: "platform-qrcode-secret",
          qrcode_img_content:
            Buffer.from("png-fixture").toString("base64"),
        })),
        getQrCodeStatus,
        getUpdates: vi.fn(),
        sendText: vi.fn(),
        getConfig: vi.fn(),
        sendTyping: vi.fn(),
      }),
    });
    const scope = {
      userId: USER_ID,
      agentId: AGENT_ID,
    };
    const created = await qrAuth.create(scope);

    await expect(
      qrAuth.poll(scope, created.poll_token),
    ).rejects.toThrow("temporary_database_failure");
    await expect(
      qrAuth.poll(scope, created.poll_token),
    ).resolves.toMatchObject({
      status: "confirmed",
      credentials: {
        bot_token: "configured",
      },
    });
    expect(getQrCodeStatus).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(2);
    expect(
      update.mock.calls[0]?.[0].operationId,
    ).toBe(update.mock.calls[1]?.[0].operationId);
  });

  it("serializes concurrent polls for the same WeChat QR session", async () => {
    let confirm:
      | ((value: Readonly<Record<string, unknown>>) => void)
      | undefined;
    const getQrCodeStatus = vi.fn(() =>
      new Promise<Readonly<Record<string, unknown>>>(
        (resolve) => {
          confirm = resolve;
        },
      ));
    const update = vi.fn<AdminChannelConfigWriter>(
      async (input) => ({
        type: input.type,
        enabled: input.enabled,
        revision: input.expectedRevision + 1,
        config: input.config,
        secrets: {
          bot_token: {
            configured: true,
            lastRotatedAt:
              "2026-07-26T00:00:00.000Z",
          },
        },
        health: { status: "disabled", detail: {} },
      }),
    );
    const qrAuth = createWechatQrAuthService({
      hmacKey: "test-wechat-qr-hmac-key",
      readChannels,
      updateChannel: update,
      randomToken: () =>
        "abcdefghijklmnopqrstuvwxyzABCDEF0123456789_-",
      clientFactory: () => ({
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        getQrCode: vi.fn(async () => ({
          qrcode: "platform-qrcode-secret",
          qrcode_img_content:
            Buffer.from("png-fixture").toString("base64"),
        })),
        getQrCodeStatus,
        getUpdates: vi.fn(),
        sendText: vi.fn(),
        getConfig: vi.fn(),
        sendTyping: vi.fn(),
      }),
    });
    const scope = {
      userId: USER_ID,
      agentId: AGENT_ID,
    };
    const created = await qrAuth.create(scope);
    const first = qrAuth.poll(scope, created.poll_token);
    await vi.waitFor(() => {
      expect(getQrCodeStatus).toHaveBeenCalledTimes(1);
    });

    await expect(
      qrAuth.poll(scope, created.poll_token),
    ).resolves.toEqual({ status: "waiting" });
    confirm?.({
      status: "confirmed",
      bot_token: "wechat-confirmed-secret",
      baseurl: "https://ilinkai.weixin.qq.com",
    });
    await expect(first).resolves.toMatchObject({
      status: "confirmed",
      credentials: {
        bot_token: "configured",
      },
    });
    expect(getQrCodeStatus).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("accepts a finite decimal SIP call_timeout through the API contract", async () => {
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
    const response = await router.dispatch(
      await request("/config/channels/sip", {
        method: "PUT",
        body: {
          operation_id: OPERATION_ID,
          revision: 0,
          call_timeout: 12.5,
        },
      }),
      runtime(),
    );

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ call_timeout: 12.5 }),
      }),
      expect.any(AbortSignal),
    );
  });

  it("rejects node-only SIP credentials at the center boundary", async () => {
    const update = vi.fn<AdminChannelConfigWriter>();
    const router = createCoreAdminCompatRouter(
      dependencies({ updateChannelConfig: update }),
    );
    for (const key of [
      "sip_password",
      "dashscope_api_key",
      "livekit_api_key",
      "livekit_api_secret",
    ]) {
      const response = await router.dispatch(
        await request("/config/channels/sip", {
          method: "PUT",
          body: {
            operation_id: OPERATION_ID,
            revision: 0,
            [key]: "runner-only-secret",
          },
        }),
        runtime(),
      );
      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json()))
        .not.toContain("runner-only-secret");
    }
    expect(update).not.toHaveBeenCalled();
  });

  it("returns safe issue paths for URL, number, and nested Matrix fields", async () => {
    const router = createCoreAdminCompatRouter(dependencies());
    const attempts = [
      {
        type: "telegram",
        body: { base_url: "not-a-url" },
        path: ["base_url"],
      },
      {
        type: "sip",
        body: { sip_port: 70_000 },
        path: ["sip_port"],
      },
      {
        type: "matrix",
        body: {
          groups: {
            "PureAlphaRoom": {
              requireMention: true,
              StripeSecret: "must-not-appear",
            },
          },
        },
        path: ["groups"],
      },
    ] as const;

    for (const attempt of attempts) {
      const response = await router.dispatch(
        await request(`/config/channels/${attempt.type}`, {
          method: "PUT",
          body: {
            operation_id: OPERATION_ID,
            revision: 0,
            ...attempt.body,
          },
        }),
        runtime(),
      );
      const serialized = JSON.stringify(await response.json());
      expect(response.status).toBe(400);
      expect(serialized).toContain(
        `"path":[${attempt.path
          .map((part) => JSON.stringify(part))
          .join(",")}`,
      );
      expect(serialized).not.toContain("PureAlphaRoom");
      expect(serialized).not.toContain("StripeSecret");
      expect(serialized).not.toContain("must-not-appear");
    }
  });

  it.each([
    "UnknownClearKey",
    "StripeSecretKey",
    "purealphasecret",
    "app_secret",
  ])(
    "does not reflect unknown clear_secret key %s",
    async (unknownSecret) => {
      const router = createCoreAdminCompatRouter(dependencies());
      const response = await router.dispatch(
        await request("/config/channels/telegram", {
          method: "PUT",
          body: {
            operation_id: OPERATION_ID,
            revision: 0,
            clear_secret: [unknownSecret],
          },
        }),
        runtime(),
      );
      const serialized = JSON.stringify(await response.json());

      expect(response.status).toBe(400);
      expect(serialized).not.toContain(unknownSecret);
      expect(JSON.parse(serialized)).toMatchObject({
        error: {
          details: {
            issues: [
              {
                code: "invalid_value",
                path: ["clear_secret"],
              },
            ],
          },
        },
      });
    },
  );

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
    const invalidSecretType = await router.dispatch(
      await request("/config/channels/telegram", {
        method: "PUT",
        body: {
          operation_id: OPERATION_ID,
          revision: 1,
          bot_token: { configured: true },
          clear_secret: [],
        },
      }),
      runtime(),
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
    await expect(conflicting.json()).resolves.toMatchObject({
      error: {
        details: {
          issues: [
            {
              code: "invalid_value",
              path: ["clear_secret", "bot_token"],
            },
          ],
        },
      },
    });
    expect(invalidSecretType.status).toBe(400);
    await expect(invalidSecretType.json()).resolves.toMatchObject({
      error: {
        details: {
          issues: [
            {
              code: "invalid_type",
              path: ["bot_token"],
            },
          ],
        },
      },
    });
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
