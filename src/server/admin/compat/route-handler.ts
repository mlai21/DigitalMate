import { dispatchAdminCompatRequest } from "@/server/admin/compat/register-core";

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
      return internalErrorResponse(request.method);
    }
  };
}

function internalErrorResponse(requestMethod: string): Response {
  const response = Response.json(
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
  if (requestMethod.toUpperCase() !== "HEAD") return response;
  return new Response(null, {
    status: response.status,
    headers: response.headers,
  });
}
