import { NextResponse } from "next/server";
import { scheduleChannelMessageHandling } from "@/server/channels/dispatch";
import { normalizeFeishuEvent } from "@/server/channels/normalize";
import { verifyFeishuVerificationToken } from "@/server/channels/webhook-auth";
import { readEnv } from "@/server/config/env";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const env = readEnv();
  const payload = await request.json();
  if (!verifyFeishuVerificationToken(env.feishuVerificationToken, payload)) {
    return NextResponse.json({ error: "invalid Feishu verification token" }, { status: 401 });
  }

  if (typeof payload?.challenge === "string") {
    return NextResponse.json({ challenge: payload.challenge });
  }

  const message = normalizeFeishuEvent(payload);
  if (!message) return NextResponse.json({ ok: true });

  scheduleChannelMessageHandling({ env, message, source: "Feishu" });

  return NextResponse.json({ ok: true });
}
