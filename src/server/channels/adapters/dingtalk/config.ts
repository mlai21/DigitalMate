import {
  getChannelManifest,
} from "@/server/channels/manifests/catalog";

export type DingTalkConfig = Readonly<
  Record<string, unknown> & {
    enabled: boolean;
    client_id: string;
    client_secret: string;
    message_type: "markdown" | "card";
    cron_message_type: "markdown" | "card";
    card_template_id: string;
    card_template_key: string;
    robot_code: string;
    card_auto_layout: boolean;
    at_sender_on_reply: boolean;
    streaming_enabled: boolean;
    endpoint: string;
  }
>;

export const dingTalkConfigSchema =
  getChannelManifest("dingtalk").configSchema;

export function parseDingTalkConfig(input: unknown): DingTalkConfig {
  const parsed = dingTalkConfigSchema.parse(input) as DingTalkConfig;
  const config = {
    ...parsed,
    endpoint: normalizeEndpoint(parsed.endpoint),
  };
  if (!config.client_id.trim()) {
    throw new Error("dingtalk_client_id_required");
  }
  if (!config.client_secret.trim()) {
    throw new Error("dingtalk_client_secret_required");
  }
  if (
    config.message_type === "card"
    || config.cron_message_type === "card"
  ) {
    if (!config.card_template_id.trim()) {
      throw new Error("dingtalk_card_template_id_required");
    }
    if (!config.card_template_key.trim()) {
      throw new Error("dingtalk_card_template_key_required");
    }
    if (!config.robot_code.trim()) {
      throw new Error("dingtalk_robot_code_required");
    }
  }
  if (
    config.streaming_enabled
    && config.message_type !== "card"
  ) {
    throw new Error("dingtalk_streaming_requires_card");
  }
  return config;
}

function normalizeEndpoint(value: string): string {
  const raw = value.trim() || "https://api.dingtalk.com";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("dingtalk_endpoint_invalid");
  }
  if (
    (
      url.protocol !== "https:"
      && !(
        url.protocol === "http:"
        && ["localhost", "127.0.0.1", "::1"].includes(
          url.hostname.toLowerCase(),
        )
      )
    )
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error("dingtalk_endpoint_invalid");
  }
  return url.toString().replace(/\/$/, "");
}
