import { describe, expect, it } from "vitest";
import { sanitizeInternalRedirect } from "@/server/http/internal-redirect";

describe("safe internal login redirect", () => {
  it.each([
    ["https://evil.example", "/"],
    ["//evil.example/path", "/"],
    ["/%2f%2fevil.example", "/"],
    ["/%252f%252fevil.example", "/"],
    ["/%2525252525252f%2525252525252fevil.example", "/"],
    ["/\\evil.example", "/"],
    ["/%5cevil.example", "/"],
    ["/admin-preview/%2e%2e/login", "/"],
    ["/admin-preview\u0000/settings", "/"],
  ])("rejects open-redirect input %s", (input, expected) => {
    expect(sanitizeInternalRedirect(input)).toBe(expected);
  });

  it("preserves a valid Console path and query", () => {
    expect(
      sanitizeInternalRedirect(
        "/admin-preview/settings?tab=model%20routing",
      ),
    ).toBe("/admin-preview/settings?tab=model%20routing");
  });
});
