import {
  getChannelManifest,
} from "@/server/channels/manifests/catalog";

export type MatrixRoomConfig = Readonly<{
  autoReply?: boolean;
  requireMention?: boolean;
}>;

export type MatrixConfig = Readonly<
  Record<string, unknown> & {
    enabled: boolean;
    homeserver: string;
    user_id: string;
    access_token: string | null;
    password: string | null;
    device_name: string;
    group_allow_from: readonly string[];
    groups: Readonly<Record<string, MatrixRoomConfig>>;
    encryption: boolean;
    vision_enabled: boolean;
    history_limit: number;
    sync_timeout_ms: number;
    mention_pill_in_body: boolean;
    outbound_structured_mentions: boolean;
    streaming_enabled: boolean;
  }
>;

export const matrixConfigSchema =
  getChannelManifest("matrix").configSchema;

export function parseMatrixConfig(input: unknown): MatrixConfig {
  const candidate = input !== null
    && typeof input === "object"
    && !Array.isArray(input)
    ? {
        ...input,
        ...("access_token" in input && input.access_token === null
          ? { access_token: "" }
          : {}),
        ...("password" in input && input.password === null
          ? { password: "" }
          : {}),
      }
    : input;
  const parsed = matrixConfigSchema.parse(candidate) as MatrixConfig;
  const homeserver = normalizeHomeserver(parsed.homeserver);
  const userId = parsed.user_id.trim();
  const accessToken = optionalString(parsed.access_token);
  const password = optionalString(parsed.password);
  const deviceName = parsed.device_name.trim();
  const groupAllowFrom = parsed.group_allow_from
    .map((value) => value.trim())
    .filter((value, index, values) =>
      isMatrixRoomId(value) && values.indexOf(value) === index
    );

  if (!homeserver) {
    throw new Error("matrix_homeserver_invalid");
  }
  if (!isMatrixUserId(userId)) {
    throw new Error("matrix_user_id_invalid");
  }
  if (!accessToken && !password) {
    throw new Error("matrix_credentials_required");
  }
  if (deviceName.length === 0) {
    throw new Error("matrix_device_name_required");
  }
  if (groupAllowFrom.length !== parsed.group_allow_from.length) {
    throw new Error("matrix_group_allow_from_invalid");
  }

  return {
    ...parsed,
    homeserver,
    user_id: userId,
    access_token: accessToken,
    password,
    device_name: deviceName,
    group_allow_from: groupAllowFrom,
  };
}

export function isMatrixUserId(value: string): boolean {
  return /^@[^\s:]{1,255}:[^\s:]+(?::\d{1,5})?$/u.test(value);
}

export function isMatrixRoomId(value: string): boolean {
  return /^![^\s:]{1,255}:[^\s:]+(?::\d{1,5})?$/u.test(value);
}

function normalizeHomeserver(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (
      !["http:", "https:"].includes(url.protocol)
      || url.username
      || url.password
      || url.search
      || url.hash
    ) {
      return null;
    }
    url.pathname = url.pathname.replace(/\/+$/u, "");
    return url.toString().replace(/\/$/u, "");
  } catch {
    return null;
  }
}

function optionalString(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}
