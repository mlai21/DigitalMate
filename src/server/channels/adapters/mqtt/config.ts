import {
  getChannelManifest,
} from "@/server/channels/manifests/catalog";

export type MqttTransport = "tcp" | "tls" | "ws" | "wss";
export type MqttQos = 0 | 1 | 2;

export type MqttConfig = Readonly<
  Record<string, unknown> & {
    enabled: boolean;
    host: string;
    port: number;
    transport: MqttTransport;
    clean_session: boolean;
    qos: MqttQos;
    username: string | null;
    password: string | null;
    subscribe_topic: string;
    publish_topic: string;
    tls_enabled: boolean;
    tls_ca_certs: string | null;
    tls_certfile: string | null;
    tls_keyfile: string | null;
  }
>;

export const mqttConfigSchema =
  getChannelManifest("mqtt").configSchema;

export function parseMqttConfig(input: unknown): MqttConfig {
  const parsed = mqttConfigSchema.parse(input) as MqttConfig;
  const host = parsed.host.trim();
  const subscribeTopic = parsed.subscribe_topic.trim();
  const publishTopic = parsed.publish_topic.trim();
  const username = optionalString(parsed.username);
  const password = optionalString(parsed.password);
  const tlsCaCerts = optionalString(parsed.tls_ca_certs);
  const tlsCertfile = optionalString(parsed.tls_certfile);
  const tlsKeyfile = optionalString(parsed.tls_keyfile);

  if (!isValidMqttHost(host)) {
    throw new Error("mqtt_host_required");
  }
  if (!isValidMqttTopic(subscribeTopic, true)) {
    throw new Error("mqtt_subscribe_topic_invalid");
  }
  if (!isValidMqttTopic(publishTopic, false)) {
    throw new Error("mqtt_publish_topic_invalid");
  }
  if (
    (tlsCertfile === null) !== (tlsKeyfile === null)
  ) {
    throw new Error(
      "mqtt_tls_client_certificate_incomplete",
    );
  }

  return {
    ...parsed,
    host,
    subscribe_topic: subscribeTopic,
    publish_topic: publishTopic,
    username,
    password,
    tls_ca_certs: tlsCaCerts,
    tls_certfile: tlsCertfile,
    tls_keyfile: tlsKeyfile,
  };
}

export function isValidMqttClientId(value: string): boolean {
  const length = Buffer.byteLength(value, "utf8");
  return value.length > 0
    && length <= 65_535
    && !/[\u0000-\u001f\u007f/+#]/u.test(value)
    && hasWellFormedUnicode(value);
}

function isValidMqttHost(value: string): boolean {
  if (
    value.length === 0
    || value.length > 253
    || /[\s/?#@]/u.test(value)
    || !hasWellFormedUnicode(value)
  ) {
    return false;
  }
  try {
    const url = new URL(`mqtt://${value}`);
    return url.hostname.length > 0
      && url.port.length === 0
      && url.pathname === ""
      && url.username === ""
      && url.password === "";
  } catch {
    return false;
  }
}

function isValidMqttTopic(
  value: string,
  allowWildcards: boolean,
): boolean {
  const length = Buffer.byteLength(value, "utf8");
  if (
    value.length === 0
    || length > 65_535
    || value.includes("\u0000")
    || !hasWellFormedUnicode(value)
  ) {
    return false;
  }
  if (!allowWildcards && /[+#]/u.test(value)) {
    return false;
  }
  return allowWildcards
    ? validSubscribeWildcards(value)
    : true;
}

function validSubscribeWildcards(topic: string): boolean {
  const levels = topic.split("/");
  return levels.every((level, index) => {
    if (level.includes("#")) {
      return level === "#" && index === levels.length - 1;
    }
    return !level.includes("+") || level === "+";
  });
}

function optionalString(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}
