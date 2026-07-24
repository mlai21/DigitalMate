import { cookies } from "next/headers";
import { dispatchAdminSecurityBoundary } from "@/server/admin/compat/security";
import { sessionCookieName } from "@/server/auth/session";
import { readEnv } from "@/server/config/env";
import { createRepositories } from "@/server/db/repositories";

export async function POST(request: Request) {
  const env = readEnv();
  const repositories = createRepositories();
  try {
    const defaultUser = await repositories.users.ensureDefault();
    return await dispatchAdminSecurityBoundary(
      request,
      {
        defaultUserId: defaultUser.id,
        appSecret: env.appSecret,
        appPasswordEnabled: Boolean(env.appPassword),
        production: process.env.NODE_ENV === "production",
        trustProxyHeaders: env.trustProxyHeaders,
        loadSessionGeneration: (userId) =>
          repositories.sessionStates.getGeneration(userId),
      },
      async ({ userId }) => {
        await repositories.sessionStates.rotate(userId);
        const cookieStore = await cookies();
        cookieStore.delete(sessionCookieName);
        return new Response(null, {
          status: 204,
          headers: { "cache-control": "no-store" },
        });
      },
    );
  } catch {
    return Response.json(
      { error: { code: "session_unavailable", message: "session_unavailable" } },
      {
        status: 500,
        headers: { "cache-control": "no-store" },
      },
    );
  }
}
