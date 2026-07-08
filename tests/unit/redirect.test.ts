import { describe, expect, it } from "vitest";
import { redirectUrl } from "@/server/http/redirect";

describe("redirectUrl", () => {
  it("uses forwarded public host instead of the internal request url", () => {
    const request = new Request("http://localhost:3000/api/login", {
      headers: {
        host: "localhost:3000",
        "x-forwarded-host": "47.88.93.94",
        "x-forwarded-proto": "http",
      },
    });

    expect(redirectUrl(request, "/").toString()).toBe("http://47.88.93.94/");
  });

  it("falls back to the Host header before the internal request origin", () => {
    const request = new Request("http://localhost:3000/api/login", {
      headers: { host: "47.88.93.94" },
    });

    expect(redirectUrl(request, "/login?error=1").toString()).toBe("http://47.88.93.94/login?error=1");
  });
});
