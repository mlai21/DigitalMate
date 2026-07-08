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
