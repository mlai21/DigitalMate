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

  it("requires an independent channel encryption key in both Compose services", async () => {
    const [example, compose] = await Promise.all([
      readFile(path.join(process.cwd(), ".env.example"), "utf8"),
      readFile(path.join(process.cwd(), "docker-compose.yml"), "utf8"),
    ]);

    expect(example).toMatch(/^CHANNEL_SECRETS_KEY=/m);
    expect(compose).not.toContain("${CHANNEL_SECRETS_KEY:-");
    expect(compose).not.toMatch(
      /CHANNEL_SECRETS_KEY:.*APP_SECRET/,
    );
    expect(
      compose.match(
        /CHANNEL_SECRETS_KEY:\s*"\$\{CHANNEL_SECRETS_KEY:\?请设置独立的32字节base64渠道加密密钥\}"/g,
      ),
    ).toHaveLength(2);
  });

  it("keeps the independent backup key and private archive volume in the web service only", async () => {
    const [example, compose] = await Promise.all([
      readFile(path.join(process.cwd(), ".env.example"), "utf8"),
      readFile(path.join(process.cwd(), "docker-compose.yml"), "utf8"),
    ]);

    expect(example).toMatch(/^BACKUP_ENCRYPTION_KEY=/m);
    expect(compose).not.toMatch(
      /BACKUP_ENCRYPTION_KEY:.*(?:APP_SECRET|CHANNEL_SECRETS_KEY)/,
    );
    expect(
      compose.match(
        /BACKUP_ENCRYPTION_KEY:\s*"\$\{BACKUP_ENCRYPTION_KEY:-\}"/g,
      ),
    ).toHaveLength(1);
    expect(
      compose.match(
        /digitalmate-backups:\/app\/data\/backups/g,
      ),
    ).toHaveLength(1);
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
