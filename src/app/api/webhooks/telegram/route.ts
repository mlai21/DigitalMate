import { NextResponse } from "next/server";
import { scheduleChannelMessageHandling } from "@/server/channels/dispatch";
import { normalizeTelegramUpdate } from "@/server/channels/normalize";
import { verifyTelegramWebhookSecret } from "@/server/channels/webhook-auth";
import { readEnv } from "@/server/config/env";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const env = readEnv();
  if (!verifyTelegramWebhookSecret(env.telegramWebhookSecret, request.headers.get("x-telegram-bot-api-secret-token"))) {
    return NextResponse.json({ error: "invalid Telegram webhook secret" }, { status: 401 });
  }

  const update = await request.json();
  const message = normalizeTelegramUpdate(update);
  if (!message) return NextResponse.json({ ok: true });

  scheduleChannelMessageHandling({ env, message, source: "Telegram" });

  return NextResponse.json({ ok: true });
}
