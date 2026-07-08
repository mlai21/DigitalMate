import { NextResponse } from "next/server";
import { scheduleChannelMessageHandling } from "@/server/channels/dispatch";
import { normalizeSlackEvent } from "@/server/channels/normalize";
import { verifySlackRequest } from "@/server/channels/slack-signature";
import { readEnv } from "@/server/config/env";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const env = readEnv();
  const body = await request.text();
  if (
    env.slackSigningSecret &&
    !verifySlackRequest({
      signingSecret: env.slackSigningSecret,
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

  const message = normalizeSlackEvent(payload);
  if (!message) return NextResponse.json({ ok: true });

  scheduleChannelMessageHandling({ env, message, source: "Slack" });

  return NextResponse.json({ ok: true });
}
