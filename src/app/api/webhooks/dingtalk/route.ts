import { NextResponse } from "next/server";
import { scheduleChannelMessageHandling } from "@/server/channels/dispatch";
import { normalizeDingTalkEvent } from "@/server/channels/normalize";
import { verifyDingTalkRobotCode } from "@/server/channels/webhook-auth";
import { readEnv } from "@/server/config/env";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const env = readEnv();
  const payload = await request.json();
  if (!verifyDingTalkRobotCode(env.dingTalkRobotCode, payload)) {
    return NextResponse.json({ error: "invalid DingTalk robot code" }, { status: 401 });
  }

  const message = normalizeDingTalkEvent(payload);
  if (!message) return NextResponse.json({ ok: true });

  scheduleChannelMessageHandling({ env, message, source: "DingTalk" });

  return NextResponse.json({ ok: true });
}
