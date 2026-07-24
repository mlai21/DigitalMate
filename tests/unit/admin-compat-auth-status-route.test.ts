import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionToken, sessionCookieName } from "@/server/auth/session";

const mocks = vi.hoisted(() => ({
  ensureDefault: vi.fn(async () => ({
    id: "user-1",
    displayName: "Tang",
  })),
  getGeneration: vi.fn(async () => 1),
  readEnv: vi.fn(() => ({
    appPassword: "password",
    appSecret: "route-test-app-secret-value",
    trustProxyHeaders: false,
  })),
}));

vi.mock("@/server/db/repositories", () => ({
  createRepositories: () => ({
    users: { ensureDefault: mocks.ensureDefault },
    sessionStates: { getGeneration: mocks.getGeneration },
  }),
}));

vi.mock("@/server/config/env", () => ({
  readEnv: mocks.readEnv,
}));

import {
  GET,
  runtime,
} from "@/app/api/admin/compat/auth/status/route";

describe("Console auth status route", () => {
  beforeEach(() => {
    mocks.ensureDefault.mockClear();
    mocks.readEnv.mockClear();
  });

  it("returns the shared authenticated session and an in-memory CSRF token", async () => {
    const sessionToken = await createSessionToken(
      "user-1",
      1,
      "route-test-app-secret-value",
    );
    const response = await GET(
      new Request(
        "https://mate.example/api/admin/compat/auth/status",
        {
          headers: {
            cookie: `${sessionCookieName}=${sessionToken}`,
          },
        },
      ),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(runtime).toBe("nodejs");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({
      enabled: true,
      authenticated: true,
      csrf_expires_at: expect.any(Number),
    });
    expect(body.csrf_token).toEqual(expect.any(String));
    expect(String(body.csrf_token)).not.toContain(
      "route-test-app-secret-value",
    );
    expect(mocks.ensureDefault).toHaveBeenCalledOnce();
  });
});
