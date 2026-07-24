import { createHmac } from "node:crypto";
import {
  getSessionTokenFromRequest,
  hasSessionCookie,
  verifySessionToken,
} from "@/server/auth/session";
import {
  csrfTokenLifetimeSeconds,
  createCsrfToken,
  deriveCsrfSecret,
  verifyCsrfToken,
} from "@/server/http/csrf";
import { hasSameRequestOrigin } from "@/server/http/request-origin";

const mutationMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type AdminSecurityOptions = {
  defaultUserId: string;
  appSecret: string;
  appPasswordEnabled: boolean;
  production: boolean;
  trustProxyHeaders: boolean;
  loadSessionGeneration: (userId: string) => Promise<number | null>;
  now?: Date;
};

export type AdminSecurityContext = {
  request: Request;
  userId: string;
  csrfVerified: boolean;
};

export type AdminSecurityHandler = (
  context: AdminSecurityContext,
) => Promise<Response>;

type ResolvedAdminSession = {
  userId: string;
  sessionToken: string;
};

export async function dispatchAdminSecurityBoundary(
  request: Request,
  options: AdminSecurityOptions,
  handler: AdminSecurityHandler,
): Promise<Response> {
  const session = await resolveAdminSession(request, options);
  if (!session) return errorResponse(401, "unauthorized");

  const requiresCsrf = mutationMethods.has(request.method.toUpperCase());
  if (
    requiresCsrf &&
    (!hasSameRequestOrigin(request, {
      trustProxyHeaders: options.trustProxyHeaders,
    }) ||
      !verifyCsrfToken(request.headers.get("x-csrf-token") ?? "", {
        userId: session.userId,
        sessionToken: session.sessionToken,
        secret: deriveCsrfSecret(options.appSecret),
        now: options.now,
      }))
  ) {
    return errorResponse(403, "forbidden");
  }

  return handler({
    request,
    userId: session.userId,
    csrfVerified: requiresCsrf,
  });
}

export async function createAdminAuthStatusResponse(
  request: Request,
  options: AdminSecurityOptions,
): Promise<Response> {
  const session = await resolveAdminSession(request, options);
  const invalidPresentedSession =
    session === null && hasSessionCookie(request);
  const body = {
    enabled: options.appPasswordEnabled || options.production,
    authenticated: session !== null,
    csrf_token: session
      ? createCsrfToken({
          userId: session.userId,
          sessionToken: session.sessionToken,
          secret: deriveCsrfSecret(options.appSecret),
          now: options.now,
        })
      : "",
    csrf_expires_at: session
      ? Math.floor((options.now ?? new Date()).getTime() / 1_000) +
        csrfTokenLifetimeSeconds
      : null,
  };
  return Response.json(body, {
    status: invalidPresentedSession ? 401 : 200,
    headers: {
      "cache-control": "no-store",
    },
  });
}

async function resolveAdminSession(
  request: Request,
  options: AdminSecurityOptions,
): Promise<ResolvedAdminSession | null> {
  const sessionToken = getSessionTokenFromRequest(request);
  if (sessionToken) {
    const verifiedSession = await verifySessionToken(
      sessionToken,
      options.appSecret,
      options.now,
    );
    if (verifiedSession?.userId !== options.defaultUserId) return null;
    const currentGeneration =
      await options.loadSessionGeneration(verifiedSession.userId);
    if (currentGeneration !== verifiedSession.generation) return null;
    return { userId: verifiedSession.userId, sessionToken };
  }

  if (!options.appPasswordEnabled && !options.production) {
    return {
      userId: options.defaultUserId,
      sessionToken: createDevelopmentSessionBinding(options),
    };
  }
  return null;
}

function createDevelopmentSessionBinding(
  options: AdminSecurityOptions,
): string {
  return createHmac("sha256", options.appSecret)
    .update(
      `digitalmate:admin-development-session:v1:${options.defaultUserId}`,
    )
    .digest("base64url");
}

function errorResponse(
  status: 401 | 403,
  code: "unauthorized" | "forbidden",
): Response {
  return Response.json(
    { error: { code, message: code } },
    {
      status,
      headers: { "cache-control": "no-store" },
    },
  );
}
