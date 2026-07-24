import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
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
