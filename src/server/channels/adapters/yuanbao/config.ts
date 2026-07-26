import {
  getChannelManifest,
} from "@/server/channels/manifests/catalog";

export type YuanbaoConfig = Readonly<
  Record<string, unknown> & {
    enabled: boolean;
    app_id: string;
    app_secret: string;
    api_domain: string;
    media_dir: string | null;
    accept_bot_messages: boolean;
    bot_prefix: string;
    filter_tool_messages: true;
    filter_thinking: true;
  }
>;

export const yuanbaoConfigSchema =
  getChannelManifest("yuanbao").configSchema;

export function parseYuanbaoConfig(
  input: unknown,
): YuanbaoConfig {
  const parsed =
    yuanbaoConfigSchema.parse(input) as YuanbaoConfig;
  const appId = parsed.app_id.trim();
  const appSecret = parsed.app_secret.trim();
  const apiDomain = normalizeApiDomain(
    parsed.api_domain,
  );
  if (!appId) {
    throw new Error("yuanbao_app_id_required");
  }
  if (!appSecret) {
    throw new Error("yuanbao_app_secret_required");
  }
  if (Array.from(parsed.bot_prefix).length >= 2_800) {
    throw new Error("yuanbao_bot_prefix_too_long");
  }
  return {
    ...parsed,
    app_id: appId,
    app_secret: appSecret,
    api_domain: apiDomain,
    media_dir:
      parsed.media_dir?.trim() || null,
    filter_tool_messages: true,
    filter_thinking: true,
  };
}

function normalizeApiDomain(value: string): string {
  const normalized = value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  if (
    !normalized
    || normalized.length > 253
    || normalized.includes("/")
    || normalized.includes("@")
  ) {
    throw new Error("yuanbao_api_domain_invalid");
  }
  let url: URL;
  try {
    url = new URL(`https://${normalized}`);
  } catch {
    throw new Error("yuanbao_api_domain_invalid");
  }
  if (
    url.protocol !== "https:"
    || url.port
    || url.username
    || url.password
    || url.pathname !== "/"
    || !url.hostname.includes(".")
  ) {
    throw new Error("yuanbao_api_domain_invalid");
  }
  return url.hostname;
}
