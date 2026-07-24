import { createAdminAuthStatusResponse } from "@/server/admin/compat/security";
import { readTrustedOriginalRequestPath } from "@/server/admin/compat/original-uri";
import { AdminCompatError } from "@/server/admin/compat/types";
import { readEnv } from "@/server/config/env";
import { createRepositories } from "@/server/db/repositories";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const env = readEnv();
  try {
    const originalPath = readTrustedOriginalRequestPath(
      request,
      env.trustProxyHeaders,
    );
    if (
      originalPath !== null &&
      originalPath !== "/api/admin/compat/auth/status"
    ) {
      return invalidPathResponse();
    }
  } catch (error) {
    if (
      error instanceof AdminCompatError &&
      error.status === 400 &&
      error.code === "invalid_request" &&
      error.publicMessage === "invalid_path"
    ) {
      return invalidPathResponse();
    }
    throw error;
  }
  const repositories = createRepositories();
  const defaultUser = await repositories.users.ensureDefault();
  return createAdminAuthStatusResponse(request, {
    defaultUserId: defaultUser.id,
    appSecret: env.appSecret,
    appPasswordEnabled: Boolean(env.appPassword),
    production: process.env.NODE_ENV === "production",
    trustProxyHeaders: env.trustProxyHeaders,
    loadSessionGeneration: (userId) =>
      repositories.sessionStates.getGeneration(userId),
  });
}

function invalidPathResponse(): Response {
  return Response.json(
    {
      error: {
        code: "invalid_request",
        message: "invalid_path",
      },
    },
    {
      status: 400,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}
