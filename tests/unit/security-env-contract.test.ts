import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readEnv } from "@/server/config/env";

describe("security environment contract", () => {
  it("keeps a development placeholder but rejects it in production", async () => {
    const [example, compose] = await Promise.all([
      readFile(path.join(process.cwd(), ".env.example"), "utf8"),
      readFile(path.join(process.cwd(), "docker-compose.yml"), "utf8"),
    ]);
    const placeholder = example.match(/^APP_SECRET=(.+)$/m)?.[1];

    expect(placeholder).toBeTruthy();
    expect(readEnv({}).appSecret).toBe(
      "digitalmate-local-secret-change-me",
    );
    expect(() =>
      readEnv({
        NODE_ENV: "production",
        APP_SECRET: placeholder,
      }),
    ).toThrow(/APP_SECRET.*高熵/);
    expect(compose).not.toContain("${APP_SECRET:-");
    expect(
      compose.match(
        /APP_SECRET:\s*"\$\{APP_SECRET:\?请设置至少32字节的高熵APP_SECRET\}"/g,
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
