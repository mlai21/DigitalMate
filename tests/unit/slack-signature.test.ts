import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySlackRequest } from "@/server/channels/slack-signature";

describe("verifySlackRequest", () => {
  it("accepts requests signed with the Slack signing secret", () => {
    const body = JSON.stringify({ type: "event_callback" });
    const timestamp = "1783185600";
    const signature = slackSignature("test-secret", timestamp, body);

    expect(
      verifySlackRequest({
        signingSecret: "test-secret",
        timestamp,
        signature,
        body,
        now: new Date(1783185600 * 1000),
      }),
    ).toBe(true);
  });

  it("rejects invalid or stale signatures", () => {
    const body = JSON.stringify({ type: "event_callback" });
    const timestamp = "1783185600";

    expect(
      verifySlackRequest({
        signingSecret: "test-secret",
        timestamp,
        signature: "v0=bad",
        body,
        now: new Date(1783185600 * 1000),
      }),
    ).toBe(false);

    expect(
      verifySlackRequest({
        signingSecret: "test-secret",
        timestamp,
        signature: slackSignature("test-secret", timestamp, body),
        body,
        now: new Date(1783186201 * 1000),
      }),
    ).toBe(false);
  });
});

function slackSignature(secret: string, timestamp: string, body: string) {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}
