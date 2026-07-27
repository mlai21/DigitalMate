import path from "node:path";
import { access } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionToken,
  sessionCookieName,
} from "@/server/auth/session";
import {
  createCsrfToken,
  deriveCsrfSecret,
} from "@/server/http/csrf";

const appSecret = "route-test-app-secret-value";
const defaultUserId = "user-1";

const mocks = vi.hoisted(() => {
  const ensureDefault = vi.fn(async () => ({
    id: "user-1",
    displayName: "Tang",
  }));
  const getGeneration = vi.fn(async () => 1);
  const createRepositories = vi.fn(() => ({
    users: { ensureDefault },
    sessionStates: { getGeneration },
  }));
  const readEnv = vi.fn(() => ({
    appPassword: "password",
    appSecret: "route-test-app-secret-value",
    trustProxyHeaders: false,
  }));
  return {
    createRepositories,
    ensureDefault,
    getGeneration,
    readEnv,
  };
});

vi.mock("@/server/db/repositories", () => ({
  createRepositories: mocks.createRepositories,
}));

vi.mock("@/server/config/env", () => ({
  readEnv: mocks.readEnv,
}));

import {
  DELETE,
  GET,
  HEAD,
  OPTIONS,
  PATCH,
  POST,
  PUT,
  runtime,
} from "@/app/api/admin/compat/[...segments]/route";
import { createAdminCompatRouteHandler } from "@/server/admin/compat/route-handler";

type RouteHandler = typeof GET;

const mutationHandlers = {
  POST,
  PUT,
  PATCH,
  DELETE,
} satisfies Record<string, RouteHandler>;

function routeContext(
  params: Promise<{ segments?: string[] }> = Promise.resolve({
    segments: ["auth", "status"],
  }),
) {
  return { params };
}

function statusRequest(
  method: string,
  headers?: HeadersInit,
): Request {
  return new Request(
    "https://mate.example/api/admin/compat/auth/status",
    { method, headers },
  );
}

async function authenticatedHeaders(
  includeCsrf: boolean,
): Promise<Headers> {
  const sessionToken = await createSessionToken(
    defaultUserId,
    1,
    appSecret,
  );
  const headers = new Headers({
    cookie: `${sessionCookieName}=${sessionToken}`,
    origin: "https://mate.example",
  });
  if (includeCsrf) {
    headers.set(
      "x-csrf-token",
      createCsrfToken({
        userId: defaultUserId,
        sessionToken,
        secret: deriveCsrfSecret(appSecret),
      }),
    );
  }
  return headers;
}

async function expectFixedInternalError(
  response: Response,
): Promise<void> {
  const serialized = JSON.stringify(await response.json());
  expect(response.status).toBe(500);
  expect(response.headers.get("content-type")).toContain(
    "application/json",
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe(
    "nosniff",
  );
  expect(serialized).toBe(
    '{"error":{"code":"internal_error","message":"internal_error"}}',
  );
  expect(serialized).not.toContain("secret-value");
}

describe("Console catch-all route", () => {
  beforeEach(() => {
    mocks.ensureDefault.mockReset();
    mocks.ensureDefault.mockResolvedValue({
      id: defaultUserId,
      displayName: "Tang",
    });
    mocks.getGeneration.mockReset();
    mocks.getGeneration.mockResolvedValue(1);
    mocks.createRepositories.mockReset();
    mocks.createRepositories.mockImplementation(() => ({
      users: { ensureDefault: mocks.ensureDefault },
      sessionStates: { getGeneration: mocks.getGeneration },
    }));
    mocks.readEnv.mockReset();
    mocks.readEnv.mockReturnValue({
      appPassword: "password",
      appSecret,
      trustProxyHeaders: false,
    });
  });

  it("has one Next.js route entry and no static auth-status shadow", async () => {
    const compatRoot = path.join(
      process.cwd(),
      "src/app/api/admin/compat",
    );
    await expect(
      access(path.join(compatRoot, "[...segments]/route.ts")),
    ).resolves.toBeUndefined();
    await expect(
      access(path.join(compatRoot, "auth/status/route.ts")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    expect(runtime).toBe("nodejs");
    expect(GET).toBe(HEAD);
    expect(GET).toBe(OPTIONS);
    expect(GET).toBe(POST);
    expect(GET).toBe(PUT);
    expect(GET).toBe(PATCH);
    expect(GET).toBe(DELETE);
  });

  it("serves the unchanged public Console auth-status path through the real catch-all", async () => {
    const response = await GET(statusRequest("GET"), routeContext());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      enabled: true,
      authenticated: false,
      csrf_token: "",
      csrf_expires_at: null,
    });
    expect(mocks.ensureDefault).toHaveBeenCalledOnce();
  });

  it("returns the shared authenticated status and CSRF token through the real catch-all", async () => {
    const response = await GET(
      statusRequest("GET", await authenticatedHeaders(false)),
      routeContext(),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      enabled: true,
      authenticated: true,
      csrf_expires_at: expect.any(Number),
    });
    expect(body.csrf_token).toEqual(expect.any(String));
    expect(String(body.csrf_token)).not.toContain(appSecret);
  });

  it("runs status HEAD through the GET registration without a body", async () => {
    const response = await HEAD(
      statusRequest("HEAD"),
      routeContext(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(
      "application/json",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe(
      "nosniff",
    );
    expect(await response.text()).toBe("");
  });

  it.each(Object.entries(mutationHandlers))(
    "%s applies authentication, CSRF and then the status-route 405 contract",
    async (method, handler) => {
      const unauthenticated = await handler(
        statusRequest(method),
        routeContext(),
      );
      expect(unauthenticated.status).toBe(401);
      await expect(unauthenticated.json()).resolves.toEqual({
        error: {
          code: "unauthorized",
          message: "unauthorized",
        },
      });

      const withoutCsrf = await handler(
        statusRequest(
          method,
          await authenticatedHeaders(false),
        ),
        routeContext(),
      );
      expect(withoutCsrf.status).toBe(403);
      await expect(withoutCsrf.json()).resolves.toEqual({
        error: { code: "forbidden", message: "forbidden" },
      });

      const acceptedBySecurity = await handler(
        statusRequest(method, await authenticatedHeaders(true)),
        routeContext(),
      );
      expect(acceptedBySecurity.status).toBe(405);
      expect(acceptedBySecurity.headers.get("allow")).toBe(
        "GET, HEAD, OPTIONS",
      );
      await expect(acceptedBySecurity.json()).resolves.toEqual({
        error: {
          code: "invalid_request",
          message: "method_not_allowed",
        },
      });
    },
  );

  it("authenticates OPTIONS before returning the exact status-route Allow header", async () => {
    const unauthenticated = await OPTIONS(
      statusRequest("OPTIONS"),
      routeContext(),
    );
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("allow")).toBeNull();

    const authenticated = await OPTIONS(
      statusRequest(
        "OPTIONS",
        await authenticatedHeaders(false),
      ),
      routeContext(),
    );
    expect(authenticated.status).toBe(204);
    expect(authenticated.headers.get("allow")).toBe(
      "GET, HEAD, OPTIONS",
    );
    expect(await authenticated.text()).toBe("");
  });

  it("rejects a trusted unsafe original URI through the catch-all router", async () => {
    mocks.readEnv.mockReturnValueOnce({
      appPassword: "password",
      appSecret,
      trustProxyHeaders: true,
    });

    const response = await GET(
      statusRequest("GET", {
        "x-digitalmate-original-uri":
          "/api/admin/compat/private/%2e%2e/auth/status",
      }),
      routeContext(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "invalid_request", message: "invalid_path" },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe(
      "nosniff",
    );
  });

  it.each([
    {
      label: "factory",
      prepare: () => undefined,
      invoke: () =>
        createAdminCompatRouteHandler(() => {
          throw new Error("factory-secret-value");
        })(statusRequest("GET"), routeContext()),
    },
    {
      label: "environment",
      prepare: () =>
        mocks.readEnv.mockImplementationOnce(() => {
          throw new Error("environment-secret-value");
        }),
      invoke: () => GET(statusRequest("GET"), routeContext()),
    },
    {
      label: "database",
      prepare: () =>
        mocks.ensureDefault.mockRejectedValueOnce(
          new Error("database-secret-value"),
        ),
      invoke: () => GET(statusRequest("GET"), routeContext()),
    },
    {
      label: "params",
      prepare: () => undefined,
      invoke: () =>
        GET(
          statusRequest("GET"),
          routeContext(
            Promise.reject(new Error("params-secret-value")),
          ),
        ),
    },
  ])("returns a fixed outer 500 when $label initialization fails", async ({
    prepare,
    invoke,
  }) => {
    prepare();
    await expectFixedInternalError(await invoke());
  });

  it("keeps an outer HEAD initialization failure bodyless", async () => {
    mocks.readEnv.mockImplementationOnce(() => {
      throw new Error("head-environment-secret-value");
    });

    const response = await HEAD(
      statusRequest("HEAD"),
      routeContext(),
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain(
      "application/json",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe(
      "nosniff",
    );
    expect(await response.text()).toBe("");
  });
});
