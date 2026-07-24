import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionToken,
  sessionCookieName,
} from "@/server/auth/session";
import {
  createCsrfToken,
  deriveCsrfSecret,
} from "@/server/http/csrf";

const mocks = vi.hoisted(() => ({
  cookieDelete: vi.fn(),
  ensureDefault: vi.fn(async () => ({
    id: "user-1",
    displayName: "Tang",
  })),
  getGeneration: vi.fn(async () => 8),
  rotate: vi.fn(async () => 9),
  readEnv: vi.fn(() => ({
    appPassword: "password",
    appSecret: "route-test-app-secret-value",
    trustProxyHeaders: false,
  })),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ delete: mocks.cookieDelete }),
}));

vi.mock("@/server/db/repositories", () => ({
  createRepositories: () => ({
    users: { ensureDefault: mocks.ensureDefault },
    sessionStates: {
      getGeneration: mocks.getGeneration,
      rotate: mocks.rotate,
    },
  }),
}));

vi.mock("@/server/config/env", () => ({
  readEnv: mocks.readEnv,
}));

import { POST } from "@/app/api/logout/route";

async function authenticatedLogoutRequest(
  csrfOverride?: string,
): Promise<Request> {
  const sessionToken = await createSessionToken(
    "user-1",
    8,
    "route-test-app-secret-value",
  );
  const csrfToken = createCsrfToken({
    userId: "user-1",
    sessionToken,
    secret: deriveCsrfSecret("route-test-app-secret-value"),
  });
  return new Request("https://mate.example/api/logout", {
    method: "POST",
    headers: {
      cookie: `${sessionCookieName}=${sessionToken}`,
      origin: "https://mate.example",
      "x-csrf-token": csrfOverride ?? csrfToken,
    },
  });
}

describe("logout route", () => {
  beforeEach(() => {
    mocks.cookieDelete.mockClear();
    mocks.ensureDefault.mockClear();
    mocks.getGeneration.mockClear();
    mocks.getGeneration.mockResolvedValue(8);
    mocks.rotate.mockClear();
    mocks.rotate.mockResolvedValue(9);
  });

  it("revokes the server-side session before deleting its cookie", async () => {
    let generation = 8;
    mocks.getGeneration.mockImplementation(async () => generation);
    mocks.rotate.mockImplementation(async () => {
      generation += 1;
      return generation;
    });
    const request = await authenticatedLogoutRequest();
    const response = await POST(request);

    expect(response.status).toBe(204);
    expect(mocks.rotate).toHaveBeenCalledWith("user-1");
    expect(mocks.rotate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.cookieDelete.mock.invocationCallOrder[0],
    );
    expect(mocks.cookieDelete).toHaveBeenCalledWith(sessionCookieName);

    const replay = await POST(request);
    expect(replay.status).toBe(401);
    expect(mocks.rotate).toHaveBeenCalledOnce();
    expect(mocks.cookieDelete).toHaveBeenCalledOnce();
  });

  it("rejects a stale CSRF pair without revoking or deleting anything", async () => {
    const response = await POST(
      await authenticatedLogoutRequest("invalid-token"),
    );

    expect(response.status).toBe(403);
    expect(mocks.rotate).not.toHaveBeenCalled();
    expect(mocks.cookieDelete).not.toHaveBeenCalled();
  });

  it("fails closed and preserves the cookie when revocation cannot persist", async () => {
    mocks.rotate.mockRejectedValueOnce(new Error("database unavailable"));

    const response = await POST(await authenticatedLogoutRequest());

    expect(response.status).toBe(500);
    expect(mocks.cookieDelete).not.toHaveBeenCalled();
  });
});
