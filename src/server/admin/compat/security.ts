import { createHmac } from "node:crypto";
import {
  getSessionTokenFromRequest,
  verifySessionToken,
} from "@/server/auth/session";
import {
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
  };
  return Response.json(body, {
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
    const sessionUserId = await verifySessionToken(
      sessionToken,
      options.appSecret,
    );
    if (sessionUserId !== options.defaultUserId) return null;
    return { userId: sessionUserId, sessionToken };
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
