import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createCsrfToken,
  deriveCsrfSecret,
  verifyCsrfToken,
} from "@/server/http/csrf";
import {
  createAdminAuthStatusResponse,
  dispatchAdminSecurityBoundary,
  type AdminSecurityOptions,
} from "@/server/admin/compat/security";
import {
  createSessionToken,
  sessionCookieName,
} from "@/server/auth/session";
import {
  AdminCompatRouter,
  parseAdminCompatPath,
  type AdminCompatRuntime,
} from "@/server/admin/compat/router";
import { AdminAuditError } from "@/server/admin/audit";
import {
  AdminCompatError,
  type AdminCompatResources,
} from "@/server/admin/compat/types";
import {
  createCoreAdminCompatRouter,
  type CoreAdminCompatDependencies,
} from "@/server/admin/compat/register-core";
import { createUserPreferencesRepository } from "@/server/settings/user-preferences";
import { SecretEncryptionError } from "@/server/security/encrypted-secret";
import {
  DELETE as CATCH_ALL_DELETE,
  GET as CATCH_ALL_GET,
  HEAD as CATCH_ALL_HEAD,
  OPTIONS as CATCH_ALL_OPTIONS,
  PATCH as CATCH_ALL_PATCH,
  POST as CATCH_ALL_POST,
  PUT as CATCH_ALL_PUT,
  runtime as catchAllRuntime,
} from "@/app/api/admin/compat/[...segments]/route";
import { createAdminCompatRouteHandler } from "@/server/admin/compat/route-handler";

const userId = "user-1";
const appSecret = "test-app-secret-that-is-not-plaintext-csrf";
const now = new Date("2026-07-24T00:00:00.000Z");

function options(
  overrides: Partial<AdminSecurityOptions> = {},
): AdminSecurityOptions {
  return {
    defaultUserId: userId,
    appSecret,
    appPasswordEnabled: true,
    production: true,
    trustProxyHeaders: false,
    loadSessionGeneration: async () => 1,
    now,
    ...overrides,
  };
}

async function authenticatedFixture(input?: {
  origin?: string;
  requestUrl?: string;
  headers?: Record<string, string>;
  security?: Partial<AdminSecurityOptions>;
}) {
  const sessionToken = await createSessionToken(userId, 1, appSecret, now);
  const security = options(input?.security);
  const token = createCsrfToken({
    userId,
    sessionToken,
    secret: deriveCsrfSecret(appSecret),
    now,
  });
  const headers = new Headers({
    cookie: `${sessionCookieName}=${sessionToken}`,
    ...(input?.origin === undefined
      ? { origin: "https://mate.example" }
      : input.origin
        ? { origin: input.origin }
        : {}),
    "x-csrf-token": token,
    ...input?.headers,
  });
  return {
    security,
    sessionToken,
    token,
    request(method = "POST") {
      return new Request(
        input?.requestUrl ??
          "https://mate.example/api/admin/compat/agents/default",
        { method, headers },
      );
    },
  };
}

async function dispatch(
  request: Request,
  security: AdminSecurityOptions,
) {
  const handler = vi.fn(async () =>
    Response.json({ entered: true }, { status: 200 }),
  );
  const response = await dispatchAdminSecurityBoundary(
    request,
    security,
    handler,
  );
  return { handler, response };
}

describe("admin compatibility CSRF token", () => {
  it("binds a short-lived signed token to the user and exact session", async () => {
    const sessionToken = await createSessionToken(userId, 1, appSecret, now);
    const secret = deriveCsrfSecret(appSecret);
    const token = createCsrfToken({
      userId,
      sessionToken,
      secret,
      now,
    });

    expect(
      verifyCsrfToken(token, {
        userId,
        sessionToken,
        secret,
        now: new Date(now.getTime() + 1_000),
      }),
    ).toBe(true);
    expect(
      verifyCsrfToken(token, {
        userId: "user-2",
        sessionToken,
        secret,
        now,
      }),
    ).toBe(false);
    expect(
      verifyCsrfToken(token, {
        userId,
        sessionToken: await createSessionToken(userId, 1, appSecret, now),
        secret,
        now,
      }),
    ).toBe(false);
    expect(
      verifyCsrfToken(token, {
        userId,
        sessionToken,
        secret: deriveCsrfSecret("different-app-secret-value"),
        now,
      }),
    ).toBe(false);
  });

  it("rejects expiration, excessive future time, tampering and malformed fields", async () => {
    const sessionToken = await createSessionToken(userId, 1, appSecret, now);
    const secret = deriveCsrfSecret(appSecret);
    const token = createCsrfToken({
      userId,
      sessionToken,
      secret,
      now,
    });
    const [tokenUser, sessionHash, expiresAt, nonce, signature] =
      token.split(".");

    expect(
      verifyCsrfToken(token, {
        userId,
        sessionToken,
        secret,
        now: new Date(now.getTime() + 1_801_000),
      }),
    ).toBe(false);

    const futureToken = createCsrfToken({
      userId,
      sessionToken,
      secret,
      now: new Date(now.getTime() + 60_000),
    });
    expect(
      verifyCsrfToken(futureToken, {
        userId,
        sessionToken,
        secret,
        now,
      }),
    ).toBe(false);

    const malformed = [
      "",
      token.replace(/.$/, signature?.endsWith("A") ? "B" : "A"),
      `${tokenUser}.${sessionHash}.${expiresAt}.${nonce}`,
      `${tokenUser}.${sessionHash}.${expiresAt}.${nonce}.${signature}.extra`,
      `${tokenUser}.${sessionHash}.${expiresAt}.${"a".repeat(23)}.${signature}`,
      `${tokenUser}.${sessionHash}.${expiresAt}x.${nonce}.${signature}`,
      `${tokenUser}.${"a".repeat(42)}.${expiresAt}.${nonce}.${signature}`,
      `${tokenUser}.${sessionHash}.${expiresAt}.${nonce}.${"a".repeat(42)}`,
      `user%2E1.${sessionHash}.${expiresAt}.${nonce}.${signature}`,
    ];
    for (const candidate of malformed) {
      expect(
        verifyCsrfToken(candidate, {
          userId,
          sessionToken,
          secret,
          now,
        }),
      ).toBe(false);
    }
  });

  it("does not accept a correctly shaped payload with the wrong HMAC", async () => {
    const sessionToken = await createSessionToken(userId, 1, appSecret, now);
    const token = createCsrfToken({
      userId,
      sessionToken,
      secret: deriveCsrfSecret(appSecret),
      now,
    });
    const payload = token.split(".").slice(0, -1).join(".");
    const wrongSignature = createHmac("sha256", "wrong-signing-secret")
      .update(payload)
      .digest("base64url");

    expect(
      verifyCsrfToken(`${payload}.${wrongSignature}`, {
        userId,
        sessionToken,
        secret: deriveCsrfSecret(appSecret),
        now,
      }),
    ).toBe(false);
  });
});

describe("admin compatibility security boundary", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "%s rejects a missing CSRF token",
    async (method) => {
      const fixture = await authenticatedFixture();
      const request = fixture.request(method);
      request.headers.delete("x-csrf-token");

      const { handler, response } = await dispatch(
        request,
        fixture.security,
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: { code: "forbidden", message: "forbidden" },
      });
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "%s uniformly rejects wrong origin, expiration, user, session and tampering",
    async (method) => {
      const fixture = await authenticatedFixture();
      const secret = deriveCsrfSecret(appSecret);
      const invalidCases = [
        {
          origin: "https://evil.example",
          token: fixture.token,
        },
        {
          origin: "https://mate.example",
          token: createCsrfToken({
            userId,
            sessionToken: fixture.sessionToken,
            secret,
            now: new Date(now.getTime() - 1_801_000),
          }),
        },
        {
          origin: "https://mate.example",
          token: createCsrfToken({
            userId: "user-2",
            sessionToken: fixture.sessionToken,
            secret,
            now,
          }),
        },
        {
          origin: "https://mate.example",
          token: createCsrfToken({
            userId,
            sessionToken: await createSessionToken(userId, 1, appSecret, now),
            secret,
            now,
          }),
        },
        {
          origin: "https://mate.example",
          token: fixture.token.replace(
            /.$/,
            fixture.token.endsWith("A") ? "B" : "A",
          ),
        },
      ];

      for (const invalid of invalidCases) {
        const request = fixture.request(method);
        request.headers.set("origin", invalid.origin);
        request.headers.set("x-csrf-token", invalid.token);
        const { handler, response } = await dispatch(
          request,
          fixture.security,
        );
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({
          error: { code: "forbidden", message: "forbidden" },
        });
        expect(handler).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["GET", "HEAD", "OPTIONS"])(
    "%s requires authentication but does not require a CSRF token",
    async (method) => {
      const fixture = await authenticatedFixture();
      const request = fixture.request(method);
      request.headers.delete("origin");
      request.headers.delete("x-csrf-token");

      const { handler, response } = await dispatch(
        request,
        fixture.security,
      );

      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalledOnce();
    },
  );

  it("rejects unauthenticated reads with the stable 401 contract", async () => {
    const { handler, response } = await dispatch(
      new Request("https://mate.example/api/admin/compat/root"),
      options(),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "unauthorized", message: "unauthorized" },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("only enters the handler with a valid cookie, origin and token", async () => {
    const fixture = await authenticatedFixture();
    const { handler, response } = await dispatch(
      fixture.request(),
      fixture.security,
    );

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        csrfVerified: true,
        request: expect.any(Request),
      }),
    );
  });

  it.each([
    ["missing origin", ""],
    ["opaque origin", "null"],
    ["cross-site origin", "https://evil.example"],
    ["multiple origins", "https://mate.example, https://evil.example"],
    ["userinfo origin", "https://user@mate.example"],
    ["trailing-dot origin", "https://mate.example."],
    ["non-http origin", "ftp://mate.example"],
    ["origin with path", "https://mate.example/path"],
  ])("rejects %s without exposing the reason", async (_label, origin) => {
    const fixture = await authenticatedFixture({ origin });
    const { handler, response } = await dispatch(
      fixture.request(),
      fixture.security,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "forbidden", message: "forbidden" },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("normalizes only a legitimate default port", async () => {
    const fixture = await authenticatedFixture({
      requestUrl:
        "https://mate.example:443/api/admin/compat/agents/default",
      origin: "https://mate.example",
    });

    expect(
      (await dispatch(fixture.request(), fixture.security)).response.status,
    ).toBe(200);
  });

  it("ignores forwarded headers unless the proxy policy is explicitly enabled", async () => {
    const fixture = await authenticatedFixture({
      headers: {
        "x-forwarded-proto": "http",
        "x-forwarded-host": "evil.example",
      },
    });

    expect(
      (await dispatch(fixture.request(), fixture.security)).response.status,
    ).toBe(200);
  });

  it("uses one strict forwarded proto/host pair when proxy trust is enabled", async () => {
    const fixture = await authenticatedFixture({
      requestUrl:
        "http://web:3000/api/admin/compat/agents/default",
      origin: "https://mate.example",
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "mate.example:443",
      },
      security: { trustProxyHeaders: true },
    });

    expect(
      (await dispatch(fixture.request(), fixture.security)).response.status,
    ).toBe(200);
  });

  it.each([
    {
      "x-forwarded-proto": "https,http",
      "x-forwarded-host": "mate.example",
    },
    {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "mate.example,evil.example",
    },
    {
      "x-forwarded-proto": "javascript",
      "x-forwarded-host": "mate.example",
    },
    {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "user@mate.example",
    },
    {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "mate.example.",
    },
    {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "mate.example:443@evil.example",
    },
    {
      "x-forwarded-proto": "https",
    },
  ] as Array<Record<string, string>>)(
    "rejects malformed trusted proxy headers: %j",
    async (headers) => {
    const fixture = await authenticatedFixture({
      requestUrl:
        "http://web:3000/api/admin/compat/agents/default",
      origin: "https://mate.example",
      headers,
      security: { trustProxyHeaders: true },
    });

      expect(
        (await dispatch(fixture.request(), fixture.security)).response
          .status,
      ).toBe(403);
    },
  );

  it("keeps same-origin CSRF protection when development has no password", async () => {
    const security = options({
      appPasswordEnabled: false,
      production: false,
    });
    const statusResponse = await createAdminAuthStatusResponse(
      new Request(
        "http://localhost:3000/api/admin/compat/auth/status",
      ),
      security,
    );
    const status = (await statusResponse.json()) as {
      enabled: boolean;
      authenticated: boolean;
      csrf_token: string;
    };

    expect(status).toMatchObject({
      enabled: false,
      authenticated: true,
    });
    expect(status.csrf_token).toMatch(/^[A-Za-z0-9_.-]+$/);

    const request = new Request(
      "http://localhost:3000/api/admin/compat/agents/default",
      {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "x-csrf-token": status.csrf_token,
        },
      },
    );
    expect((await dispatch(request, security)).response.status).toBe(200);

    request.headers.set("origin", "http://evil.example");
    expect((await dispatch(request, security)).response.status).toBe(403);
  });

  it("returns no CSRF token to an unauthenticated status request", async () => {
    const response = await createAdminAuthStatusResponse(
      new Request(
        "https://mate.example/api/admin/compat/auth/status",
      ),
      options(),
    );

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      enabled: true,
      authenticated: false,
      csrf_token: "",
      csrf_expires_at: null,
    });
  });

  it("returns 401 and no CSRF for a revoked cookie and rejects its old write pair", async () => {
    const fixture = await authenticatedFixture({
      security: {
        loadSessionGeneration: async () => 2,
      },
    });
    const statusResponse = await createAdminAuthStatusResponse(
      fixture.request("GET"),
      fixture.security,
    );

    expect(statusResponse.status).toBe(401);
    expect(await statusResponse.json()).toEqual({
      enabled: true,
      authenticated: false,
      csrf_token: "",
      csrf_expires_at: null,
    });

    const { handler, response } = await dispatch(
      fixture.request("POST"),
      fixture.security,
    );
    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not log or echo invalid tokens and signing material", async () => {
    const fixture = await authenticatedFixture();
    const invalidToken = `${fixture.token}tampered`;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const request = fixture.request();
    request.headers.set("x-csrf-token", invalidToken);

    const { response } = await dispatch(request, fixture.security);
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(403);
    expect(serialized).not.toContain(invalidToken);
    expect(serialized).not.toContain(appSecret);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });
});

function routerRuntime(
  security: AdminSecurityOptions,
  overrides: Partial<AdminCompatRuntime> = {},
): AdminCompatRuntime {
  return {
    security,
    withUserDataLease: async (_userId, work) =>
      work({} as AdminCompatResources, new AbortController().signal),
    resolveDefaultScope: async (resolvedUserId) => ({
      userId: resolvedUserId,
      agentId: "agent-1",
    }),
    ...overrides,
  };
}

async function authenticatedRouterRequest(
  method: string,
  path: string,
  securityOverrides: Partial<AdminSecurityOptions> = {},
): Promise<{ request: Request; runtime: AdminCompatRuntime }> {
  const fixture = await authenticatedFixture({
    requestUrl: `https://mate.example/api/admin/compat${path}`,
    security: securityOverrides,
  });
  return {
    request: fixture.request(method),
    runtime: routerRuntime(fixture.security),
  };
}

describe("admin compatibility exact router", () => {
  it("distinguishes methods, supports GET-backed HEAD and returns an exact Allow header", async () => {
    const router = new AdminCompatRouter();
    router.get("/root", async () => ({ version: "digitalmate" }));

    const get = await authenticatedRouterRequest("GET", "/root");
    const getResponse = await router.dispatch(get.request, get.runtime);
    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toEqual({
      version: "digitalmate",
    });

    const head = await authenticatedRouterRequest("HEAD", "/root");
    const headResponse = await router.dispatch(head.request, head.runtime);
    expect(headResponse.status).toBe(200);
    expect(await headResponse.text()).toBe("");
    expect(headResponse.headers.get("content-type")).toContain(
      "application/json",
    );

    const post = await authenticatedRouterRequest("POST", "/root");
    const postResponse = await router.dispatch(post.request, post.runtime);
    expect(postResponse.status).toBe(405);
    expect(postResponse.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
    await expect(postResponse.json()).resolves.toEqual({
      error: {
        code: "invalid_request",
        message: "method_not_allowed",
      },
    });
  });

  it("does not reveal OPTIONS endpoints before authentication", async () => {
    const router = new AdminCompatRouter();
    router.get("/root", async () => ({ ok: true }));
    router.put("/root", async () => ({ ok: true }));

    const unauthenticated = await router.dispatch(
      new Request("https://mate.example/api/admin/compat/root", {
        method: "OPTIONS",
      }),
      routerRuntime(options()),
    );
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("allow")).toBeNull();

    const authenticated = await authenticatedRouterRequest(
      "OPTIONS",
      "/root",
    );
    const response = await router.dispatch(
      authenticated.request,
      authenticated.runtime,
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("allow")).toBe(
      "GET, HEAD, PUT, OPTIONS",
    );
    expect(await response.text()).toBe("");
  });

  it("decodes each segment once and gives fixed routes priority over dynamic routes", async () => {
    const router = new AdminCompatRouter();
    router.get("/agents/:agentId", async ({ params }) => ({
      kind: "dynamic",
      agentId: params.agentId,
    }));
    router.get("/agents/default", async () => ({ kind: "fixed" }));

    const fixed = await authenticatedRouterRequest(
      "GET",
      "/agents/default",
    );
    await expect(
      (await router.dispatch(fixed.request, fixed.runtime)).json(),
    ).resolves.toEqual({ kind: "fixed" });

    const dynamic = await authenticatedRouterRequest(
      "GET",
      "/agents/%E6%95%B0%E5%AD%97%E5%88%86%E8%BA%AB",
    );
    await expect(
      (await router.dispatch(dynamic.request, dynamic.runtime)).json(),
    ).resolves.toEqual({
      kind: "dynamic",
      agentId: "数字分身",
    });
  });

  it.each([
    ["/agents/%", "malformed percent"],
    ["/agents/%2F", "encoded slash"],
    ["/agents/%5C", "encoded backslash"],
    ["/agents/%252F", "double-encoded slash"],
    ["/agents/%252e%252e", "double-encoded dot segment"],
    ["/agents/%00", "NUL"],
    ["/agents/%1F", "control character"],
    ["/agents//default", "repeated separator"],
    ["/agents/default/", "empty trailing segment"],
  ])("rejects unsafe path %s (%s)", async (path) => {
    expect(() => parseAdminCompatPath(path)).toThrow(
      expect.objectContaining({ code: "invalid_request" }),
    );
  });

  it.each([".", "..", "%2e", "%2e%2e"])(
    "rejects dot path segment %s before matching",
    (segment) => {
      expect(() => parseAdminCompatPath(`/agents/${segment}`)).toThrow(
        expect.objectContaining({ code: "invalid_request" }),
      );
    },
  );

  it.each([
    "/api/admin/compat/agents/%2e%2e/root",
    "/api/admin/compat/agents/%2E%2E/root",
    "/api/admin/compat/agents/../root",
    "/api/admin/compat/agents\\..\\root",
    "/api/admin/compat/agents/%252e%252e/root",
    "/api/admin/compat/agents/%2froot",
    "/api/admin/compat/agents/%5croot",
    "/api/admin/compat/agents//root",
    "/api/admin/compat/root/",
  ])("rejects a trusted unsafe original URI after auth: %s", async (originalUri) => {
    const router = new AdminCompatRouter();
    const handler = vi.fn(async () => ({ ok: true }));
    router.get("/root", handler);
    const fixture = await authenticatedFixture({
      requestUrl: "https://mate.example/api/admin/compat/root",
      headers: {
        "x-digitalmate-original-uri": originalUri,
      },
      security: { trustProxyHeaders: true },
    });

    const response = await router.dispatch(
      fixture.request("GET"),
      routerRuntime(fixture.security),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "invalid_request", message: "invalid_path" },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    "api/admin/compat/root",
    "//mate.example/api/admin/compat/root",
    "/api/admin/compat/root,/api/admin/compat/root",
    "/api/admin/compat/root\u007f",
  ])("fails closed for malformed trusted original URI %j", async (originalUri) => {
    const router = new AdminCompatRouter();
    const handler = vi.fn(async () => ({ ok: true }));
    router.get("/root", handler);
    const fixture = await authenticatedFixture({
      requestUrl: "https://mate.example/api/admin/compat/root",
      headers:
        originalUri === undefined
          ? undefined
          : { "x-digitalmate-original-uri": originalUri },
      security: { trustProxyHeaders: true },
    });

    const response = await router.dispatch(
      fixture.request("GET"),
      routerRuntime(fixture.security),
    );

    expect(response.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });

  it("ignores a spoofed original URI unless controlled proxy trust is enabled", async () => {
    const router = new AdminCompatRouter();
    const handler = vi.fn(async () => ({ ok: true }));
    router.get("/root", handler);
    const fixture = await authenticatedFixture({
      requestUrl: "https://mate.example/api/admin/compat/root",
      headers: {
        "x-digitalmate-original-uri":
          "/api/admin/compat/agents/%2e%2e/root",
      },
    });

    const response = await router.dispatch(
      fixture.request("GET"),
      routerRuntime(fixture.security),
    );

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("validates trusted raw paths before the public auth-status exception", async () => {
    const router = new AdminCompatRouter();
    const handler = vi.fn(async () => ({ authenticated: false }));
    router.statusGet("/auth/status", handler);
    const request = new Request(
      "https://mate.example/api/admin/compat/auth/status",
      {
        headers: {
          "x-digitalmate-original-uri":
            "/api/admin/compat/private/%2e%2e/auth/status",
        },
      },
    );

    const response = await router.dispatch(
      request,
      routerRuntime(options({ trustProxyHeaders: true })),
    );

    expect(response.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });

  it("accepts one legal trusted original URI and requires canonical params to agree", async () => {
    const router = new AdminCompatRouter();
    const handler = vi.fn(async () => ({ ok: true }));
    router.get("/root", handler);
    const fixture = await authenticatedFixture({
      requestUrl:
        "https://mate.example/api/admin/compat/root?tags=a,b",
      headers: {
        "x-digitalmate-original-uri":
          "/api/admin/compat/root?tags=a,b",
      },
      security: { trustProxyHeaders: true },
    });

    const accepted = await router.dispatch(
      fixture.request("GET"),
      routerRuntime(fixture.security),
      { routeSegments: ["root"] },
    );
    expect(accepted.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();

    const mismatched = await router.dispatch(
      fixture.request("GET"),
      routerRuntime(fixture.security),
      { routeSegments: ["agents", "default"] },
    );
    expect(mismatched.status).toBe(400);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("rejects multiple trusted original-URI header values after Fetch folding", async () => {
    const router = new AdminCompatRouter();
    const handler = vi.fn(async () => ({ ok: true }));
    router.get("/root", handler);
    const fixture = await authenticatedFixture({
      requestUrl: "https://mate.example/api/admin/compat/root",
      headers: {
        "x-digitalmate-original-uri": "/api/admin/compat/root",
      },
      security: { trustProxyHeaders: true },
    });
    const request = fixture.request("GET");
    request.headers.append(
      "x-digitalmate-original-uri",
      "/api/admin/compat/root",
    );

    const response = await router.dispatch(
      request,
      routerRuntime(fixture.security),
    );

    expect(request.headers.get("x-digitalmate-original-uri")).toContain(
      ", ",
    );
    expect(response.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });

  it("fails registration when two routes are ambiguous but allows fixed-over-dynamic precedence", () => {
    const router = new AdminCompatRouter();
    router.get("/agents/:agentId", async () => ({}));
    expect(() =>
      router.get("/agents/:otherId", async () => ({})),
    ).toThrow("admin_compat_route_conflict");
    expect(() =>
      router.get("/:section/default", async () => ({})),
    ).toThrow("admin_compat_route_conflict");

    const fixedRouter = new AdminCompatRouter();
    fixedRouter.get("/agents/:agentId", async () => ({}));
    expect(() =>
      fixedRouter.get("/agents/default", async () => ({})),
    ).not.toThrow();
    expect(() =>
      fixedRouter.put("/agents/:otherId", async () => ({})),
    ).not.toThrow();
  });

  it("returns the same 401 for known, unknown and malformed unauthenticated paths", async () => {
    const router = new AdminCompatRouter();
    router.get("/root", async () => ({ ok: true }));

    const bodies: unknown[] = [];
    for (const path of ["/root", "/unknown", "/agents/%2F"]) {
      const response = await router.dispatch(
        new Request(`https://mate.example/api/admin/compat${path}`),
        routerRuntime(options()),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("allow")).toBeNull();
      bodies.push(await response.json());
    }
    expect(bodies).toEqual([
      { error: { code: "unauthorized", message: "unauthorized" } },
      { error: { code: "unauthorized", message: "unauthorized" } },
      { error: { code: "unauthorized", message: "unauthorized" } },
    ]);
  });

  it("checks CSRF before exposing whether a write endpoint exists", async () => {
    const router = new AdminCompatRouter();
    const fixture = await authenticatedFixture({
      requestUrl:
        "https://mate.example/api/admin/compat/not-registered",
    });
    const request = fixture.request("POST");
    request.headers.delete("x-csrf-token");

    const response = await router.dispatch(
      request,
      routerRuntime(fixture.security),
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "forbidden", message: "forbidden" },
    });
  });

  it("maps validation, revision, disabled capability and unknown errors without leaking internals", async () => {
    const router = new AdminCompatRouter();
    router.put("/validation", async () => {
      z.object({ language: z.literal("zh") }).strict().parse({
        language: "secret-language-value",
      });
    });
    router.put("/revision", async () => {
      throw new AdminCompatError(
        409,
        "config_revision_conflict",
        "revision_conflict",
      );
    });
    router.post("/disabled", async () => {
      throw new AdminCompatError(
        501,
        "capability_disabled",
        "capability_disabled",
        { capability: "p2_sandbox" },
      );
    });
    router.get("/unknown", async () => {
      throw new Error(
        "postgres://admin:secret-password@db/internal_table",
      );
    });
    router.get("/explicit-500", async () => {
      throw new AdminCompatError(
        500,
        "database_failure",
        "postgres://admin:explicit-secret@db/private_table",
      );
    });

    const cases = [
      ["PUT", "/validation", 400, "invalid_request"],
      ["PUT", "/revision", 409, "config_revision_conflict"],
      ["POST", "/disabled", 501, "capability_disabled"],
      ["GET", "/unknown", 500, "internal_error"],
      ["GET", "/explicit-500", 500, "internal_error"],
    ] as const;
    for (const [method, path, status, code] of cases) {
      const fixture = await authenticatedRouterRequest(method, path);
      const response = await router.dispatch(
        fixture.request,
        fixture.runtime,
      );
      const serialized = JSON.stringify(await response.json());
      expect(response.status).toBe(status);
      expect(serialized).toContain(`"code":"${code}"`);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe(
        "nosniff",
      );
      expect(serialized).not.toContain("secret-language-value");
      expect(serialized).not.toContain("secret-password");
      expect(serialized).not.toContain("internal_table");
      expect(serialized).not.toContain("stack");
    }
  });

  it("sanitizes Zod paths with static fields and truncates dynamic record keys", async () => {
    const router = new AdminCompatRouter();
    router.put("/zod-paths", async () => {
      z.object({
        groups: z.record(
          z.string(),
          z
            .object({
              requireMention: z.boolean(),
            })
            .strict(),
        ),
        settings: z
          .object({
            cadence: z
              .object({
                maxSegments: z.number().int().max(20),
              })
              .strict(),
          })
          .strict(),
        agent_ids: z.array(z.string().uuid()),
      })
        .strict()
        .parse({
          groups: {
            PureAlphaRoom: {
              requireMention: "raw-value",
              StripeSecret: "SELECT secret FROM private_table",
            },
          },
          settings: {
            cadence: {
              maxSegments: 99,
            },
          },
          agent_ids: ["not-a-uuid"],
        });
    });
    const fixture = await authenticatedRouterRequest(
      "PUT",
      "/zod-paths",
    );

    const response = await router.dispatch(
      fixture.request,
      fixture.runtime,
    );
    const body = (await response.json()) as {
      error: {
        details: {
          issues: Array<{ code: string; path: Array<string | number> }>;
        };
      };
    };
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(400);
    expect(body.error.details.issues).toEqual(
      expect.arrayContaining([
        { code: "invalid_type", path: ["groups"] },
        { code: "unrecognized_keys", path: ["groups"] },
        {
          code: "too_big",
          path: ["settings", "cadence", "maxSegments"],
        },
        { code: "invalid_format", path: ["agent_ids", 0] },
      ]),
    );
    expect(serialized).not.toContain("PureAlphaRoom");
    expect(serialized).not.toContain("StripeSecret");
    expect(serialized).not.toContain("raw-value");
    expect(serialized).not.toContain("private_table");
  });

  it("sanitizes AdminCompat validation paths with the same fail-closed rules", async () => {
    const router = new AdminCompatRouter();
    const reflected = [
      "UnknownClearKey",
      "StripeSecretKey",
      "purealphasecret",
      "PureAlphaRoom",
      "UnknownTopLevel",
      "raw-value",
      "private_table",
    ];
    router.put("/compat-validation-paths", async () => {
      throw new AdminCompatError(
        400,
        "invalid_request",
        "validation_failed",
        {
          issues: [
            {
              code: "invalid_value",
              path: ["clear_secret", "UnknownClearKey"],
            },
            {
              code: "invalid_value",
              path: ["clear_secret", "StripeSecretKey"],
            },
            {
              code: "invalid_value",
              path: ["clear_secret", "purealphasecret"],
            },
            {
              code: "invalid_type",
              path: ["clear_secret", 0],
            },
            {
              code: "unrecognized_keys",
              path: ["groups", "PureAlphaRoom", "requireMention"],
            },
            {
              code: "unrecognized_keys",
              path: ["UnknownTopLevel"],
            },
            {
              code: "invalid_value",
              path: ["clear_secret", "bot_token"],
            },
            { code: "invalid_format", path: ["base_url"] },
            {
              code: "too_big",
              path: ["settings", "cadence", "maxSegments"],
            },
            {
              code: "invalid_format",
              path: ["agent_ids", 0],
            },
            {
              code: "invalid_format",
              path: ["agent_ids", 65_536],
            },
          ],
          raw: "raw-value",
          sql: "SELECT secret FROM private_table",
        },
      );
    });
    const fixture = await authenticatedRouterRequest(
      "PUT",
      "/compat-validation-paths",
    );

    const response = await router.dispatch(
      fixture.request,
      fixture.runtime,
    );
    const body = (await response.json()) as {
      error: {
        details: {
          issues: Array<{ code: string; path: Array<string | number> }>;
        };
      };
    };
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(400);
    expect(body.error.details.issues).toEqual([
      { code: "invalid_value", path: ["clear_secret"] },
      { code: "invalid_value", path: ["clear_secret"] },
      { code: "invalid_value", path: ["clear_secret"] },
      { code: "invalid_type", path: ["clear_secret"] },
      { code: "unrecognized_keys", path: ["groups"] },
      { code: "unrecognized_keys", path: [] },
      {
        code: "invalid_value",
        path: ["clear_secret", "bot_token"],
      },
      { code: "invalid_format", path: ["base_url"] },
      {
        code: "too_big",
        path: ["settings", "cadence", "maxSegments"],
      },
      { code: "invalid_format", path: ["agent_ids", 0] },
      { code: "invalid_format", path: ["agent_ids"] },
    ]);
    for (const value of reflected) {
      expect(serialized).not.toContain(value);
    }
  });

  it.each([
    "invalid_config_revision",
    "invalid_secret_field",
    "invalid_audit_config_field",
    "secret_in_audit_config",
    "secret_in_public_config",
    "invalid_secret_change",
    "invalid_channel_config",
    "invalid_confirmation_source",
  ])(
    "maps the allowlisted audit validation %s to an exact public 400",
    async (code) => {
      const router = new AdminCompatRouter();
      router.put("/audit-validation", async () => {
        throw Object.assign(new AdminAuditError(400, code), {
          details: { secret: "must-not-leak" },
        });
      });
      const fixture = await authenticatedRouterRequest(
        "PUT",
        "/audit-validation",
      );

      const response = await router.dispatch(
        fixture.request,
        fixture.runtime,
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "invalid_request",
          message: code,
        },
      });
    },
  );

  it("maps only the exact audit revision conflict combination to the stable public 409", async () => {
    const router = new AdminCompatRouter();
    router.put("/audit-revision", async () => {
      throw new AdminAuditError(409, "config_revision_conflict");
    });
    const fixture = await authenticatedRouterRequest(
      "PUT",
      "/audit-revision",
    );

    const response = await router.dispatch(
      fixture.request,
      fixture.runtime,
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "config_revision_conflict",
        message: "revision_conflict",
      },
    });
  });

  it.each([
    [400, "unknown_audit_error"],
    [409, "invalid_secret_change"],
    [418, "secret_in_public_config"],
    [500, "channel_config_update_failed"],
  ])(
    "maps unsupported AdminAuditError combination %s/%s to a fixed 500",
    async (status, code) => {
      const router = new AdminCompatRouter();
      router.put("/unsupported-audit", async () => {
        throw new AdminAuditError(status, code);
      });
      const fixture = await authenticatedRouterRequest(
        "PUT",
        "/unsupported-audit",
      );

      const response = await router.dispatch(
        fixture.request,
        fixture.runtime,
      );
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "internal_error",
          message: "internal_error",
        },
      });
    },
  );

  it.each([
    {
      label: "duck-typed validation",
      error: Object.assign(new Error("secret_in_public_config"), {
        status: 400,
        code: "secret_in_public_config",
      }),
    },
    {
      label: "duck-typed audit revision",
      error: Object.assign(new Error("config_revision_conflict"), {
        status: 409,
        code: "config_revision_conflict",
      }),
    },
    {
      label: "encryption error",
      error: new SecretEncryptionError("invalid_secret_context"),
    },
  ])("does not expose a $label", async ({ error }) => {
    const router = new AdminCompatRouter();
    router.put("/untrusted-error", async () => {
      throw error;
    });
    const fixture = await authenticatedRouterRequest(
      "PUT",
      "/untrusted-error",
    );

    const response = await router.dispatch(
      fixture.request,
      fixture.runtime,
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "internal_error",
        message: "internal_error",
      },
    });
  });

  it("preserves the structural settings revision conflict bridge", async () => {
    const router = new AdminCompatRouter();
    router.put("/settings-revision", async () => {
      throw Object.assign(new Error("revision_conflict"), {
        status: 409,
        code: "revision_conflict",
      });
    });
    const fixture = await authenticatedRouterRequest(
      "PUT",
      "/settings-revision",
    );

    const response = await router.dispatch(
      fixture.request,
      fixture.runtime,
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "config_revision_conflict",
        message: "revision_conflict",
      },
    });
  });

  it("only exposes allowlisted stable details and drops secret-shaped values even under safe keys", async () => {
    const router = new AdminCompatRouter();
    router.get("/safe-capability-details", async () => {
      throw new AdminCompatError(
        501,
        "capability_disabled",
        "capability_disabled",
        {
          capability: "p2_sandbox",
          current_revision: 7,
          note: "token=must-not-leak",
        },
      );
    });
    router.get("/safe-revision-details", async () => {
      throw new AdminCompatError(
        409,
        "config_revision_conflict",
        "revision_conflict",
        {
          current_revision: 12,
          capability: "must_not_cross_error_codes",
          context: "postgres://admin:secret@db/private",
        },
      );
    });

    const safeCapability = await authenticatedRouterRequest(
      "GET",
      "/safe-capability-details",
    );
    await expect(
      (
        await router.dispatch(
          safeCapability.request,
          safeCapability.runtime,
        )
      ).json(),
    ).resolves.toEqual({
      error: {
        code: "capability_disabled",
        message: "capability_disabled",
        details: { capability: "p2_sandbox" },
      },
    });

    const safeRevision = await authenticatedRouterRequest(
      "GET",
      "/safe-revision-details",
    );
    await expect(
      (
        await router.dispatch(
          safeRevision.request,
          safeRevision.runtime,
        )
      ).json(),
    ).resolves.toEqual({
      error: {
        code: "config_revision_conflict",
        message: "revision_conflict",
        details: { current_revision: 12 },
      },
    });

    const disallowedCapabilityValues = [
      "token=top-secret-value",
      "postgres://admin:password@db/private",
      "Authorization: Bearer abc.def.ghi",
      "Bearer abcdefghijklmnop",
      "sk-proj-1234567890abcdef",
      "sk_live_1234567890abcdef",
      "AIzaSyA1234567890abcdefghijklmnop",
      "innocuous_unknown_capability",
    ];
    for (
      const [index, secret] of disallowedCapabilityValues.entries()
    ) {
      const path = `/secret-details-${index}`;
      router.get(path, async () => {
        throw new AdminCompatError(
          501,
          "capability_disabled",
          "capability_disabled",
          {
            capability: secret,
            harmless: secret,
          },
        );
      });
      const fixture = await authenticatedRouterRequest("GET", path);
      const response = await router.dispatch(
        fixture.request,
        fixture.runtime,
      );
      const serialized = JSON.stringify(await response.json());

      expect(response.status).toBe(501);
      expect(serialized).toBe(
        '{"error":{"code":"capability_disabled","message":"capability_disabled"}}',
      );
      expect(serialized).not.toContain(secret);
    }
  });

  it.each([
    "p2_sandbox",
    "multi_agent",
    "multi_agent_create",
    "multi_agent_clone",
    "multi_agent_import",
    "multi_agent_delete",
  ])("exposes the approved stable capability code %s", async (capability) => {
    const router = new AdminCompatRouter();
    router.get("/disabled", async () => {
      throw new AdminCompatError(
        501,
        "capability_disabled",
        "capability_disabled",
        { capability },
      );
    });
    const fixture = await authenticatedRouterRequest(
      "GET",
      "/disabled",
    );
    const response = await router.dispatch(
      fixture.request,
      fixture.runtime,
    );

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "capability_disabled",
        message: "capability_disabled",
        details: { capability },
      },
    });
  });

  it("removes handler-controlled sensitive headers from successful responses", async () => {
    const router = new AdminCompatRouter();
    router.get(
      "/response",
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          headers: {
            "content-type": "application/json",
            "set-cookie": "session=attacker",
            "x-internal-secret": "hidden",
            "cache-control": "public, max-age=3600",
          },
        }),
    );
    const fixture = await authenticatedRouterRequest("GET", "/response");
    const response = await router.dispatch(
      fixture.request,
      fixture.runtime,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-internal-secret")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("returns stable 400/404 and does not run the lease or scope resolver for unmatched paths", async () => {
    const router = new AdminCompatRouter();
    router.get("/root", async () => ({ ok: true }));
    const withLeaseSpy = vi.fn();
    const withLease: AdminCompatRuntime["withUserDataLease"] =
      async <T>(
        resolvedUserId: string,
        work: (
          resources: AdminCompatResources,
          signal: AbortSignal,
        ) => Promise<T>,
      ) => {
        withLeaseSpy(resolvedUserId);
        return work(
          {} as AdminCompatResources,
          new AbortController().signal,
        );
      };
    const resolveDefaultScope = vi.fn(async () => ({
      userId,
      agentId: "agent-1",
    }));

    const missing = await authenticatedRouterRequest("GET", "/missing");
    const missingResponse = await router.dispatch(
      missing.request,
      routerRuntime(missing.runtime.security, {
        withUserDataLease: withLease,
        resolveDefaultScope,
      }),
    );
    expect(missingResponse.status).toBe(404);
    await expect(missingResponse.json()).resolves.toEqual({
      error: { code: "not_found", message: "route_not_found" },
    });
    expect(withLeaseSpy).not.toHaveBeenCalled();
    expect(resolveDefaultScope).not.toHaveBeenCalled();

    const malformed = await authenticatedRouterRequest(
      "GET",
      "/agents/%2F",
    );
    const malformedResponse = await router.dispatch(
      malformed.request,
      malformed.runtime,
    );
    expect(malformedResponse.status).toBe(400);
    await expect(malformedResponse.json()).resolves.toEqual({
      error: { code: "invalid_request", message: "invalid_path" },
    });
  });

  it("resolves an active default Agent only after auth and inside the shared lease", async () => {
    const router = new AdminCompatRouter();
    const handler = vi.fn(async () => ({ ok: true }));
    router.get("/root", handler);
    const events: string[] = [];
    const fixture = await authenticatedRouterRequest("GET", "/root");
    const response = await router.dispatch(
      fixture.request,
      routerRuntime(fixture.runtime.security, {
        withUserDataLease: async (_resolvedUserId, work) => {
          events.push("lease");
          return work(
            { marker: "leased" } as unknown as AdminCompatResources,
            new AbortController().signal,
          );
        },
        resolveDefaultScope: async (
          resolvedUserId,
          resources,
        ) => {
          events.push("scope");
          expect(resources).toMatchObject({ marker: "leased" });
          return {
            userId: resolvedUserId,
            agentId: "active-agent",
          };
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(events).toEqual(["lease", "scope"]);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { userId, agentId: "active-agent" },
        csrfVerified: false,
        resources: expect.objectContaining({ marker: "leased" }),
      }),
    );
  });

  it("returns a stable conflict when the default Agent is inactive", async () => {
    const router = new AdminCompatRouter();
    router.get("/root", async () => ({ ok: true }));
    const fixture = await authenticatedRouterRequest("GET", "/root");
    const response = await router.dispatch(
      fixture.request,
      routerRuntime(fixture.runtime.security, {
        resolveDefaultScope: async () => {
          throw new AdminCompatError(
            409,
            "agent_inactive",
            "active_agent_required",
          );
        },
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "agent_inactive",
        message: "active_agent_required",
      },
    });
  });
});

type MutableUserPreferences = {
  language: string;
  timezone: string;
  revision: number;
};

function coreDependencies(
  overrides: Partial<CoreAdminCompatDependencies> = {},
): CoreAdminCompatDependencies {
  return {
    createAuthStatusResponse: async () =>
      Response.json({
        enabled: true,
        authenticated: true,
        csrf_token: "csrf-from-shared-session",
        csrf_expires_at: 1_800_000_000,
      }),
    digitalMateVersion: "0.1.0",
    upstreamTag: "v2.0.0.post3",
    upstreamCommit:
      "fef7e64d984f4332d0b84a343cd209bd3ea5d316",
    compatApiRevision: "2026-07-24.1",
    ...overrides,
  };
}

function preferenceResources(
  initial: MutableUserPreferences = {
    language: "zh",
    timezone: "Asia/Shanghai",
    revision: 1,
  },
) {
  let current = { ...initial };
  const get = vi.fn(async () => ({ ...current }));
  const update = vi.fn(
    async (
      _resolvedUserId: string,
      input: MutableUserPreferences & { expectedRevision: number },
    ) => {
      if (input.expectedRevision !== current.revision) {
        throw Object.assign(new Error("revision_conflict"), {
          status: 409,
          code: "revision_conflict",
        });
      }
      current = {
        language: input.language,
        timezone: input.timezone,
        revision: current.revision + 1,
      };
      return { ...current };
    },
  );
  return {
    resources: {
      userPreferences: { get, update },
    } as unknown as AdminCompatResources,
    get,
    update,
    read: () => ({ ...current }),
  };
}

async function coreRequest(input: {
  router: AdminCompatRouter;
  method?: string;
  path: string;
  body?: unknown;
  resources?: AdminCompatResources;
  security?: Partial<AdminSecurityOptions>;
  authenticated?: boolean;
}) {
  const method = input.method ?? "GET";
  const security = options(input.security);
  const headers = new Headers({ accept: "application/json" });
  if (input.authenticated !== false) {
    const sessionToken = await createSessionToken(
      userId,
      1,
      appSecret,
      now,
    );
    headers.set(
      "cookie",
      `${sessionCookieName}=${sessionToken}`,
    );
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      headers.set("origin", "https://mate.example");
      headers.set(
        "x-csrf-token",
        createCsrfToken({
          userId,
          sessionToken,
          secret: deriveCsrfSecret(appSecret),
          now,
        }),
      );
    }
  }
  if (input.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  const request = new Request(
    `https://mate.example/api/admin/compat${input.path}`,
    {
      method,
      headers,
      body:
        input.body === undefined
          ? undefined
          : JSON.stringify(input.body),
    },
  );
  const resources =
    input.resources ?? preferenceResources().resources;
  return input.router.dispatch(
    request,
    routerRuntime(security, {
      withUserDataLease: async (_resolvedUserId, work) =>
        work(resources, request.signal),
    }),
  );
}

async function coreRawJsonRequest(input: {
  router: AdminCompatRouter;
  path: string;
  body: BodyInit;
  resources: AdminCompatResources;
  contentLength?: string;
}) {
  const sessionToken = await createSessionToken(
    userId,
    1,
    appSecret,
    now,
  );
  const headers = new Headers({
    accept: "application/json",
    cookie: `${sessionCookieName}=${sessionToken}`,
    origin: "https://mate.example",
    "content-type": "application/json",
    "x-csrf-token": createCsrfToken({
      userId,
      sessionToken,
      secret: deriveCsrfSecret(appSecret),
      now,
    }),
  });
  if (input.contentLength !== undefined) {
    headers.set("content-length", input.contentLength);
  }
  const request = new Request(
    `https://mate.example/api/admin/compat${input.path}`,
    {
      method: "PUT",
      headers,
      body: input.body,
      duplex: "half",
    } as RequestInit & { duplex: "half" },
  );
  return input.router.dispatch(
    request,
    routerRuntime(options(), {
      withUserDataLease: async (_resolvedUserId, work) =>
        work(input.resources, request.signal),
    }),
  );
}

async function expectPayloadTooLarge(
  response: Response,
): Promise<void> {
  expect(response.status).toBe(413);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe(
    "nosniff",
  );
  await expect(response.json()).resolves.toEqual({
    error: {
      code: "payload_too_large",
      message: "payload_too_large",
    },
  });
}

describe("admin compatibility core contracts", () => {
  it("keeps auth status public but makes verify use the shared DigitalMate session", async () => {
    const createAuthStatusResponse = vi.fn(async (request: Request) =>
      Response.json({
        enabled: true,
        authenticated: request.headers.has("cookie"),
        csrf_token: request.headers.has("cookie") ? "shared-csrf" : "",
        csrf_expires_at: request.headers.has("cookie")
          ? 1_800_000_000
          : null,
      }),
    );
    const router = createCoreAdminCompatRouter(
      coreDependencies({ createAuthStatusResponse }),
    );

    const status = await coreRequest({
      router,
      path: "/auth/status",
      authenticated: false,
    });
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      authenticated: false,
      csrf_token: "",
    });

    const unauthenticatedVerify = await coreRequest({
      router,
      path: "/auth/verify",
      authenticated: false,
    });
    expect(unauthenticatedVerify.status).toBe(401);

    const authenticatedVerify = await coreRequest({
      router,
      path: "/auth/verify",
    });
    expect(authenticatedVerify.status).toBe(200);
    await expect(authenticatedVerify.json()).resolves.toMatchObject({
      authenticated: true,
      csrf_token: "shared-csrf",
    });

    const plaintextPasswordAttempt = await coreRequest({
      router,
      method: "POST",
      path: "/auth/verify",
      body: { password: "must-not-be-processed" },
    });
    expect(plaintextPasswordAttempt.status).toBe(405);
    expect(JSON.stringify(await plaintextPasswordAttempt.json())).not
      .toContain("must-not-be-processed");
  });

  it("returns DigitalMate and pinned upstream identity from root and version aliases", async () => {
    const router = createCoreAdminCompatRouter(coreDependencies());
    for (const path of ["/root", "/version"]) {
      const response = await coreRequest({ router, path });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({
        name: "DigitalMate",
        version: "0.1.0",
        upstream: {
          tag: "v2.0.0.post3",
          commit:
            "fef7e64d984f4332d0b84a343cd209bd3ea5d316",
        },
        compat_api_revision: "2026-07-24.1",
      });
    }
  });

  it.each([
    "/language",
    "/settings/language",
  ])("reads and writes language through alias %s", async (path) => {
    const preferences = preferenceResources();
    const router = createCoreAdminCompatRouter(coreDependencies());

    const get = await coreRequest({
      router,
      path,
      resources: preferences.resources,
    });
    await expect(get.json()).resolves.toEqual({
      language: "zh",
      revision: 1,
    });

    const put = await coreRequest({
      router,
      method: "PUT",
      path,
      body: { language: "pt-BR", revision: 1 },
      resources: preferences.resources,
    });
    expect(put.status).toBe(200);
    await expect(put.json()).resolves.toEqual({
      language: "pt-BR",
      revision: 2,
    });
    expect(preferences.read()).toMatchObject({
      language: "pt-BR",
      timezone: "Asia/Shanghai",
    });
  });

  it.each([
    "en",
    "zh",
    "ja",
    "ru",
    "pt-BR",
    "id",
    "vi",
  ])("accepts the Console-supported language %s", async (language) => {
    const preferences = preferenceResources();
    const router = createCoreAdminCompatRouter(coreDependencies());
    const response = await coreRequest({
      router,
      method: "PUT",
      path: "/language",
      body: { language, revision: 1 },
      resources: preferences.resources,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      language,
      revision: 2,
    });
  });

  it.each([
    {
      body: { language: "xx", revision: 1 },
      label: "unsupported language",
    },
    {
      body: { language: "zh", revision: 1, secret: "hidden" },
      label: "extra key",
    },
    {
      body: { language: "zh", revision: 0 },
      label: "invalid revision",
    },
  ])("strictly rejects invalid language input: $label", async ({ body }) => {
    const preferences = preferenceResources();
    const router = createCoreAdminCompatRouter(coreDependencies());
    const response = await coreRequest({
      router,
      method: "PUT",
      path: "/language",
      body,
      resources: preferences.resources,
    });
    expect(response.status).toBe(400);
    const serialized = JSON.stringify(await response.json());
    expect(serialized).toContain('"code":"invalid_request"');
    expect(serialized).not.toContain("hidden");
    expect(preferences.update).not.toHaveBeenCalled();
  });

  it.each([
    "/user-timezone",
    "/config/user-timezone",
  ])("reads and writes an IANA timezone through alias %s", async (path) => {
    const preferences = preferenceResources();
    const router = createCoreAdminCompatRouter(coreDependencies());
    const get = await coreRequest({
      router,
      path,
      resources: preferences.resources,
    });
    await expect(get.json()).resolves.toEqual({
      timezone: "Asia/Shanghai",
      revision: 1,
    });

    const put = await coreRequest({
      router,
      method: "PUT",
      path,
      body: { timezone: "America/New_York", revision: 1 },
      resources: preferences.resources,
    });
    expect(put.status).toBe(200);
    await expect(put.json()).resolves.toEqual({
      timezone: "America/New_York",
      revision: 2,
    });
  });

  it.each([
    "",
    "Shanghai",
    "Mars/Olympus_Mons",
    "../Asia/Shanghai",
    "Asia/Shanghai\u0000",
  ])("rejects invalid IANA timezone %j", async (timezone) => {
    const preferences = preferenceResources();
    const router = createCoreAdminCompatRouter(coreDependencies());
    const response = await coreRequest({
      router,
      method: "PUT",
      path: "/user-timezone",
      body: { timezone, revision: 1 },
      resources: preferences.resources,
    });
    expect(response.status).toBe(400);
    expect(preferences.update).not.toHaveBeenCalled();
  });

  it.each([
    "GMT",
    "CET",
    "EET",
    "PRC",
    "W-SU",
    "Zulu",
  ])("accepts the ICU-supported IANA alias %s", async (timezone) => {
    const preferences = preferenceResources();
    const router = createCoreAdminCompatRouter(coreDependencies());
    const response = await coreRequest({
      router,
      method: "PUT",
      path: "/user-timezone",
      body: { timezone, revision: 1 },
      resources: preferences.resources,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      timezone: new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
      }).resolvedOptions().timeZone,
    });
  });

  it("uses one atomic user-settings revision so concurrent writes cannot silently overwrite", async () => {
    const preferences = preferenceResources();
    const router = createCoreAdminCompatRouter(coreDependencies());

    const [language, timezone] = await Promise.all([
      coreRequest({
        router,
        method: "PUT",
        path: "/language",
        body: { language: "en", revision: 1 },
        resources: preferences.resources,
      }),
      coreRequest({
        router,
        method: "PUT",
        path: "/user-timezone",
        body: { timezone: "Europe/Paris", revision: 1 },
        resources: preferences.resources,
      }),
    ]);
    expect([language.status, timezone.status].sort()).toEqual([
      200,
      409,
    ]);
    const conflict =
      language.status === 409 ? language : timezone;
    await expect(conflict.json()).resolves.toEqual({
      error: {
        code: "config_revision_conflict",
        message: "revision_conflict",
      },
    });
    expect(preferences.read().revision).toBe(2);
  });

  it("accepts the upstream no-revision body while still deriving an optimistic revision", async () => {
    const preferences = preferenceResources();
    const router = createCoreAdminCompatRouter(coreDependencies());
    const response = await coreRequest({
      router,
      method: "PUT",
      path: "/settings/language",
      body: { language: "en" },
      resources: preferences.resources,
    });
    expect(response.status).toBe(200);
    expect(preferences.update).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({ expectedRevision: 1 }),
    );
  });

  it("returns a stable 400 for malformed JSON instead of an internal error", async () => {
    const router = createCoreAdminCompatRouter(coreDependencies());
    const sessionToken = await createSessionToken(
      userId,
      1,
      appSecret,
      now,
    );
    const request = new Request(
      "https://mate.example/api/admin/compat/language",
      {
        method: "PUT",
        headers: {
          cookie: `${sessionCookieName}=${sessionToken}`,
          origin: "https://mate.example",
          "content-type": "application/json",
          "x-csrf-token": createCsrfToken({
            userId,
            sessionToken,
            secret: deriveCsrfSecret(appSecret),
            now,
          }),
        },
        body: '{"language":',
      },
    );
    const response = await router.dispatch(
      request,
      routerRuntime(options(), {
        withUserDataLease: async (_resolvedUserId, work) =>
          work(
            preferenceResources().resources,
            request.signal,
          ),
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "invalid_request", message: "invalid_json" },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe(
      "nosniff",
    );
  });

  it("rejects an oversized declared JSON body before parsing it", async () => {
    const preferences = preferenceResources();
    const router = createCoreAdminCompatRouter(coreDependencies());
    const response = await coreRawJsonRequest({
      router,
      path: "/language",
      body: JSON.stringify({ language: "zh" }),
      contentLength: String(16 * 1024 + 1),
      resources: preferences.resources,
    });

    await expectPayloadTooLarge(response);
    expect(preferences.get).not.toHaveBeenCalled();
    expect(preferences.update).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "missing Content-Length on language",
      path: "/language",
      contentLength: undefined,
    },
    {
      label: "forged small Content-Length on timezone",
      path: "/user-timezone",
      contentLength: "2",
    },
  ])("limits the actual streamed JSON bytes with $label", async ({
    path,
    contentLength,
  }) => {
    const preferences = preferenceResources();
    const router = createCoreAdminCompatRouter(coreDependencies());
    const encoded = new TextEncoder().encode(
      JSON.stringify({
        language: "zh",
        timezone: "Asia/Shanghai",
        padding: "x".repeat(16 * 1024),
      }),
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < encoded.length; offset += 1024) {
          controller.enqueue(encoded.slice(offset, offset + 1024));
        }
        controller.close();
      },
    });
    const response = await coreRawJsonRequest({
      router,
      path,
      body: stream,
      contentLength,
      resources: preferences.resources,
    });

    await expectPayloadTooLarge(response);
    expect(preferences.get).not.toHaveBeenCalled();
    expect(preferences.update).not.toHaveBeenCalled();
  });

  it("keeps preference HEAD responses bodyless under the shared JSON limit", async () => {
    const preferences = preferenceResources();
    const router = createCoreAdminCompatRouter(coreDependencies());
    const response = await coreRequest({
      router,
      method: "HEAD",
      path: "/language",
      resources: preferences.resources,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(
      "application/json",
    );
    expect(await response.text()).toBe("");
  });

  it.each([
    ["/capabilities/p2-sandbox", "p2_sandbox"],
    ["/capabilities/multi-agent", "multi_agent"],
  ])("returns stable 501 for frozen capability %s", async (
    path,
    capability,
  ) => {
    const router = createCoreAdminCompatRouter(coreDependencies());
    const response = await coreRequest({
      router,
      method: "POST",
      path,
    });
    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "capability_disabled",
        message: "capability_disabled",
        details: { capability },
      },
    });
  });

  it("keeps auth endpoints outside the user-data lease and leases every preference/root read", async () => {
    const router = createCoreAdminCompatRouter(coreDependencies());
    const fixture = await authenticatedFixture({
      requestUrl:
        "https://mate.example/api/admin/compat/auth/verify",
    });
    const withUserDataLeaseSpy = vi.fn();
    const withUserDataLease: AdminCompatRuntime["withUserDataLease"] =
      async <T>(
        resolvedUserId: string,
        work: (
          resources: AdminCompatResources,
          signal: AbortSignal,
        ) => Promise<T>,
      ) => {
        withUserDataLeaseSpy(resolvedUserId);
        return work(
          preferenceResources().resources,
          fixture.request("GET").signal,
        );
      };
    const runtime = routerRuntime(fixture.security, {
      withUserDataLease,
    });

    expect(
      (
        await router.dispatch(
          fixture.request("GET"),
          runtime,
        )
      ).status,
    ).toBe(200);
    expect(withUserDataLeaseSpy).not.toHaveBeenCalled();

    for (const path of ["/root", "/language", "/user-timezone"]) {
      const request = new Request(
        `https://mate.example/api/admin/compat${path}`,
        {
          headers: {
            cookie:
              fixture.request("GET").headers.get("cookie") ?? "",
          },
        },
      );
      expect((await router.dispatch(request, runtime)).status).toBe(
        200,
      );
    }
    expect(withUserDataLeaseSpy).toHaveBeenCalledTimes(3);
  });
});

describe("user-level Console preference persistence", () => {
  it("declares language, timezone and one optimistic revision on user settings", async () => {
    const schema = await readFile(
      `${process.cwd()}/src/server/db/schema.sql`,
      "utf8",
    );
    expect(schema).toMatch(
      /CREATE TABLE IF NOT EXISTS settings[\s\S]*language text NOT NULL DEFAULT 'zh'/,
    );
    expect(schema).toMatch(
      /CREATE TABLE IF NOT EXISTS settings[\s\S]*timezone text NOT NULL DEFAULT 'Asia\/Shanghai'/,
    );
    expect(schema).toMatch(
      /CREATE TABLE IF NOT EXISTS settings[\s\S]*revision integer NOT NULL DEFAULT 1/,
    );
    expect(schema).toMatch(
      /ALTER TABLE IF EXISTS settings ADD COLUMN IF NOT EXISTS language/,
    );
    expect(schema).toMatch(
      /ALTER TABLE IF EXISTS settings ADD COLUMN IF NOT EXISTS timezone/,
    );
    expect(schema).toMatch(
      /ALTER TABLE IF EXISTS settings ADD COLUMN IF NOT EXISTS revision/,
    );
    const repositories = await readFile(
      `${process.cwd()}/src/server/db/repositories.ts`,
      "utf8",
    );
    expect(repositories).toMatch(
      /INSERT INTO settings \([\s\S]*language, timezone[\s\S]*ON CONFLICT \(user_id\) DO UPDATE[\s\S]*language = EXCLUDED\.language,[\s\S]*timezone = EXCLUDED\.timezone,[\s\S]*revision = settings\.revision \+ 1/,
    );
  });

  it("reads preferences by user and atomically increments only the expected revision", async () => {
    const query = vi.fn(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes("INSERT INTO settings")) return { rows: [] };
      if (text.includes("SELECT language")) {
        return {
          rows: [
            {
              language: "zh",
              timezone: "Asia/Shanghai",
              revision: 4,
            },
          ],
        };
      }
      return {
        rows: [
          {
            language: "en",
            timezone: "Europe/Paris",
            revision: 5,
          },
        ],
      };
    });
    const repository = createUserPreferencesRepository({
      query,
    } as unknown as Pool);

    await expect(repository.get("user-1")).resolves.toEqual({
      language: "zh",
      timezone: "Asia/Shanghai",
      revision: 4,
    });
    await expect(
      repository.update("user-1", {
        language: "en",
        timezone: "Europe/Paris",
        expectedRevision: 4,
      }),
    ).resolves.toEqual({
      language: "en",
      timezone: "Europe/Paris",
      revision: 5,
    });

    const [sql, params] = query.mock.calls.at(-1) as unknown as [
      string,
      unknown[],
    ];
    expect(sql).toMatch(
      /WHERE user_id = \$1[\s\S]*AND revision = \$4[\s\S]*RETURNING language, timezone, revision/,
    );
    expect(params).toEqual([
      "user-1",
      "en",
      "Europe/Paris",
      4,
    ]);
  });

  it("turns an expected-revision miss into the stable router conflict", async () => {
    const query = vi.fn(async (sql: unknown) =>
      String(sql).includes("INSERT INTO settings")
        ? { rows: [] }
        : { rows: [] },
    );
    const repository = createUserPreferencesRepository({
      query,
    } as unknown as Pool);

    await expect(
      repository.update("user-1", {
        language: "en",
        timezone: "Europe/Paris",
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "revision_conflict",
    });
  });
});

describe("admin compatibility catch-all route", () => {
  it("exports every Console HTTP method through one node runtime handler", () => {
    expect(catchAllRuntime).toBe("nodejs");
    expect(CATCH_ALL_GET).toBe(CATCH_ALL_HEAD);
    expect(CATCH_ALL_GET).toBe(CATCH_ALL_OPTIONS);
    expect(CATCH_ALL_GET).toBe(CATCH_ALL_POST);
    expect(CATCH_ALL_GET).toBe(CATCH_ALL_PUT);
    expect(CATCH_ALL_GET).toBe(CATCH_ALL_PATCH);
    expect(CATCH_ALL_GET).toBe(CATCH_ALL_DELETE);
  });

  it.each([
    "GET",
    "HEAD",
    "OPTIONS",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
  ])("forwards %s and awaited catch-all params without changing the request", async (method) => {
    const dispatcher = vi.fn(async () =>
      Response.json({ forwarded: true }),
    );
    const handler = createAdminCompatRouteHandler(() => dispatcher);
    const request = new Request(
      "https://mate.example/api/admin/compat/agents/default",
      { method },
    );
    const response = await handler(request, {
      params: Promise.resolve({
        segments: ["agents", "default"],
      }),
    });

    expect(response.status).toBe(200);
    expect(dispatcher).toHaveBeenCalledWith(request, {
      routeSegments: ["agents", "default"],
    });
  });

  it.each([
    {
      label: "factory",
      createHandler: () =>
        createAdminCompatRouteHandler(() => {
          throw new Error("factory-secret-value");
        }),
      createParams: () => Promise.resolve({ segments: ["root"] }),
    },
    {
      label: "dispatcher",
      createHandler: () =>
        createAdminCompatRouteHandler(() => async () => {
          throw new Error("dispatcher-secret-value");
        }),
      createParams: () => Promise.resolve({ segments: ["root"] }),
    },
    {
      label: "params",
      createHandler: () =>
        createAdminCompatRouteHandler(() => async () =>
          Response.json({ shouldNotRun: true }),
        ),
      createParams: () =>
        Promise.reject(new Error("params-secret-value")),
    },
  ])("returns a fixed outer 500 when $label initialization fails", async ({
    createHandler,
    createParams,
  }) => {
    const response = await createHandler()(
      new Request("https://mate.example/api/admin/compat/root"),
      { params: createParams() },
    );
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
  });
});
