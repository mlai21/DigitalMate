import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookieSet: vi.fn(),
  ensureDefault: vi.fn(async () => ({
    id: "user-1",
    displayName: "Tang",
  })),
  rotate: vi.fn(async () => 8),
  readEnv: vi.fn(() => ({
    appPassword: "password",
    appSecret: "route-test-app-secret-value",
    trustProxyHeaders: false,
  })),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ set: mocks.cookieSet }),
}));

vi.mock("@/server/db/repositories", () => ({
  createRepositories: () => ({
    users: { ensureDefault: mocks.ensureDefault },
    sessionStates: { rotate: mocks.rotate },
  }),
}));

vi.mock("@/server/config/env", () => ({
  readEnv: mocks.readEnv,
}));

import { POST } from "@/app/api/login/route";

function loginRequest(
  password: string,
  redirect = "/admin-preview/settings?tab=models",
): Request {
  const body = new URLSearchParams({ password, redirect });
  return new Request("https://mate.example/api/login", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
}

describe("login route", () => {
  beforeEach(() => {
    mocks.cookieSet.mockClear();
    mocks.ensureDefault.mockClear();
    mocks.rotate.mockClear();
    mocks.rotate.mockResolvedValue(8);
  });

  it("rotates persistent state before issuing a cookie and returns the safe Console path", async () => {
    const response = await POST(loginRequest("password"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "/admin-preview/settings?tab=models",
    );
    expect(mocks.rotate).toHaveBeenCalledWith("user-1");
    expect(mocks.rotate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.cookieSet.mock.invocationCallOrder[0],
    );
    expect(mocks.cookieSet).toHaveBeenCalledWith(
      "dm_session",
      expect.any(String),
      expect.objectContaining({ httpOnly: true, maxAge: 2_592_000 }),
    );
  });

  it("preserves only a sanitized redirect when the password is wrong", async () => {
    const response = await POST(
      loginRequest("wrong", "//evil.example"),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "/login?error=1&redirect=%2F",
    );
    expect(mocks.rotate).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("fails closed when session rotation cannot be persisted", async () => {
    mocks.rotate.mockRejectedValueOnce(new Error("database unavailable"));

    const response = await POST(loginRequest("password"));

    expect(response.status).toBe(500);
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });
});
