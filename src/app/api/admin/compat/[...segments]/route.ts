import { createAdminCompatRouteHandler } from "@/server/admin/compat/route-handler";

export const runtime = "nodejs";

const handle = createAdminCompatRouteHandler();

export const GET = handle;
export const HEAD = handle;
export const OPTIONS = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
