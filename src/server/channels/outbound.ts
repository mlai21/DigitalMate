import type { AppEnv } from "@/server/config/env";
import type { NormalizedChannelMessage } from "@/server/channels/types";

export async function sendChannelMessage(env: AppEnv, message: NormalizedChannelMessage, text: string): Promise<void> {
  if (message.channel === "telegram") {
    await sendTelegramMessage(env, message.externalConversationId, text);
    return;
  }
  if (message.channel === "slack") {
    await sendSlackMessage(env, message.externalConversationId, text);
    return;
  }
  if (message.channel === "feishu") {
    await sendFeishuMessage(env, message.externalConversationId, text);
    return;
  }
  if (message.channel === "dingtalk") {
    await sendDingTalkSessionWebhook(message, text);
  }
}

async function sendTelegramMessage(env: AppEnv, chatId: string, text: string): Promise<void> {
  if (!env.telegramBotToken) return;
  const response = await fetch(`https://api.telegram.org/bot${env.telegramBotToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!response.ok) throw new Error(`Telegram sendMessage failed with status ${response.status}`);
}

async function sendSlackMessage(env: AppEnv, channel: string, text: string): Promise<void> {
  if (!env.slackBotToken) return;
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.slackBotToken}`,
    },
    body: JSON.stringify({ channel, text }),
  });
  if (!response.ok) throw new Error(`Slack chat.postMessage failed with status ${response.status}`);
  const payload = (await response.json()) as { ok?: boolean; error?: string };
  if (!payload.ok) throw new Error(`Slack chat.postMessage failed: ${payload.error ?? "unknown"}`);
}

async function sendFeishuMessage(env: AppEnv, chatId: string, text: string): Promise<void> {
  if (!env.feishuAppId || !env.feishuAppSecret) return;

  const tenantAccessToken = await getFeishuTenantAccessToken(env);
  const response = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${tenantAccessToken}`,
    },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text }),
    }),
  });
  if (!response.ok) throw new Error(`Feishu message create failed with status ${response.status}`);

  const payload = (await response.json()) as { code?: number; msg?: string };
  if (payload.code !== 0) throw new Error(`Feishu message create failed: ${payload.msg ?? "unknown"}`);
}

async function getFeishuTenantAccessToken(env: AppEnv): Promise<string> {
  const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      app_id: env.feishuAppId,
      app_secret: env.feishuAppSecret,
    }),
  });
  if (!response.ok) throw new Error(`Feishu tenant_access_token failed with status ${response.status}`);

  const payload = (await response.json()) as { code?: number; msg?: string; tenant_access_token?: string };
  if (payload.code !== 0 || !payload.tenant_access_token) {
    throw new Error(`Feishu tenant_access_token failed: ${payload.msg ?? "unknown"}`);
  }
  return payload.tenant_access_token;
}

async function sendDingTalkSessionWebhook(message: NormalizedChannelMessage, text: string): Promise<void> {
  const raw = message.raw as { sessionWebhook?: string } | undefined;
  if (!raw?.sessionWebhook) return;
  const response = await fetch(raw.sessionWebhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      msgtype: "text",
      text: { content: text },
    }),
  });
  if (!response.ok) throw new Error(`DingTalk sessionWebhook failed with status ${response.status}`);
}
