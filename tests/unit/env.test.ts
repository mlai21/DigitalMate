import { describe, expect, it } from "vitest";
import { readEnv } from "@/server/config/env";

describe("readEnv", () => {
  it("uses safe defaults for local development", () => {
    const env = readEnv({});

    expect(env.databaseUrl).toContain("postgres");
    expect(env.llmModelMain).toBe("claude-opus-4-8");
    expect(env.llmModelLight).toBe("gemini-3-5-flash-openai");
    expect(env.proactiveMaxPerDay).toBe(3);
    expect(env.aliyunIqsBaseUrl).toBe("https://cloud-iqs.aliyuncs.com");
    expect(env.trustProxyHeaders).toBe(false);
    expect(env.appSecret).toBe("digitalmate-local-secret-change-me");
    expect(env.channelSecretsKey).toEqual({
      status: "blocked",
      code: "channel_secrets_key_missing",
    });
    expect(env.backupEncryptionKey).toEqual({
      status: "blocked",
      code: "backup_encryption_key_missing",
    });
    expect(env.channelImportLegacyEnabled).toBe(false);
    expect(env.channelGatewayPort).toBe(3_101);
    expect(env.channelNodePort).toBe(9_443);
    expect(env.channelNodeTls).toEqual({ status: "disabled" });
    expect(env.channelNodeEnrollmentCa).toEqual({
      status: "disabled",
    });
    expect(env.publicBaseUrl).toBeNull();
  });

  it("keeps channel secret encryption blocked without falling back to APP_SECRET", () => {
    const env = readEnv({
      NODE_ENV: "production",
      APP_SECRET: "production-signing-secret-that-is-at-least-32-bytes",
      PUBLIC_BASE_URL: "https://mate.example",
    });

    expect(env.channelSecretsKey).toEqual({
      status: "blocked",
      code: "channel_secrets_key_missing",
    });
  });

  it("keeps an invalid production channel key blocked without stopping the core app", () => {
    const env = readEnv({
      NODE_ENV: "production",
      APP_SECRET: "production-signing-secret-that-is-at-least-32-bytes",
      CHANNEL_SECRETS_KEY: Buffer.alloc(31).toString("base64"),
      PUBLIC_BASE_URL: "https://mate.example",
    });

    expect(env.channelSecretsKey).toEqual({
      status: "blocked",
      code: "channel_secrets_key_invalid",
    });
  });

  it("exposes an opaque ready state for a valid channel encryption key", () => {
    const encoded = Buffer.alloc(32, 9).toString("base64");
    const env = readEnv({ CHANNEL_SECRETS_KEY: encoded });

    expect(env.channelSecretsKey.status).toBe("ready");
    expect(JSON.stringify(env)).not.toContain(encoded);
  });

  it("requires an independent 32-byte backup encryption key", () => {
    const appSecret = "a".repeat(32);
    const channelKey = Buffer.alloc(32, 4).toString("base64");
    const backupKey = Buffer.alloc(32, 5).toString("base64");

    expect(
      readEnv({
        APP_SECRET: appSecret,
        CHANNEL_SECRETS_KEY: channelKey,
        BACKUP_ENCRYPTION_KEY: backupKey,
      }).backupEncryptionKey.status,
    ).toBe("ready");
    expect(
      readEnv({
        BACKUP_ENCRYPTION_KEY: Buffer.alloc(31).toString(
          "base64",
        ),
      }).backupEncryptionKey,
    ).toEqual({
      status: "blocked",
      code: "backup_encryption_key_invalid",
    });
    expect(
      readEnv({
        APP_SECRET: appSecret,
        BACKUP_ENCRYPTION_KEY:
          Buffer.from(appSecret).toString("base64"),
      }).backupEncryptionKey,
    ).toEqual({
      status: "blocked",
      code: "backup_encryption_key_reused",
    });
    expect(
      readEnv({
        CHANNEL_SECRETS_KEY: channelKey,
        BACKUP_ENCRYPTION_KEY: channelKey,
      }).backupEncryptionKey,
    ).toEqual({
      status: "blocked",
      code: "backup_encryption_key_reused",
    });
    expect(
      readEnv({
        APP_SECRET: backupKey,
        BACKUP_ENCRYPTION_KEY: backupKey,
      }).backupEncryptionKey,
    ).toEqual({
      status: "blocked",
      code: "backup_encryption_key_reused",
    });
  });

  it("requires an explicit boolean to trust sanitized proxy headers", () => {
    expect(readEnv({ TRUST_PROXY_HEADERS: "true" }).trustProxyHeaders).toBe(
      true,
    );
    expect(() => readEnv({ TRUST_PROXY_HEADERS: "yes" })).toThrow();
  });

  it("rejects an APP_SECRET too short for session and CSRF signing", () => {
    expect(() => readEnv({ APP_SECRET: "short" })).toThrow();
    expect(
      readEnv({ APP_SECRET: "at-least-sixteen-characters" }).appSecret,
    ).toBe("at-least-sixteen-characters");
  });

  it("fails fast when production APP_SECRET is missing even with APP_PASSWORD", () => {
    expect(() =>
      readEnv({
        NODE_ENV: "production",
        APP_PASSWORD: "password-cannot-replace-signing-secret",
      }),
    ).toThrow(/APP_SECRET.*32.*高熵/);
  });

  it.each([
    "digitalmate-local-secret",
    "digitalmate-local-secret-change-me",
    "change-me-use-at-least-32-random-bytes",
  ])("rejects the public APP_SECRET placeholder in production: %s", (secret) => {
    expect(() =>
      readEnv({ NODE_ENV: "production", APP_SECRET: secret }),
    ).toThrow(/APP_SECRET.*高熵/);
  });

  it("requires at least 32 bytes for a production APP_SECRET", () => {
    expect(() =>
      readEnv({
        NODE_ENV: "production",
        APP_SECRET: "only-31-bytes-long-1234567890",
      }),
    ).toThrow(/APP_SECRET.*32/);

    expect(
      readEnv({
        NODE_ENV: "production",
        APP_SECRET: "1f9eb9813df44927b516cb19171b554fffd1da2a",
        PUBLIC_BASE_URL: "https://mate.example",
      }).appSecret,
    ).toBe("1f9eb9813df44927b516cb19171b554fffd1da2a");
  });

  it("reads optional channel credentials", () => {
    const env = readEnv({
      TELEGRAM_BOT_TOKEN: "telegram",
      TELEGRAM_WEBHOOK_SECRET: "telegram-secret",
      SLACK_BOT_TOKEN: "slack",
      SLACK_SIGNING_SECRET: "signing-secret",
      FEISHU_APP_ID: "feishu-app",
      FEISHU_APP_SECRET: "feishu-secret",
      FEISHU_VERIFICATION_TOKEN: "feishu-token",
      DINGTALK_ROBOT_CODE: "ding-robot",
    });

    expect(env.telegramBotToken).toBe("telegram");
    expect(env.telegramWebhookSecret).toBe("telegram-secret");
    expect(env.slackBotToken).toBe("slack");
    expect(env.slackSigningSecret).toBe("signing-secret");
    expect(env.feishuAppId).toBe("feishu-app");
    expect(env.feishuAppSecret).toBe("feishu-secret");
    expect(env.feishuVerificationToken).toBe("feishu-token");
    expect(env.dingTalkRobotCode).toBe("ding-robot");
  });

  it("只有显式设置 1 才启用遗留渠道连接", () => {
    expect(readEnv({
      CHANNEL_IMPORT_LEGACY_ENABLED: "1",
    }).channelImportLegacyEnabled).toBe(true);
    expect(() => readEnv({
      CHANNEL_IMPORT_LEGACY_ENABLED: "true",
    })).toThrow();
  });

  it("requires complete mTLS paths and normalizes the public root URL", () => {
    expect(() =>
      readEnv({
        CHANNEL_NODE_TLS_CERT_PATH: "./server.crt",
      }),
    ).toThrow(/mTLS.*同时配置/);

    const env = readEnv({
      CHANNEL_GATEWAY_PORT: "0",
      CHANNEL_NODE_PORT: "10443",
      CHANNEL_NODE_TLS_CERT_PATH: "./server.crt",
      CHANNEL_NODE_TLS_KEY_PATH: "./server.key",
      CHANNEL_NODE_CA_PATH: "./node-ca.crt",
      PUBLIC_BASE_URL: "https://mate.example/",
    });

    expect(env.channelGatewayPort).toBe(0);
    expect(env.channelNodePort).toBe(10_443);
    expect(env.channelNodeTls).toMatchObject({
      status: "ready",
      certificatePath: expect.stringMatching(/server\.crt$/),
      privateKeyPath: expect.stringMatching(/server\.key$/),
      certificateAuthorityPath: expect.stringMatching(/node-ca\.crt$/),
    });
    expect(env.publicBaseUrl).toBe("https://mate.example");
    expect(() =>
      readEnv({
        PUBLIC_BASE_URL: "https://user:secret@mate.example/",
      }),
    ).toThrow(/PUBLIC_BASE_URL/);
    expect(() =>
      readEnv({
        PUBLIC_BASE_URL: "https://mate.example/private",
      }),
    ).toThrow(/PUBLIC_BASE_URL/);
  });

  it("separates the Web enrollment CA from Agent gateway TLS material", () => {
    expect(() =>
      readEnv({
        CHANNEL_NODE_ENROLLMENT_CA_PATH: "./client-ca.crt",
      }),
    ).toThrow(/enrollment CA.*同时配置/);
    expect(() =>
      readEnv({
        CHANNEL_NODE_ENROLLMENT_CA_PATH: "./client-ca.crt",
        CHANNEL_NODE_ENROLLMENT_CA_KEY_PATH: "./client-ca.key",
      }),
    ).toThrow(/独立的网关服务端 CA/);
    expect(() =>
      readEnv({
        CHANNEL_NODE_ENROLLMENT_CA_PATH: "./shared-ca.crt",
        CHANNEL_NODE_ENROLLMENT_CA_KEY_PATH: "./client-ca.key",
        CHANNEL_NODE_SERVER_CA_PATH: "./shared-ca.crt",
      }),
    ).toThrow(/不能与.*enrollment CA 复用/);

    const env = readEnv({
      CHANNEL_NODE_ENROLLMENT_CA_PATH: "./client-ca.crt",
      CHANNEL_NODE_ENROLLMENT_CA_KEY_PATH: "./client-ca.key",
      CHANNEL_NODE_SERVER_CA_PATH: "./server-ca.crt",
    });

    expect(env.channelNodeTls).toEqual({ status: "disabled" });
    expect(env.channelNodeEnrollmentCa).toMatchObject({
      status: "ready",
      certificateAuthorityPath:
        expect.stringMatching(/client-ca\.crt$/),
      certificateAuthorityPrivateKeyPath:
        expect.stringMatching(/client-ca\.key$/),
    });
    expect(env.channelNodeServerCaPath).toMatch(
      /server-ca\.crt$/,
    );
    expect(env.channelNodeEnrollmentCa).not.toMatchObject({
      certificateAuthorityPath:
        env.channelNodeServerCaPath,
    });
  });

  it("requires HTTPS and nonzero listener ports in production", () => {
    const production = {
      NODE_ENV: "production",
      APP_SECRET:
        "production-signing-secret-that-is-at-least-32-bytes",
    } as const;

    expect(() => readEnv({
      ...production,
      PUBLIC_BASE_URL: "http://mate.example",
    })).toThrow(/PUBLIC_BASE_URL.*HTTPS/);
    expect(() => readEnv(production)).toThrow(
      /PUBLIC_BASE_URL/,
    );
    expect(() => readEnv({
      ...production,
      CHANNEL_GATEWAY_PORT: "0",
    })).toThrow(/CHANNEL_GATEWAY_PORT/);
    expect(() => readEnv({
      ...production,
      CHANNEL_NODE_PORT: "0",
    })).toThrow(/CHANNEL_NODE_PORT/);
  });

  it("reads aliyun iqs search credentials", () => {
    const env = readEnv({
      SEARCH_PROVIDER: "iqs",
      ALIYUN_IQS_API_KEY: "iqs-key",
      ALIYUN_IQS_BASE_URL: "https://cloud-iqs.aliyuncs.com",
    });

    expect(env.searchProvider).toBe("iqs");
    expect(env.aliyunIqsApiKey).toBe("iqs-key");
    expect(env.aliyunIqsBaseUrl).toBe("https://cloud-iqs.aliyuncs.com");
  });
});
