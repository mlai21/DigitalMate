import { NextResponse } from "next/server";
import {
  acceptWebhookEvent,
  loadWebhookAuthConfig,
} from "@/server/channels/adapters/webhook/route-runtime";
import { verifyFeishuVerificationToken } from "@/server/channels/webhook-auth";
import { readEnv } from "@/server/config/env";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const env = readEnv();
  const payload = await request.json();
  const config = await loadWebhookAuthConfig("feishu");
  const verificationToken =
    readConfiguredString(config?.verification_token)
    ?? env.feishuVerificationToken;
  if (!verifyFeishuVerificationToken(verificationToken, payload)) {
    return NextResponse.json({ error: "invalid Feishu verification token" }, { status: 401 });
  }

  if (typeof payload?.challenge === "string") {
    return NextResponse.json({ challenge: payload.challenge });
  }

  const acknowledgement = await acceptWebhookEvent({
    channelType: "feishu",
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
