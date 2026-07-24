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
  });

  it("keeps channel secret encryption blocked without falling back to APP_SECRET", () => {
    const env = readEnv({
      NODE_ENV: "production",
      APP_SECRET: "production-signing-secret-that-is-at-least-32-bytes",
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
