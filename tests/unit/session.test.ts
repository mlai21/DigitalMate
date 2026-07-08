import { describe, expect, it } from "vitest";
import { createSessionToken, shouldUseSecureSessionCookie, verifySessionToken } from "@/server/auth/session";

describe("session token", () => {
  it("verifies signed tokens and rejects tampering", async () => {
    const token = await createSessionToken("user-1", "secret");

    expect(await verifySessionToken(token, "secret")).toBe("user-1");
    expect(await verifySessionToken(`${token}x`, "secret")).toBeNull();
  });

  it("only marks session cookies secure for https requests", () => {
    expect(shouldUseSecureSessionCookie(new Request("http://47.88.93.94/login"))).toBe(false);
    expect(shouldUseSecureSessionCookie(new Request("https://digitalmate.example/login"))).toBe(true);
  });

  it("honors x-forwarded-proto when running behind a proxy", () => {
    expect(
      shouldUseSecureSessionCookie(
        new Request("http://digitalmate.internal/login", {
          headers: { "x-forwarded-proto": "https" },
        }),
      ),
    ).toBe(true);
    expect(
      shouldUseSecureSessionCookie(
        new Request("https://digitalmate.internal/login", {
          headers: { "x-forwarded-proto": "http" },
        }),
      ),
    ).toBe(false);
  });
});
