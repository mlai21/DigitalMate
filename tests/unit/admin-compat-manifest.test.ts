import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AdminCompatRouter } from "@/server/admin/compat/router";
import {
  createCoreAdminCompatRouter,
  type CoreAdminCompatDependencies,
} from "@/server/admin/compat/register-core";
import {
  EXPECTED_UPSTREAM_API_MODULES,
  UPSTREAM_API_CONTRACT,
  listUpstreamEndpointContracts,
} from "@/server/admin/compat/upstream-contract";

const EXPECTED_MODULES = [
  "accessControl",
  "acp",
  "agent",
  "agentStats",
  "agents",
  "auth",
  "backup",
  "channel",
  "chat",
  "codingMode",
  "codingProject",
  "commands",
  "console",
  "cronjob",
  "debug",
  "env",
  "git",
  "heartbeat",
  "language",
  "localModel",
  "market",
  "mcp",
  "plugin",
  "pluginMarket",
  "provider",
  "root",
  "security",
  "skill",
  "tokenUsage",
  "tools",
  "userTimezone",
  "workspace",
] as const;

const EXPECTED_ENDPOINT_COUNTS = {
  accessControl: 13,
  acp: 6,
  agent: 18,
  agentStats: 1,
  agents: 8,
  auth: 4,
  backup: 7,
  channel: 8,
  chat: 13,
  codingMode: 2,
  codingProject: 8,
  commands: 2,
  console: 5,
  cronjob: 11,
  debug: 1,
  env: 3,
  git: 11,
  heartbeat: 3,
  language: 3,
  localModel: 12,
  market: 3,
  mcp: 14,
  plugin: 6,
  pluginMarket: 1,
  provider: 20,
  root: 2,
  security: 16,
  skill: 41,
  tokenUsage: 2,
  tools: 5,
  userTimezone: 2,
  workspace: 15,
} as const;

const EXPECTED_MODULE_STATUS = {
  accessControl: "mapped",
  acp: "disabled",
  agent: "mapped",
  agentStats: "mapped",
  agents: "mapped",
  auth: "mapped",
  backup: "mapped",
  channel: "mapped",
  chat: "redirected",
  codingMode: "disabled",
  codingProject: "disabled",
  commands: "mapped",
  console: "redirected",
  cronjob: "mapped",
  debug: "mapped",
  env: "mapped",
  git: "disabled",
  heartbeat: "mapped",
  language: "mapped",
  localModel: "disabled",
  market: "disabled",
  mcp: "mapped",
  plugin: "mapped",
  pluginMarket: "disabled",
  provider: "mapped",
  root: "mapped",
  security: "mapped",
  skill: "mapped",
  tokenUsage: "mapped",
  tools: "mapped",
  userTimezone: "mapped",
  workspace: "mapped",
} as const;

const EXPECTED_MODULE_STATUS_COUNTS = {
  mapped: 23,
  disabled: 7,
  redirected: 2,
} as const;

const EXPECTED_ENDPOINT_STATUS_COUNTS = {
  mapped: 119,
  disabled: 142,
  redirected: 5,
} as const;

const EXPECTED_ENDPOINT_CONTRACT_SHA256 =
  "33fe6f32f9f7f3198bc6c93c872c6cd54fe4ef7237748a8d5e0d713ac8ca91f2";

const EXPECTED_ENDPOINT_STATUS_COUNTS_BY_MODULE = {
  accessControl: [13, 0, 0],
  acp: [0, 6, 0],
  agent: [7, 10, 1],
  agentStats: [1, 0, 0],
  agents: [7, 1, 0],
  auth: [1, 3, 0],
  backup: [7, 0, 0],
  channel: [6, 2, 0],
  chat: [9, 0, 4],
  codingMode: [0, 2, 0],
  codingProject: [0, 8, 0],
  commands: [2, 0, 0],
  console: [5, 0, 0],
  cronjob: [11, 0, 0],
  debug: [1, 0, 0],
  env: [1, 2, 0],
  git: [0, 11, 0],
  heartbeat: [3, 0, 0],
  language: [2, 1, 0],
  localModel: [0, 12, 0],
  market: [0, 3, 0],
  mcp: [5, 9, 0],
  plugin: [3, 3, 0],
  pluginMarket: [0, 1, 0],
  provider: [3, 17, 0],
  root: [2, 0, 0],
  security: [7, 9, 0],
  skill: [11, 30, 0],
  tokenUsage: [2, 0, 0],
  tools: [2, 3, 0],
  userTimezone: [2, 0, 0],
  workspace: [6, 9, 0],
} as const;

describe("QwenPaw Console upstream API contract", () => {
  it("固定版本 32 个 API 模块都有审计状态", () => {
    expect(EXPECTED_UPSTREAM_API_MODULES).toEqual(EXPECTED_MODULES);
    expect(Object.keys(UPSTREAM_API_CONTRACT).sort()).toEqual(
      [...EXPECTED_MODULES].sort(),
    );

    for (const moduleName of EXPECTED_MODULES) {
      const contract = UPSTREAM_API_CONTRACT[moduleName];
      expect(contract.endpoints.length, moduleName).toBe(
        EXPECTED_ENDPOINT_COUNTS[moduleName],
      );
      expect(contract.status, moduleName).toBe(
        EXPECTED_MODULE_STATUS[moduleName],
      );
    }
    expect(listUpstreamEndpointContracts()).toHaveLength(266);
  });

  it("固定模块与端点状态总数及逐模块分布", () => {
    const moduleCounts = {
      mapped: 0,
      disabled: 0,
      redirected: 0,
    };
    const endpointCounts = {
      mapped: 0,
      disabled: 0,
      redirected: 0,
    };

    for (const moduleName of EXPECTED_MODULES) {
      const contract = UPSTREAM_API_CONTRACT[moduleName];
      moduleCounts[contract.status] += 1;

      const perModule = {
        mapped: 0,
        disabled: 0,
        redirected: 0,
      };
      for (const endpoint of contract.endpoints) {
        endpointCounts[endpoint.status] += 1;
        perModule[endpoint.status] += 1;
      }
      expect(
        [
          perModule.mapped,
          perModule.disabled,
          perModule.redirected,
        ],
        moduleName,
      ).toEqual(
        EXPECTED_ENDPOINT_STATUS_COUNTS_BY_MODULE[moduleName],
      );
    }

    expect(moduleCounts).toEqual(EXPECTED_MODULE_STATUS_COUNTS);
    expect(endpointCounts).toEqual(EXPECTED_ENDPOINT_STATUS_COUNTS);
  });

  it("逐端点冻结方法、路径、状态、禁用码和跳转目标", () => {
    const snapshot = Object.fromEntries(
      listUpstreamEndpointContracts()
        .map(
          ({
            module,
            method,
            path: endpointPath,
            status,
            disabledCode,
            redirectTo,
          }) =>
            [
              `${method} ${endpointPath}`,
              [
                module,
                status,
                disabledCode ?? null,
                redirectTo ?? null,
              ],
            ] as const,
        )
        .sort(([left], [right]) => left.localeCompare(right)),
    );
    const digest = createHash("sha256")
      .update(JSON.stringify(snapshot))
      .digest("hex");

    expect(Object.keys(snapshot)).toHaveLength(266);
    expect(digest).toBe(EXPECTED_ENDPOINT_CONTRACT_SHA256);
  });

  it("固定快照包含 32 个 API 源模块和 31 个配套测试", async () => {
    const directory = path.join(
      process.cwd(),
      "vendor/qwenpaw-console/console/src/api/modules",
    );
    const files = await readdir(directory);
    const sources = files
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .sort();
    const tests = files.filter((file) => file.endsWith(".test.ts")).sort();
    const testsBySource = new Set(
      tests.map((file) => file.replace(/\.test\.ts$/, ".ts")),
    );

    expect(sources).toHaveLength(32);
    expect(tests).toHaveLength(31);
    expect(sources.length + tests.length).toBe(63);
    expect(
      sources.filter((source) => !testsBySource.has(source)),
    ).toEqual(["pluginMarket.ts"]);
  });

  it("每个端点都有唯一、规范且可执行的状态", () => {
    const endpoints = listUpstreamEndpointContracts();
    const keys = endpoints.map(
      ({ method, path: endpointPath }) => `${method} ${endpointPath}`,
    );

    expect(new Set(keys).size).toBe(keys.length);
    for (const endpoint of endpoints) {
      expect(endpoint.path).toMatch(/^\/(?:$|[^?#]+$)/);
      expect(endpoint.path === "/" || !endpoint.path.endsWith("/")).toBe(
        true,
      );
      if (endpoint.status === "disabled") {
        expect(endpoint.disabledCode).toMatch(/^[a-z0-9_]+$/);
        expect(endpoint.redirectTo).toBeUndefined();
      } else if (endpoint.status === "redirected") {
        expect(endpoint.redirectTo).toMatch(/^\/(?:$|[^/])/);
        expect(endpoint.disabledCode).toBeUndefined();
      } else {
        expect(endpoint.disabledCode).toBeUndefined();
        expect(endpoint.redirectTo).toBeUndefined();
      }
    }
  });

  it("router 自检拒绝缺失和状态不一致的合同端点", () => {
    const router = new AdminCompatRouter();
    router.get("/mapped", async () => ({ ok: true }));
    router.disabled("POST", "/disabled", "p2_sandbox");
    router.redirected("GET", "/redirected", "/");

    expect(() =>
      router.assertUpstreamContract([
        {
          module: "root",
          method: "GET",
          path: "/mapped",
          status: "mapped",
          domain: "test",
        },
        {
          module: "security",
          method: "POST",
          path: "/disabled",
          status: "disabled",
          domain: "test",
          disabledCode: "p2_sandbox",
        },
        {
          module: "chat",
          method: "GET",
          path: "/redirected",
          status: "redirected",
          domain: "test",
          redirectTo: "/",
        },
      ]),
    ).not.toThrow();

    expect(() =>
      router.assertUpstreamContract([
        {
          module: "root",
          method: "GET",
          path: "/missing",
          status: "mapped",
          domain: "test",
        },
      ]),
    ).toThrow("admin_compat_contract_missing:GET /missing");

    expect(() =>
      router.assertUpstreamContract([
        {
          module: "security",
          method: "POST",
          path: "/disabled",
          status: "mapped",
          domain: "test",
        },
      ]),
    ).toThrow(
      "admin_compat_contract_status_mismatch:POST /disabled:disabled!=mapped",
    );
  });

  it("生产核心注册表启动时通过完整合同自检", () => {
    const unavailable = async (): Promise<never> => {
      throw new Error("not_called");
    };
    const dependencies = {
      createAuthStatusResponse: async () =>
        Response.json({ authenticated: true }),
      digitalMateVersion: "0.1.0",
      upstreamTag: "v2.0.0.post3",
      upstreamCommit:
        "fef7e64d984f4332d0b84a343cd209bd3ea5d316",
      compatApiRevision: "test",
      readChannelConfigs: unavailable,
      updateChannelConfig: unavailable,
      updateChannelConfigs: unavailable,
      inbox:
        {} as NonNullable<
          CoreAdminCompatDependencies["inbox"]
        >,
      sessions:
        {} as NonNullable<
          CoreAdminCompatDependencies["sessions"]
        >,
      schedules:
        {} as NonNullable<
          CoreAdminCompatDependencies["schedules"]
        >,
      workspace:
        {} as NonNullable<
          CoreAdminCompatDependencies["workspace"]
        >,
      agentResources:
        {} as NonNullable<
          CoreAdminCompatDependencies["agentResources"]
        >,
      models:
        {} as NonNullable<
          CoreAdminCompatDependencies["models"]
        >,
      operations:
        {} as NonNullable<
          CoreAdminCompatDependencies["operations"]
        >,
      securityOverview:
        {} as NonNullable<
          CoreAdminCompatDependencies["securityOverview"]
        >,
      backups:
        {} as NonNullable<
          CoreAdminCompatDependencies["backups"]
        >,
      plugins:
        {} as NonNullable<
          CoreAdminCompatDependencies["plugins"]
        >,
      verifyUpstreamContract: true,
    } satisfies CoreAdminCompatDependencies;

    expect(() =>
      createCoreAdminCompatRouter(dependencies),
    ).not.toThrow();
  });
});
