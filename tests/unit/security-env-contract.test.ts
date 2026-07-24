import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readEnv } from "@/server/config/env";

describe("security environment contract", () => {
  it("keeps the APP_SECRET development placeholder consistent in all three entry points", async () => {
    const [example, compose] = await Promise.all([
      readFile(path.join(process.cwd(), ".env.example"), "utf8"),
      readFile(path.join(process.cwd(), "docker-compose.yml"), "utf8"),
    ]);
    const placeholder = "digitalmate-local-secret-change-me";

    expect(readEnv({}).appSecret).toBe(placeholder);
    expect(example).toContain(`APP_SECRET=${placeholder}`);
    expect(
      compose.match(
        new RegExp(`APP_SECRET: \\\\?\\$\\{APP_SECRET:-${placeholder}\\}`, "g"),
      ),
    ).toHaveLength(2);
  });

  it("defaults proxy trust off while the controlled Caddy service fixes it on", async () => {
    const [example, compose] = await Promise.all([
      readFile(path.join(process.cwd(), ".env.example"), "utf8"),
      readFile(path.join(process.cwd(), "docker-compose.yml"), "utf8"),
    ]);

    expect(readEnv({}).trustProxyHeaders).toBe(false);
    expect(example).toMatch(/^TRUST_PROXY_HEADERS=false$/m);
    expect(compose.match(/^\s+TRUST_PROXY_HEADERS:/gm)).toHaveLength(1);
    expect(compose).toContain('TRUST_PROXY_HEADERS: "true"');
  });
});
