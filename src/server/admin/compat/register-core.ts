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
  AdminCompatError,
  type AdminCompatHandler,
} from "@/server/admin/compat/types";
import {
  AdminCompatRouter,
  type AdminCompatRuntime,
} from "@/server/admin/compat/router";
import { withFreshUserDataLease } from "@/server/admin/user-data-lease";
import { resolveDefaultAgentScope } from "@/server/agents/service";
import { readEnv } from "@/server/config/env";
import { createRepositories } from "@/server/db/repositories";

export const consoleUpstreamTag = "v2.0.0.post3";
export const consoleUpstreamCommit =
  "fef7e64d984f4332d0b84a343cd209bd3ea5d316";
export const adminCompatApiRevision = "2026-07-24.1";

export type CoreAdminCompatDependencies = Readonly<{
  createAuthStatusResponse: SharedAuthStatusReader;
  digitalMateVersion: string;
  upstreamTag: string;
  upstreamCommit: string;
  compatApiRevision: string;
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
    createCapabilityDisabledHandler("p2_sandbox"),
  );
  router.post(
    "/capabilities/multi-agent",
    createCapabilityDisabledHandler("multi_agent"),
  );
  return router;
}

export async function dispatchAdminCompatRequest(
  request: Request,
  route: { routeSegments?: readonly string[] } = {},
): Promise<Response> {
  const env = readEnv();
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
