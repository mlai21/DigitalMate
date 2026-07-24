import { dispatchAdminCompatRequest } from "@/server/admin/compat/register-core";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ segments?: string[] }>;
};

type AdminCompatDispatcher = (
  request: Request,
  route: { routeSegments?: readonly string[] },
) => Promise<Response>;

type AdminCompatDispatcherFactory = () => AdminCompatDispatcher;

export function createAdminCompatRouteHandler(
  createDispatcher: AdminCompatDispatcherFactory = () =>
    dispatchAdminCompatRequest,
) {
  return async function adminCompatRoute(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    try {
      const { segments } = await context.params;
      const dispatcher = createDispatcher();
      return await dispatcher(request, {
        routeSegments: segments ?? [],
      });
    } catch {
      return internalErrorResponse();
    }
  };
}

function internalErrorResponse(): Response {
  return Response.json(
    {
      error: {
        code: "internal_error",
        message: "internal_error",
      },
    },
    {
      status: 500,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

const handle = createAdminCompatRouteHandler();

export const GET = handle;
export const HEAD = handle;
export const OPTIONS = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
