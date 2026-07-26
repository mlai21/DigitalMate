import {
  getChannelManifest,
} from "@/server/channels/manifests/catalog";

export const WECHAT_DEFAULT_BASE_URL =
  "https://ilinkai.weixin.qq.com";

export type WechatConfig = Readonly<
  Record<string, unknown> & {
    enabled: boolean;
    bot_token: string;
    bot_token_file: string;
    base_url: string;
    media_dir: string | null;
    message_merge_enabled: boolean;
    message_merge_delay_ms: number;
    bot_prefix: string;
    filter_tool_messages: true;
    filter_thinking: true;
  }
>;

export const wechatConfigSchema =
  getChannelManifest("wechat").configSchema;

export function parseWechatConfig(
  input: unknown,
): WechatConfig {
  const parsed =
    wechatConfigSchema.parse(input) as WechatConfig;
  const botToken = parsed.bot_token.trim();
  const tokenFile = parsed.bot_token_file.trim();
  if (tokenFile) {
    throw new Error(
      "wechat_bot_token_file_unsupported",
    );
  }
  return {
    ...parsed,
    bot_token: botToken,
    bot_token_file: "",
    base_url: normalizeWechatBaseUrl(
      parsed.base_url || WECHAT_DEFAULT_BASE_URL,
    ),
    media_dir: parsed.media_dir?.trim() || null,
    filter_tool_messages: true,
    filter_thinking: true,
  };
}

export function normalizeWechatBaseUrl(
  input: string,
): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("wechat_base_url_invalid");
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.hash
    || url.search
    || url.port
    || (
      url.hostname !== "ilinkai.weixin.qq.com"
      && !url.hostname.endsWith(".weixin.qq.com")
    )
  ) {
    throw new Error("wechat_base_url_invalid");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}
