import { NextResponse } from "next/server";
import {
  acceptWebhookEvent,
  loadWebhookAuthConfig,
} from "@/server/channels/adapters/webhook/route-runtime";
import { verifyTelegramWebhookSecret } from "@/server/channels/webhook-auth";
import { readEnv } from "@/server/config/env";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const env = readEnv();
  const config = await loadWebhookAuthConfig("telegram");
  const webhookSecret =
    readConfiguredString(config?.webhook_secret)
    ?? env.telegramWebhookSecret;
  if (!verifyTelegramWebhookSecret(webhookSecret, request.headers.get("x-telegram-bot-api-secret-token"))) {
    return NextResponse.json({ error: "invalid Telegram webhook secret" }, { status: 401 });
  }

  const update = await request.json();
  const acknowledgement = await acceptWebhookEvent({
    channelType: "telegram",
    payload: update,
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
