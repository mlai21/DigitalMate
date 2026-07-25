import { NextResponse } from "next/server";
import {
  acceptWebhookEvent,
  loadWebhookAuthConfig,
} from "@/server/channels/adapters/webhook/route-runtime";
import { verifySlackRequest } from "@/server/channels/slack-signature";
import { readEnv } from "@/server/config/env";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const env = readEnv();
  const body = await request.text();
  const config = await loadWebhookAuthConfig("slack");
  const signingSecret =
    readConfiguredString(config?.signing_secret)
    ?? env.slackSigningSecret;
  if (
    signingSecret &&
    !verifySlackRequest({
      signingSecret,
      timestamp: request.headers.get("x-slack-request-timestamp"),
      signature: request.headers.get("x-slack-signature"),
      body,
    })
  ) {
    return NextResponse.json({ error: "invalid Slack signature" }, { status: 401 });
  }

  const payload = JSON.parse(body);
  if (payload?.type === "url_verification" && typeof payload.challenge === "string") {
    return NextResponse.json({ challenge: payload.challenge });
  }

  const acknowledgement = await acceptWebhookEvent({
    channelType: "slack",
    payload,
    receivedAt: new Date(),
  });
  return platformResponse(acknowledgement);
}

function readConfiguredString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value
    : undefined;
}

function platformResponse(
  acknowledgement: Readonly<{
    status: number;
    headers?: Readonly<Record<string, string>>;
    body?: string;
  }>,
): Response {
  return new NextResponse(acknowledgement.body ?? null, {
    status: acknowledgement.status,
    headers: acknowledgement.headers,
  });
}
