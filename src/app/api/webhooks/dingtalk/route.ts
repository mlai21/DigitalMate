import { NextResponse } from "next/server";
import {
  acceptWebhookEvent,
  loadWebhookAuthConfig,
} from "@/server/channels/adapters/webhook/route-runtime";
import { verifyDingTalkRobotCode } from "@/server/channels/webhook-auth";
import { readEnv } from "@/server/config/env";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const env = readEnv();
  const payload = await request.json();
  const config = await loadWebhookAuthConfig("dingtalk");
  const robotCode =
    readConfiguredString(config?.robot_code)
    ?? env.dingTalkRobotCode;
  if (!verifyDingTalkRobotCode(robotCode, payload)) {
    return NextResponse.json({ error: "invalid DingTalk robot code" }, { status: 401 });
  }

  const acknowledgement = await acceptWebhookEvent({
    channelType: "dingtalk",
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
