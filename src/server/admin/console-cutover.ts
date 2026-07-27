import {
  createAdminConsolePreviewHandler,
  type AdminConsoleHandlerOptions,
  type AdminConsoleRouteContext,
} from "@/server/admin/console-static";

const consolePathPrefix = "/admin";
const legacyPathPrefix = "/admin-legacy";

type AdminConsoleCutoverOptions = AdminConsoleHandlerOptions & {
  enabled: boolean;
};

export function createAdminConsoleCutoverHandler(
  options: AdminConsoleCutoverOptions,
) {
  const consoleHandler = createAdminConsolePreviewHandler({
    ...options,
    pathPrefix: consolePathPrefix,
  });

  return async function handleAdminConsoleCutover(
    request: Request,
    context: AdminConsoleRouteContext,
  ): Promise<Response> {
    if (options.enabled) {
      return consoleHandler(request, context);
    }
    return redirectAdminToLegacy(request);
  };
}

export function redirectAdminToLegacy(request: Request): Response {
  const url = new URL(request.url);
  if (
    url.pathname !== consolePathPrefix
    && !url.pathname.startsWith(`${consolePathPrefix}/`)
  ) {
    return new Response("Bad Request", {
      status: 400,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  const suffix = url.pathname.slice(consolePathPrefix.length);
  return new Response(null, {
    status: 307,
    headers: {
      Location: `${legacyPathPrefix}${suffix}${url.search}`,
    },
  });
}
