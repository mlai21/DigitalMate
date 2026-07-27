import path from "node:path";
import {
  createAdminConsoleCutoverHandler,
  redirectAdminToLegacy,
} from "@/server/admin/console-cutover";
import { readEnv } from "@/server/config/env";
import { createRepositories } from "@/server/db/repositories";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ path?: string[] }>;
};

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const env = readEnv();
  if (!env.adminConsoleEnabled) {
    return redirectAdminToLegacy(request);
  }

  const repositories = createRepositories();
  const defaultUser = await repositories.users.ensureDefault();
  const handler = createAdminConsoleCutoverHandler({
    enabled: true,
    appSecret: env.appSecret,
    appPasswordEnabled: Boolean(env.appPassword),
    production: process.env.NODE_ENV === "production",
    trustProxyHeaders: env.trustProxyHeaders,
    defaultUserId: defaultUser.id,
    loadSessionGeneration: (userId) =>
      repositories.sessionStates.getGeneration(userId),
    rootDirectory: path.join(
      process.cwd(),
      "public",
      "_admin-console",
    ),
  });
  return handler(request, context);
}
