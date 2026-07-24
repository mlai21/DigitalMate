import { describe, expect, it } from "vitest";
import {
  createSessionToken,
  getSessionTokenFromRequest,
  shouldUseSecureSessionCookie,
  verifySessionRequest,
  verifySessionToken,
} from "@/server/auth/session";

describe("session token", () => {
  it("verifies signed tokens and rejects tampering", async () => {
    const token = await createSessionToken("user-1", "secret");

    expect(await verifySessionToken(token, "secret")).toBe("user-1");
    expect(await verifySessionToken(`${token}x`, "secret")).toBeNull();
  });

  it("rotates the signed session even when two logins happen in the same millisecond", async () => {
    const now = new Date("2026-07-24T00:00:00.000Z");
    const first = await createSessionToken("user-1", "secret", now);
    const second = await createSessionToken("user-1", "secret", now);

    expect(first).not.toBe(second);
    expect(await verifySessionToken(first, "secret")).toBe("user-1");
    expect(await verifySessionToken(second, "secret")).toBe("user-1");
  });

  it("only marks session cookies secure for https requests", () => {
    expect(shouldUseSecureSessionCookie(new Request("http://47.88.93.94/login"))).toBe(false);
    expect(shouldUseSecureSessionCookie(new Request("https://digitalmate.example/login"))).toBe(true);
  });

  it("only honors one forwarded protocol when proxy trust is explicit", () => {
    expect(
      shouldUseSecureSessionCookie(
        new Request("http://digitalmate.internal/login", {
          headers: { "x-forwarded-proto": "https" },
        }),
      ),
    ).toBe(false);
    expect(
      shouldUseSecureSessionCookie(
        new Request("http://digitalmate.internal/login", {
          headers: {
            "x-forwarded-proto": "https",
            "x-forwarded-host": "mate.example",
          },
        }),
        { trustProxyHeaders: true },
      ),
    ).toBe(true);
    expect(
      shouldUseSecureSessionCookie(
        new Request("https://digitalmate.internal/login", {
          headers: {
            "x-forwarded-proto": "https,http",
            "x-forwarded-host": "mate.example",
          },
        }),
        { trustProxyHeaders: true },
      ),
    ).toBe(false);
  });

  it("verifies only the signed dm_session cookie from a Request", async () => {
    const token = await createSessionToken("user-1", "secret");
    const request = new Request("https://digitalmate.example/admin-preview?dm_session=ignored", {
      headers: {
        authorization: `Bearer ${token}`,
        cookie: `theme=coral; dm_session=${token}; locale=zh-CN`,
        "x-dm-session": token,
      },
    });

    expect(await verifySessionRequest(request, "user-1", "secret")).toBe("user-1");
    expect(getSessionTokenFromRequest(request)).toBe(token);
    expect(
      await verifySessionRequest(
        new Request(`https://digitalmate.example/admin-preview?dm_session=${token}`, {
          headers: { authorization: `Bearer ${token}`, "x-dm-session": token },
        }),
        "user-1",
        "secret",
      ),
    ).toBeNull();
  });

  it("rejects a valid signed session belonging to a different user", async () => {
    const token = await createSessionToken("not-the-default-user", "secret");
    const request = new Request("https://digitalmate.example/admin-preview", {
      headers: { cookie: `dm_session=${token}` },
    });

    expect(await verifySessionRequest(request, "user-1", "secret")).toBeNull();
  });

  it("rejects missing, empty, duplicate, tampered and malformed session cookies", async () => {
    const token = await createSessionToken("user-1", "secret");
    const cases = [
      undefined,
      "",
      "dm_session=",
      `dm_session=${token}; dm_session=${token}`,
      `dm_session=${token}x`,
      `dm_session=${token}.extra`,
      `dm_session="${token}"`,
      "dm_session=not-a-token",
      "dm_session=%E0%A4%A",
    ];

    for (const cookie of cases) {
      const headers = cookie === undefined ? undefined : { cookie };
      const request = new Request("https://digitalmate.example/admin-preview", {
        headers,
      });
      expect(
        await verifySessionRequest(
          request,
          "user-1",
          "secret",
        ),
      ).toBeNull();
      if (cookie === `dm_session=${token}x`) {
        expect(getSessionTokenFromRequest(request)).toBe(`${token}x`);
      } else {
        expect(getSessionTokenFromRequest(request)).toBeNull();
      }
    }
  });
});
