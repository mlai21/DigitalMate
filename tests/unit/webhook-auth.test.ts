import { describe, expect, it } from "vitest";
import { verifyDingTalkRobotCode, verifyFeishuVerificationToken, verifyTelegramWebhookSecret } from "@/server/channels/webhook-auth";

describe("verifyTelegramWebhookSecret", () => {
  it("allows Telegram webhooks when no secret is configured", () => {
    expect(verifyTelegramWebhookSecret(undefined, null)).toBe(true);
  });

  it("requires the Telegram secret token header when configured", () => {
    expect(verifyTelegramWebhookSecret("secret-token", "secret-token")).toBe(true);
    expect(verifyTelegramWebhookSecret("secret-token", "wrong-token")).toBe(false);
    expect(verifyTelegramWebhookSecret("secret-token", null)).toBe(false);
  });
});

describe("verifyFeishuVerificationToken", () => {
  it("allows Feishu webhooks when no verification token is configured", () => {
    expect(verifyFeishuVerificationToken(undefined, {})).toBe(true);
  });

  it("accepts Feishu verification tokens from v2 header and legacy root payloads", () => {
    expect(verifyFeishuVerificationToken("expected-token", { header: { token: "expected-token" } })).toBe(true);
    expect(verifyFeishuVerificationToken("expected-token", { token: "expected-token" })).toBe(true);
  });

  it("rejects Feishu webhooks with missing or mismatched verification tokens", () => {
    expect(verifyFeishuVerificationToken("expected-token", { header: { token: "wrong-token" } })).toBe(false);
    expect(verifyFeishuVerificationToken("expected-token", {})).toBe(false);
  });
});

describe("verifyDingTalkRobotCode", () => {
  it("allows DingTalk webhooks when no robot code is configured", () => {
    expect(verifyDingTalkRobotCode(undefined, {})).toBe(true);
  });

  it("requires the configured DingTalk robot code when present", () => {
    expect(verifyDingTalkRobotCode("ding-robot", { robotCode: "ding-robot" })).toBe(true);
    expect(verifyDingTalkRobotCode("ding-robot", { robotCode: "other-robot" })).toBe(false);
    expect(verifyDingTalkRobotCode("ding-robot", {})).toBe(false);
  });
});
