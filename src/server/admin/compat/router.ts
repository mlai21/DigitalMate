import { ZodError } from "zod";
import { AdminAuditError } from "@/server/admin/audit";
import {
  dispatchAdminSecurityBoundary,
  type AdminSecurityOptions,
} from "@/server/admin/compat/security";
import {
  AdminCompatError,
  type AdminCompatErrorBody,
  type AdminCompatHandler,
  type AdminCompatResources,
  type AdminCompatSessionHandler,
  type AdminCompatStatusHandler,
} from "@/server/admin/compat/types";
import { readTrustedOriginalRequestPath } from "@/server/admin/compat/original-uri";
import type { AgentScope } from "@/server/agents/types";
import { isStableCapabilityCode } from "@/server/capabilities";

const COMPAT_BASE_PATH = "/api/admin/compat";
const METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SAFE_HANDLER_RESPONSE_HEADERS = new Set([
  "content-language",
  "content-type",
]);
const ADMIN_AUDIT_VALIDATION_CODES = new Set([
  "invalid_config_revision",
  "invalid_secret_field",
  "invalid_audit_config_field",
  "secret_in_audit_config",
  "secret_in_public_config",
  "invalid_secret_change",
  "invalid_channel_config",
  "invalid_confirmation_source",
]);
type CompatMethod = (typeof METHODS)[number];
type RegisteredMethod = Exclude<CompatMethod, "HEAD" | "OPTIONS">;

type PatternSegment =
  | Readonly<{ kind: "static"; value: string }>
  | Readonly<{ kind: "dynamic"; name: string }>;

type RouteDefinition = Readonly<{
  method: RegisteredMethod;
  path: string;
  segments: readonly PatternSegment[];
  staticSegments: number;
  access: "scoped" | "session" | "status";
  handler:
    | AdminCompatHandler
    | AdminCompatSessionHandler
    | AdminCompatStatusHandler;
}>;

export type AdminCompatRuntime = Readonly<{
  security: AdminSecurityOptions;
  withUserDataLease: <T>(
    userId: string,
    work: (
      resources: AdminCompatResources,
      signal: AbortSignal,
    ) => Promise<T>,
  ) => Promise<T>;
  resolveDefaultScope: (
    userId: string,
    resources: AdminCompatResources,
    signal: AbortSignal,
  ) => Promise<AgentScope>;
}>;

export class AdminCompatRouter {
  private readonly routes: RouteDefinition[] = [];

  get(path: string, handler: AdminCompatHandler): void {
    this.register("GET", path, "scoped", handler);
  }

  sessionGet(path: string, handler: AdminCompatSessionHandler): void {
    this.register("GET", path, "session", handler);
  }

  statusGet(path: string, handler: AdminCompatStatusHandler): void {
    this.register("GET", path, "status", handler);
  }

  post(path: string, handler: AdminCompatHandler): void {
    this.register("POST", path, "scoped", handler);
  }

  put(path: string, handler: AdminCompatHandler): void {
    this.register("PUT", path, "scoped", handler);
  }

  patch(path: string, handler: AdminCompatHandler): void {
    this.register("PATCH", path, "scoped", handler);
  }

  delete(path: string, handler: AdminCompatHandler): void {
    this.register("DELETE", path, "scoped", handler);
  }

  async dispatch(
    request: Request,
    runtime: AdminCompatRuntime,
    route: { routeSegments?: readonly string[] } = {},
  ): Promise<Response> {
    try {
      const statusRoute = this.findCanonicalStatusRoute(request);
      if (statusRoute) {
        this.resolveRequestPathSegments(
          request,
          runtime.security.trustProxyHeaders,
        );
        const result = await (
          statusRoute.handler as AdminCompatStatusHandler
        )(request);
        return normalizeResponse(
          toResponse(result),
          request.method,
        );
      }
      const response = await dispatchAdminSecurityBoundary(
        request,
        runtime.security,
        async (securityContext) =>
          this.dispatchAuthenticated(
            request,
            runtime,
            securityContext.userId,
            securityContext.csrfVerified,
            route.routeSegments,
          ),
      );
      return normalizeResponse(response, request.method);
    } catch (error) {
      return normalizeResponse(mapError(error), request.method);
    }
  }

  private register(
    method: RegisteredMethod,
    path: string,
    access: RouteDefinition["access"],
    handler: RouteDefinition["handler"],
  ): void {
    const segments = parsePattern(path);
    const staticSegments = segments.filter(
      (segment) => segment.kind === "static",
    ).length;
    const candidate = {
      method,
      path,
      segments,
      staticSegments,
      access,
      handler,
    } satisfies RouteDefinition;

    for (const route of this.routes) {
      if (
        route.method === method &&
        route.staticSegments === staticSegments &&
        patternsOverlap(route.segments, candidate.segments)
      ) {
        throw new Error("admin_compat_route_conflict");
      }
    }
    this.routes.push(candidate);
  }

  private findCanonicalStatusRoute(
    request: Request,
  ): RouteDefinition | undefined {
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") return undefined;
    let pathname: string;
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      return undefined;
    }
    return this.routes.find(
      (route) =>
        route.access === "status" &&
        route.method === "GET" &&
        `${COMPAT_BASE_PATH}${route.path}` === pathname,
    );
  }

  private async dispatchAuthenticated(
    request: Request,
    runtime: AdminCompatRuntime,
    userId: string,
    csrfVerified: boolean,
    routeSegments?: readonly string[],
  ): Promise<Response> {
    const pathSegments = this.resolveRequestPathSegments(
      request,
      runtime.security.trustProxyHeaders,
    );
    if (
      routeSegments &&
      (!routeSegments.every(isSafeDecodedSegment) ||
        !segmentsEqual(routeSegments, pathSegments))
    ) {
      throw invalidPath();
    }
    const pathMatches = this.routes
      .map((route) => ({
        route,
        params: matchRoute(route.segments, pathSegments),
      }))
      .filter(
        (
          match,
        ): match is {
          route: RouteDefinition;
          params: Readonly<Record<string, string>>;
        } => match.params !== null,
      );

    if (pathMatches.length === 0) {
      return errorResponse(404, "not_found", "route_not_found");
    }

    const requestMethod = normalizeMethod(request.method);
    const allow = buildAllowHeader(pathMatches.map(({ route }) => route));
    if (requestMethod === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { allow },
      });
    }

    const effectiveMethod =
      requestMethod === "HEAD" ? "GET" : requestMethod;
    const selected = pathMatches
      .filter(({ route }) => route.method === effectiveMethod)
      .sort(
        (left, right) =>
          right.route.staticSegments - left.route.staticSegments,
      )[0];
    if (!selected) {
      return errorResponse(
        405,
        "invalid_request",
        "method_not_allowed",
        undefined,
        { allow },
      );
    }

    if (selected.route.access === "status") {
      return toResponse(
        await (
          selected.route.handler as AdminCompatStatusHandler
        )(request),
      );
    }
    if (selected.route.access === "session") {
      return toResponse(
        await (
          selected.route.handler as AdminCompatSessionHandler
        )({
          request,
          params: selected.params,
          userId,
          csrfVerified:
            csrfVerified && MUTATION_METHODS.has(requestMethod),
        }),
      );
    }

    return runtime.withUserDataLease(userId, async (resources, signal) => {
      signal.throwIfAborted();
      const scope = await runtime.resolveDefaultScope(
        userId,
        resources,
        signal,
      );
      signal.throwIfAborted();
      const result = await (
        selected.route.handler as AdminCompatHandler
      )({
        request,
        params: selected.params,
        scope,
        csrfVerified:
          csrfVerified && MUTATION_METHODS.has(requestMethod),
        resources,
        signal,
      });
      signal.throwIfAborted();
      return toResponse(result);
    });
  }

  private resolveRequestPathSegments(
    request: Request,
    trustProxyHeaders: boolean,
  ): readonly string[] {
    const canonicalPathSegments = parseAdminCompatPath(
      extractCompatPath(request.url),
    );
    const originalPath = readTrustedOriginalRequestPath(
      request,
      trustProxyHeaders,
    );
    const pathSegments =
      originalPath === null
        ? canonicalPathSegments
        : parseAdminCompatPath(
            extractCompatPathname(originalPath),
          );
    if (
      originalPath !== null &&
      !segmentsEqual(pathSegments, canonicalPathSegments)
    ) {
      throw invalidPath();
    }
    return pathSegments;
  }
}

export function parseAdminCompatPath(
  rawPath: string,
): readonly string[] {
  if (!rawPath.startsWith("/")) {
    throw invalidPath();
  }
  if (rawPath === "/") return [];

  const rawSegments = rawPath.slice(1).split("/");
  if (rawSegments.some((segment) => segment.length === 0)) {
    throw invalidPath();
  }

  return rawSegments.map((rawSegment) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSegment);
    } catch {
      throw invalidPath();
    }
    if (!isSafeDecodedSegment(decoded)) {
      throw invalidPath();
    }
    return decoded;
  });
}

function isSafeDecodedSegment(decoded: string): boolean {
  return !(
    decoded.length === 0 ||
    decoded === "." ||
    decoded === ".." ||
    decoded.includes("/") ||
    decoded.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(decoded) ||
    /%(?:2e|2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/iu.test(decoded)
  );
}

function extractCompatPath(requestUrl: string): string {
  let pathname: string;
  try {
    pathname = new URL(requestUrl).pathname;
  } catch {
    throw invalidPath();
  }
  return extractCompatPathname(pathname);
}

function extractCompatPathname(pathname: string): string {
  if (pathname === COMPAT_BASE_PATH) return "/";
  if (!pathname.startsWith(`${COMPAT_BASE_PATH}/`)) {
    throw invalidPath();
  }
  return pathname.slice(COMPAT_BASE_PATH.length);
}

function segmentsEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((segment, index) => segment === right[index])
  );
}

function parsePattern(path: string): readonly PatternSegment[] {
  const segments = parseAdminCompatPath(path);
  const parameterNames = new Set<string>();
  return segments.map((segment) => {
    if (!segment.startsWith(":")) {
      return { kind: "static", value: segment };
    }
    const name = segment.slice(1);
    if (
      !/^[A-Za-z][A-Za-z0-9_]*$/.test(name) ||
      parameterNames.has(name)
    ) {
      throw new Error("admin_compat_route_invalid");
    }
    parameterNames.add(name);
    return { kind: "dynamic", name };
  });
}

function patternsOverlap(
  left: readonly PatternSegment[],
  right: readonly PatternSegment[],
): boolean {
  return (
    left.length === right.length &&
    left.every((segment, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        (segment.kind === "dynamic" ||
          other.kind === "dynamic" ||
          segment.value === other.value)
      );
    })
  );
}

function matchRoute(
  pattern: readonly PatternSegment[],
  path: readonly string[],
): Readonly<Record<string, string>> | null {
  if (pattern.length !== path.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const segment = pattern[index];
    const value = path[index];
    if (!segment || value === undefined) return null;
    if (segment.kind === "static") {
      if (segment.value !== value) return null;
    } else {
      params[segment.name] = value;
    }
  }
  return params;
}

function normalizeMethod(method: string): CompatMethod | string {
  return method.toUpperCase();
}

function buildAllowHeader(routes: readonly RouteDefinition[]): string {
  const registered = new Set(routes.map((route) => route.method));
  const allow = METHODS.filter((method) => {
    if (method === "HEAD") return registered.has("GET");
    if (method === "OPTIONS") return true;
    return registered.has(method);
  });
  return allow.join(", ");
}

function invalidPath(): AdminCompatError {
  return new AdminCompatError(
    400,
    "invalid_request",
    "invalid_path",
  );
}

function mapError(error: unknown): Response {
  if (error instanceof AdminCompatError) {
    if (normalizeErrorStatus(error.status) === 500) {
      return errorResponse(
        500,
        "internal_error",
        "internal_error",
      );
    }
    return errorResponse(
      normalizeErrorStatus(error.status),
      error.code,
      error.publicMessage,
      sanitizeDetails(error.code, error.details),
    );
  }
  if (error instanceof AdminAuditError) {
    if (
      error.status === 400 &&
      ADMIN_AUDIT_VALIDATION_CODES.has(error.code)
    ) {
      return errorResponse(400, "invalid_request", error.code);
    }
    if (
      error.status === 409 &&
      error.code === "config_revision_conflict"
    ) {
      return errorResponse(
        409,
        "config_revision_conflict",
        "revision_conflict",
      );
    }
    return errorResponse(500, "internal_error", "internal_error");
  }
  if (error instanceof ZodError) {
    return errorResponse(
      400,
      "invalid_request",
      "validation_failed",
      {
        issues: error.issues.map((issue) => ({
          code: issue.code,
          path: issue.path.map(String),
        })),
      },
    );
  }
  if (isRevisionConflict(error)) {
    return errorResponse(
      409,
      "config_revision_conflict",
      "revision_conflict",
    );
  }
  if (isCapabilityDisabled(error)) {
    return errorResponse(
      501,
      "capability_disabled",
      "capability_disabled",
      sanitizeDetails(error.code, error.details),
    );
  }
  return errorResponse(500, "internal_error", "internal_error");
}

function isRevisionConflict(
  error: unknown,
): error is { status: number; code: string } {
  if (!isErrorRecord(error) || error.status !== 409) return false;
  return error.code === "revision_conflict";
}

function isCapabilityDisabled(
  error: unknown,
): error is {
  status: number;
  code: string;
  details?: unknown;
} {
  return (
    isErrorRecord(error) &&
    error.status === 501 &&
    error.code === "capability_disabled"
  );
}

function isErrorRecord(
  error: unknown,
): error is Record<string, unknown> & {
  status: number;
  code: string;
} {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof Reflect.get(error, "status") === "number" &&
    typeof Reflect.get(error, "code") === "string"
  );
}

function normalizeErrorStatus(status: number): number {
  return [400, 401, 403, 404, 405, 409, 413, 501].includes(status)
    ? status
    : 500;
}

function sanitizeDetails(
  errorCode: string,
  value: unknown,
): unknown {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return undefined;
  }

  const details = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  if (errorCode === "capability_disabled") {
    if (isStableCapabilityCode(details.capability)) {
      sanitized.capability = details.capability;
    }
  }
  if (
    errorCode === "config_revision_conflict" ||
    errorCode === "revision_conflict"
  ) {
    const currentRevision = details.current_revision;
    if (
      typeof currentRevision === "number" &&
      Number.isSafeInteger(currentRevision) &&
      currentRevision >= 0
    ) {
      sanitized.current_revision = currentRevision;
    }
  }
  return Object.keys(sanitized).length > 0
    ? sanitized
    : undefined;
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: unknown,
  headers?: HeadersInit,
): Response {
  const error = {
    code,
    message,
    ...(details === undefined ? {} : { details }),
  };
  return Response.json(
    { error } satisfies AdminCompatErrorBody,
    { status, headers },
  );
}

function toResponse(result: Response | unknown): Response {
  return result instanceof Response ? result : Response.json(result);
}

function normalizeResponse(
  response: Response,
  requestMethod: string,
): Response {
  const headers = new Headers();
  for (const [name, value] of response.headers) {
    if (SAFE_HANDLER_RESPONSE_HEADERS.has(name.toLowerCase())) {
      headers.set(name, value);
    }
  }
  const allow = response.headers.get("allow");
  if (allow) headers.set("allow", allow);
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");

  const cannotHaveBody =
    requestMethod.toUpperCase() === "HEAD" ||
    response.status === 204 ||
    response.status === 205 ||
    response.status === 304;
  return new Response(cannotHaveBody ? null : response.body, {
    status: response.status,
    headers,
  });
}
