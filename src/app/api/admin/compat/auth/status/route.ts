import { createAdminAuthStatusResponse } from "@/server/admin/compat/security";
import { readEnv } from "@/server/config/env";
import { createRepositories } from "@/server/db/repositories";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const env = readEnv();
  const defaultUser = await createRepositories().users.ensureDefault();
  return createAdminAuthStatusResponse(request, {
    defaultUserId: defaultUser.id,
    appSecret: env.appSecret,
    appPasswordEnabled: Boolean(env.appPassword),
    production: process.env.NODE_ENV === "production",
    trustProxyHeaders: env.trustProxyHeaders,
  });
}
