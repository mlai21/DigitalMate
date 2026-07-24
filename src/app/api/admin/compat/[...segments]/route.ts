import { dispatchAdminCompatRequest } from "@/server/admin/compat/register-core";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ segments?: string[] }>;
};

type AdminCompatDispatcher = (
  request: Request,
  route: { routeSegments?: readonly string[] },
) => Promise<Response>;

export function createAdminCompatRouteHandler(
  dispatcher: AdminCompatDispatcher = dispatchAdminCompatRequest,
) {
  return async function adminCompatRoute(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const { segments } = await context.params;
    return dispatcher(request, {
      routeSegments: segments ?? [],
    });
  };
}

const handle = createAdminCompatRouteHandler();

export const GET = handle;
export const HEAD = handle;
export const OPTIONS = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
