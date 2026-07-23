import path from "node:path";
import { createAdminConsolePreviewHandler } from "@/server/admin/console-static";
import { readEnv } from "@/server/config/env";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ path?: string[] }>;
};

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const handler = createAdminConsolePreviewHandler({
    appSecret: readEnv().appSecret,
    rootDirectory: path.join(process.cwd(), "public", "_admin-console"),
  });
  return handler(request, context);
}
