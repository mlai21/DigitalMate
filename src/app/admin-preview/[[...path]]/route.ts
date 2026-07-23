import path from "node:path";
import { createAdminConsolePreviewHandler } from "@/server/admin/console-static";
import { readEnv } from "@/server/config/env";
import { createRepositories } from "@/server/db/repositories";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ path?: string[] }>;
};

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const defaultUser = await createRepositories().users.ensureDefault();
  const handler = createAdminConsolePreviewHandler({
    appSecret: readEnv().appSecret,
    defaultUserId: defaultUser.id,
    rootDirectory: path.join(process.cwd(), "public", "_admin-console"),
  });
  return handler(request, context);
}
