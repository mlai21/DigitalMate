import packageJson from "../../../../package.json";
import {
  createAdminAuthStatusResponse,
  type AdminSecurityOptions,
} from "@/server/admin/compat/security";
import {
  createAuthStatusHandler,
  createAuthVerifyHandler,
  type SharedAuthStatusReader,
} from "@/server/admin/compat/handlers/auth";
import { createCapabilityDisabledHandler } from "@/server/admin/compat/handlers/capabilities";
import {
  getLanguage,
  getUserTimezone,
  putLanguage,
  putUserTimezone,
} from "@/server/admin/compat/handlers/preferences";
import {
  cloneAgent,
  createGetAgentHandler,
  createListAgentsHandler,
  createUpdateAgentHandler,
  createAgent,
  deleteAgent,
  importAgent,
  pinAgent,
  reorderAgents,
  toggleAgent,
  type AdminAgentProfileReader,
  type AdminAgentProfileUpdater,
} from "@/server/admin/compat/handlers/agents";
import {
  AdminCompatError,
  type AdminCompatHandler,
} from "@/server/admin/compat/types";
import {
  AdminCompatRouter,
  type AdminCompatRuntime,
} from "@/server/admin/compat/router";
import { withFreshUserDataLease } from "@/server/admin/user-data-lease";
import { resolveDefaultAgentScope } from "@/server/agents/service";
import { STABLE_CAPABILITY_CODES } from "@/server/capabilities";
import { readEnv } from "@/server/config/env";
import { createRepositories } from "@/server/db/repositories";
import { getPool } from "@/server/db/client";
import {
  createAdminChannelConfigService,
} from "@/server/admin/channel-config";
import {
  createGetChannelHandler,
  createListChannelsHandler,
  createUpdateChannelHandler,
  createUpdateChannelsHandler,
  createWechatQrCodeHandler,
  createWechatQrCodeStatusHandler,
  listChannelSchemas,
  listChannelTypes,
  type AdminChannelConfigReader,
  type AdminChannelConfigBatchWriter,
  type AdminChannelConfigWriter,
} from "@/server/admin/compat/handlers/channels";
import {
  createWechatQrAuthService,
  type WechatQrAuthService,
} from "@/server/admin/wechat-qrcode";

export const consoleUpstreamTag = "v2.0.0.post3";
export const consoleUpstreamCommit =
  "fef7e64d984f4332d0b84a343cd209bd3ea5d316";
export const adminCompatApiRevision = "2026-07-26.1";

export type CoreAdminCompatDependencies = Readonly<{
  createAuthStatusResponse: SharedAuthStatusReader;
  digitalMateVersion: string;
  upstreamTag: string;
  upstreamCommit: string;
  compatApiRevision: string;
  readAgentProfile?: AdminAgentProfileReader;
  updateAgentProfile?: AdminAgentProfileUpdater;
  readChannelConfigs?: AdminChannelConfigReader;
  updateChannelConfig?: AdminChannelConfigWriter;
  updateChannelConfigs?: AdminChannelConfigBatchWriter;
  wechatQrAuth?: WechatQrAuthService;
}>;

export function createCoreAdminCompatRouter(
  dependencies: CoreAdminCompatDependencies,
): AdminCompatRouter {
  const router = new AdminCompatRouter();
  const authStatus = createAuthStatusHandler(
    dependencies.createAuthStatusResponse,
  );
  const authVerify = createAuthVerifyHandler(
    dependencies.createAuthStatusResponse,
  );
  const root = createRootHandler(dependencies);

  router.statusGet("/auth/status", authStatus);
  router.sessionGet("/auth/verify", authVerify);
  router.get("/root", root);
  router.get("/version", root);
  router.get(
    "/agents",
    createListAgentsHandler(dependencies.readAgentProfile),
  );
  router.get(
    "/agents/:agentId",
    createGetAgentHandler(dependencies.readAgentProfile),
    {
      agentHeader: "required",
    },
  );
  router.put(
    "/agents/:agentId",
    createUpdateAgentHandler(dependencies.updateAgentProfile),
    { agentHeader: "required" },
  );
  router.post("/agents", createAgent);
  router.post("/agents/import", importAgent);
  router.post("/agents/:agentId/clone", cloneAgent, {
    agentHeader: "required",
  });
  router.delete("/agents/:agentId", deleteAgent, {
    agentHeader: "required",
  });
  router.patch("/agents/:agentId/toggle", toggleAgent, {
    agentHeader: "required",
  });
  router.patch("/agents/:agentId/pin", pinAgent, {
    agentHeader: "required",
  });
  router.put("/agents/order", reorderAgents, {
    agentHeader: "required",
  });

  if (
    dependencies.readChannelConfigs &&
    dependencies.updateChannelConfig &&
    dependencies.updateChannelConfigs
  ) {
    const channelRouteOptions = {
      agentHeader: "required",
    } as const;
    router.get(
      "/config/channels/types",
      listChannelTypes,
      channelRouteOptions,
    );
    router.put(
      "/config/channels",
      createUpdateChannelsHandler(dependencies.updateChannelConfigs),
      channelRouteOptions,
    );
    router.get(
      "/config/channels/schemas",
      listChannelSchemas,
      channelRouteOptions,
    );
    router.get(
      "/config/channels",
      createListChannelsHandler(dependencies.readChannelConfigs),
      channelRouteOptions,
    );
    router.get(
      "/config/channels/:channelType",
      createGetChannelHandler(dependencies.readChannelConfigs),
      channelRouteOptions,
    );
    router.put(
      "/config/channels/:channelType",
      createUpdateChannelHandler(dependencies.updateChannelConfig),
      channelRouteOptions,
    );
    if (dependencies.wechatQrAuth) {
      router.get(
        "/config/channels/wechat/qrcode",
        createWechatQrCodeHandler(
          dependencies.wechatQrAuth,
        ),
        channelRouteOptions,
      );
      router.get(
        "/config/channels/wechat/qrcode/status",
        createWechatQrCodeStatusHandler(
          dependencies.wechatQrAuth,
        ),
        channelRouteOptions,
      );
    }
  }

  for (const path of ["/language", "/settings/language"]) {
    router.get(path, getLanguage);
    router.put(path, putLanguage);
  }
  for (const path of [
    "/user-timezone",
    "/config/user-timezone",
  ]) {
    router.get(path, getUserTimezone);
    router.put(path, putUserTimezone);
  }

  router.post(
    "/capabilities/p2-sandbox",
    createCapabilityDisabledHandler(
      STABLE_CAPABILITY_CODES.p2Sandbox,
    ),
  );
  router.post(
    "/capabilities/multi-agent",
    createCapabilityDisabledHandler(
      STABLE_CAPABILITY_CODES.multiAgent,
    ),
  );
  return router;
}

export async function dispatchAdminCompatRequest(
  request: Request,
  route: { routeSegments?: readonly string[] } = {},
): Promise<Response> {
  const env = readEnv();
  const channelSecretKey =
    env.channelSecretsKey?.status === "ready"
      ? env.channelSecretsKey.key
      : null;
  const getChannelConfigService = () =>
    createAdminChannelConfigService(getPool(), channelSecretKey);
  const wechatQrAuth = getDefaultWechatQrAuth({
    hmacKey: env.appSecret,
    readChannels: (scope, signal) =>
      getChannelConfigService().read(scope, signal),
    updateChannel: (input, signal) =>
      getChannelConfigService().update(input, signal),
  });
  const securityRepositories = createRepositories();
  const defaultUser = await securityRepositories.users.ensureDefault();
  const security = {
    defaultUserId: defaultUser.id,
    appSecret: env.appSecret,
    appPasswordEnabled: Boolean(env.appPassword),
    production: process.env.NODE_ENV === "production",
    trustProxyHeaders: env.trustProxyHeaders,
    loadSessionGeneration: (userId: string) =>
      securityRepositories.sessionStates.getGeneration(userId),
  } satisfies AdminSecurityOptions;
  const router = createCoreAdminCompatRouter({
    createAuthStatusResponse: (statusRequest) =>
      createAdminAuthStatusResponse(statusRequest, security),
    digitalMateVersion: packageJson.version,
    upstreamTag: consoleUpstreamTag,
    upstreamCommit: consoleUpstreamCommit,
    compatApiRevision: adminCompatApiRevision,
    readChannelConfigs: (scope, signal) =>
      getChannelConfigService().read(scope, signal),
    updateChannelConfig: (input, signal) =>
      getChannelConfigService().update(input, signal),
    updateChannelConfigs: (inputs, signal) =>
      getChannelConfigService().updateMany(inputs, signal),
    wechatQrAuth,
  });
  const runtime = {
    security,
    withUserDataLease: (userId, work) =>
      withFreshUserDataLease(userId, work, {
        signal: request.signal,
        timeoutCode: "admin_compat_request_timeout",
      }),
    resolveDefaultScope: async (
      userId,
      resources,
      signal,
    ) => {
      signal.throwIfAborted();
      try {
        return await resolveDefaultAgentScope(
          userId,
          resources.agents,
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "default_agent_not_found"
        ) {
          throw new AdminCompatError(
            409,
            "agent_inactive",
            "active_agent_required",
          );
        }
        throw error;
      }
    },
  } satisfies AdminCompatRuntime;
  return router.dispatch(request, runtime, {
    routeSegments: route.routeSegments,
  });
}

let defaultWechatQrAuth:
  WechatQrAuthService | null = null;

function getDefaultWechatQrAuth(input: Readonly<{
  hmacKey: string;
  readChannels: AdminChannelConfigReader;
  updateChannel: AdminChannelConfigWriter;
}>): WechatQrAuthService {
  defaultWechatQrAuth ??= createWechatQrAuthService(input);
  return defaultWechatQrAuth;
}

function createRootHandler(
  dependencies: CoreAdminCompatDependencies,
): AdminCompatHandler {
  return async () => ({
    name: "DigitalMate",
    version: dependencies.digitalMateVersion,
    upstream: {
      tag: dependencies.upstreamTag,
      commit: dependencies.upstreamCommit,
    },
    compat_api_revision: dependencies.compatApiRevision,
  });
}
