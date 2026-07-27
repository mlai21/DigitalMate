import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

import type { AdminCompatContext } from "@/server/admin/compat/types";
import {
  createGetPluginStatusHandler,
  createListPluginsHandler,
  createPluginMutationBlockedHandler,
  createPostgresAdminPluginsService,
  type AdminPluginsService,
} from "@/server/admin/compat/handlers/plugins";
import {
  CHANNEL_TYPES,
} from "@/server/channels/manifests/catalog";

const scope = {
  userId: "10000000-0000-4000-8000-000000000001",
  agentId: "10000000-0000-4000-8000-000000000011",
};

describe("admin compatibility plugins", () => {
  it("真实投影固定包含 17 个内置渠道和当前分身获授权的 Skill/Tool", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [
          { channel_type: "telegram", enabled: true },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "20000000-0000-4000-8000-000000000001",
            name: "research",
            trigger: "研究",
            version: 3,
            status: "enabled",
            granted: true,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "30000000-0000-4000-8000-000000000001",
            name: "browser",
            description: "浏览器工具",
            revision: 2,
            status: "enabled",
            granted: false,
          },
        ],
      });
    const service = createPostgresAdminPluginsService({
      query,
    } as unknown as Pool);

    const plugins = await service.list(scope);
    const channels = plugins.filter(
      (plugin) => plugin.plugin_type === "channel",
    );

    expect(channels.map((plugin) => plugin.id)).toEqual(
      CHANNEL_TYPES.map((type) => `channel:${type}`),
    );
    expect(channels).toHaveLength(17);
    expect(
      plugins.find(
        (plugin) => plugin.id === "channel:telegram",
      ),
    ).toMatchObject({ enabled: true, loaded: true });
    expect(
      plugins.find(
        (plugin) =>
          plugin.id
          === "skill:20000000-0000-4000-8000-000000000001",
      ),
    ).toMatchObject({ enabled: true, version: "3" });
    expect(
      plugins.find(
        (plugin) =>
          plugin.id
          === "tool:30000000-0000-4000-8000-000000000001",
      ),
    ).toMatchObject({ enabled: false, version: "2" });
    expect(query).toHaveBeenCalledTimes(3);
    for (const call of query.mock.calls) {
      expect(call[1]).toEqual([
        scope.userId,
        scope.agentId,
      ]);
    }
  });

  it("只读列出内置渠道、工具与 Skill 的真实状态", async () => {
    const service = {
      list: vi.fn().mockResolvedValue([
        {
          id: "channel:telegram",
          name: "Telegram",
          version: "builtin",
          description: "内置渠道",
          author: "DigitalMate",
          enabled: true,
          loaded: true,
          plugin_type: "channel",
        },
        {
          id: "skill:research",
          name: "research",
          version: "3",
          description: "内置 Skill",
          author: "DigitalMate",
          enabled: false,
          loaded: true,
          plugin_type: "general",
        },
      ]),
      getStatus: vi.fn().mockResolvedValue({
        id: "channel:telegram",
        loaded: true,
        enabled: true,
        version: "builtin",
      }),
    } satisfies AdminPluginsService;

    await expect(
      createListPluginsHandler(service)(context("GET", "/plugins")),
    ).resolves.toHaveLength(2);
    await expect(
      createGetPluginStatusHandler(service)(
        context("GET", "/plugins/channel%3Atelegram/status", {
          pluginId: "channel:telegram",
        }),
      ),
    ).resolves.toMatchObject({
      id: "channel:telegram",
      enabled: true,
    });
  });

  it.each(["install", "upload", "uninstall", "enable"])(
    "%s 写操作统一返回 501 且不访问外部 marketplace",
    async (action) => {
      const handler = createPluginMutationBlockedHandler();
      await expect(
        handler(context("POST", `/plugins/${action}`)),
      ).rejects.toMatchObject({
        status: 501,
        code: "plugins",
        publicMessage:
          "插件扩展需单独确认且当前冻结",
      });
    },
  );
});

function context(
  method: string,
  route: string,
  params: Readonly<Record<string, string>> = {},
): AdminCompatContext {
  return {
    request: new Request(`http://localhost/api/admin${route}`, {
      method,
    }),
    params,
    scope,
    csrfVerified: true,
    resources: {} as AdminCompatContext["resources"],
    signal: new AbortController().signal,
  };
}
