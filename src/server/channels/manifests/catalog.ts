import { z } from "zod";

import type {
  ChannelCapability,
  ChannelConfigField,
  ChannelFormCondition,
  ChannelManifest,
  ChannelRuntimeKind,
} from "./types";

export const CHANNEL_TYPES = [
  "imessage",
  "discord",
  "dingtalk",
  "feishu",
  "qq",
  "telegram",
  "mattermost",
  "mqtt",
  "matrix",
  "slack",
  "voice",
  "sip",
  "wecom",
  "xiaoyi",
  "yuanbao",
  "wechat",
  "onebot",
] as const;

export type ChannelType = (typeof CHANNEL_TYPES)[number];

type FieldDefinition = ChannelConfigField & {
  schema: z.ZodType;
};

const hasWellFormedUnicode = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) {
        return false;
      }
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
};

const safeStringSchema = (maximum = 4_096) =>
  z.string().max(maximum).refine(hasWellFormedUnicode, {
    message: "包含无效 Unicode 字符",
  });

const safeKeySchema = safeStringSchema(512).min(1);
const nullableStringSchema = safeStringSchema().nullable().default(null);
const secretStringSchema = safeStringSchema(12_000).default("");
const nullableSecretSchema = safeStringSchema(12_000).nullable().default(null);

const urlSchema = safeStringSchema()
  .refine((value) => {
    if (value.length === 0) {
      return true;
    }
    try {
      const parsed = new URL(value);
      return parsed.username.length === 0 && parsed.password.length === 0;
    } catch {
      return false;
    }
  }, "必须是有效 URL，且不得包含用户名或密码")
  .default("");

const nullableUrlSchema = safeStringSchema()
  .nullable()
  .refine((value) => {
    if (value === null || value.length === 0) {
      return true;
    }
    try {
      const parsed = new URL(value);
      return parsed.username.length === 0 && parsed.password.length === 0;
    } catch {
      return false;
    }
  }, "必须是有效 URL，且不得包含用户名或密码")
  .default(null);

const stringListSchema = z
  .array(safeStringSchema(512))
  .max(256)
  .refine((items) => new Set(items).size === items.length, {
    message: "不得包含重复项",
  })
  .default([]);
const nullableStringListSchema = stringListSchema
  .nullable()
  .default(null);

const field = (
  name: string,
  label: string,
  kind: ChannelConfigField["kind"],
  schema: z.ZodType,
  defaultValue: ChannelConfigField["default"],
  options: Partial<Pick<ChannelConfigField, "options" | "readonly" | "required">> = {},
): FieldDefinition => ({
  name,
  label,
  kind,
  schema,
  default: defaultValue,
  ...options,
});

const stringField = (
  name: string,
  label: string,
  defaultValue = "",
  options?: Parameters<typeof field>[5],
) =>
  field(
    name,
    label,
    "string",
    safeStringSchema().default(defaultValue),
    defaultValue,
    options,
  );

const nullableStringField = (name: string, label: string) =>
  field(name, label, "string", nullableStringSchema, null);

const urlField = (name: string, label: string, defaultValue = "") =>
  field(
    name,
    label,
    "string",
    defaultValue === "" ? urlSchema : urlSchema.default(defaultValue),
    defaultValue,
  );

const nullableUrlField = (name: string, label: string) =>
  field(name, label, "string", nullableUrlSchema, null);

const secretField = (
  name: string,
  label: string,
  nullable = false,
  required = false,
) =>
  field(
    name,
    label,
    "secret",
    nullable ? nullableSecretSchema : secretStringSchema,
    nullable ? null : "",
    { required },
  );

const booleanField = (
  name: string,
  label: string,
  defaultValue: boolean,
  readonly = false,
) =>
  field(
    name,
    label,
    "boolean",
    z.boolean().default(defaultValue),
    defaultValue,
    { readonly },
  );

const numberField = (
  name: string,
  label: string,
  defaultValue: number | null,
  minimum?: number,
  maximum?: number,
  integer = true,
) => {
  let schema = z.number().finite();
  if (minimum !== undefined) {
    schema = schema.min(minimum);
  }
  if (maximum !== undefined) {
    schema = schema.max(maximum);
  }
  return field(
    name,
    label,
    "number",
    defaultValue === null
      ? (integer ? schema.int() : schema).nullable().default(null)
      : (integer ? schema.int() : schema).default(defaultValue),
    defaultValue,
  );
};

const selectField = <TValues extends readonly [string, ...string[]]>(
  name: string,
  label: string,
  values: TValues,
  defaultValue: TValues[number],
) =>
  field(
    name,
    label,
    "select",
    z.enum(values).default(defaultValue),
    defaultValue,
    {
      options: values.map((value) => ({ label: value, value })),
    },
  );

const listField = (name: string, label: string) =>
  field(name, label, "string-list", stringListSchema, []);

const nullableListField = (name: string, label: string) =>
  field(name, label, "string-list", nullableStringListSchema, null);

const positiveNumberField = (
  name: string,
  label: string,
  defaultValue: number,
  maximum: number,
) =>
  field(
    name,
    label,
    "number",
    z.number().finite().positive().max(maximum).default(defaultValue),
    defaultValue,
  );

const BASE_FIELDS: readonly FieldDefinition[] = [
  booleanField("enabled", "启用渠道", false),
  stringField("bot_prefix", "机器人前缀"),
  booleanField("filter_tool_messages", "过滤工具消息", true, true),
  booleanField("filter_thinking", "过滤思考消息", true, true),
  selectField("dm_policy", "私聊策略", ["open", "allowlist"], "open"),
  selectField(
    "group_policy",
    "群聊策略",
    ["open", "allowlist"],
    "open",
  ),
  listField("allow_from", "允许来源"),
  stringField("deny_message", "拒绝提示"),
  booleanField("require_mention", "群聊需要 @", false),
  booleanField("no_text_debounce", "非文本消息防抖", true),
  booleanField("access_control_dm", "私聊访问控制", false),
  booleanField("access_control_group", "群聊访问控制", false),
  booleanField("dm_disabled", "禁用私聊", false),
  booleanField("group_disabled", "禁用群聊", false),
];

const matrixGroupsSchema = z
  .record(
    safeKeySchema,
    z
      .object({
        autoReply: z.boolean().optional(),
        requireMention: z.boolean().optional(),
      })
      .strict(),
  )
  .refine((groups) => Object.keys(groups).length <= 256, {
    message: "Matrix 群组配置最多 256 项",
  })
  .default({});

type ManifestDefinition = {
  label: string;
  description: string;
  runtime: ChannelRuntimeKind;
  capabilities: readonly ChannelCapability[];
  prerequisites?: readonly string[];
  platformFields: readonly FieldDefinition[];
  conditions?: readonly ChannelFormCondition[];
};

const DEFINITIONS: Record<ChannelType, ManifestDefinition> = {
  imessage: {
    label: "iMessage",
    description: "通过本机 macOS Messages 数据库收发消息",
    runtime: "node",
    capabilities: ["attachments"],
    prerequisites: ["macOS", "Messages 数据库读取权限"],
    platformFields: [
      stringField("db_path", "Messages 数据库路径", "~/Library/Messages/chat.db"),
      numberField("poll_sec", "轮询间隔（秒）", 1, 0.1, 3_600, false),
      nullableStringField("media_dir", "媒体目录"),
      numberField("max_decoded_size", "最大解码大小", 10_485_760, 1, 104_857_600),
    ],
  },
  discord: {
    label: "Discord",
    description: "连接 Discord Bot",
    runtime: "central",
    capabilities: ["attachments", "groups", "streaming", "typing"],
    platformFields: [
      secretField("bot_token", "Bot Token", false, true),
      urlField("http_proxy", "HTTP 代理"),
      secretField("http_proxy_auth", "HTTP 代理认证"),
      booleanField("accept_bot_messages", "接收机器人消息", false),
      booleanField("streaming_enabled", "流式回复", false),
      nullableStringField("media_dir", "媒体目录"),
    ],
  },
  dingtalk: {
    label: "钉钉",
    description: "连接钉钉机器人",
    runtime: "central",
    capabilities: ["attachments", "groups", "streaming"],
    platformFields: [
      stringField("client_id", "Client ID"),
      secretField("client_secret", "Client Secret", false, true),
      selectField("message_type", "消息类型", ["markdown", "card"], "markdown"),
      selectField(
        "cron_message_type",
        "定时消息类型",
        ["markdown", "card"],
        "markdown",
      ),
      stringField("card_template_id", "卡片模板 ID"),
      stringField("card_template_key", "卡片内容字段", "content"),
      stringField("robot_code", "机器人 Code"),
      nullableStringField("media_dir", "媒体目录"),
      booleanField("card_auto_layout", "卡片自动布局", false),
      booleanField("at_sender_on_reply", "回复时 @ 发送者", false),
      booleanField("streaming_enabled", "流式回复", false),
      urlField("endpoint", "API Endpoint"),
    ],
    conditions: [
      {
        fields: ["card_template_id", "card_template_key", "robot_code"],
        whenAny: [
          { field: "message_type", equals: "card" },
          { field: "cron_message_type", equals: "card" },
        ],
      },
    ],
  },
  feishu: {
    label: "飞书",
    description: "连接飞书或 Lark 应用",
    runtime: "central",
    capabilities: ["attachments", "groups", "streaming", "typing"],
    platformFields: [
      stringField("app_id", "App ID"),
      secretField("app_secret", "App Secret", false, true),
      secretField("encrypt_key", "Encrypt Key"),
      secretField("verification_token", "Verification Token"),
      nullableStringField("media_dir", "媒体目录"),
      selectField("domain", "平台域名", ["feishu", "lark"], "feishu"),
      booleanField("streaming_enabled", "流式回复", false),
      booleanField("share_session_in_group", "群聊共享会话", false),
    ],
  },
  qq: {
    label: "QQ",
    description: "连接 QQ 机器人",
    runtime: "central",
    capabilities: ["attachments", "groups"],
    platformFields: [
      stringField("app_id", "App ID"),
      secretField("client_secret", "Client Secret", false, true),
      booleanField("markdown_enabled", "Markdown 消息", true),
      numberField("max_reconnect_attempts", "最大重连次数", 100, -1, 10_000),
      stringField("ack_message", "确认消息"),
    ],
  },
  telegram: {
    label: "Telegram",
    description: "连接 Telegram Bot",
    runtime: "central",
    capabilities: ["attachments", "groups", "streaming", "typing"],
    platformFields: [
      secretField("bot_token", "Bot Token", false, true),
      urlField("base_url", "API Base URL"),
      urlField("http_proxy", "HTTP 代理"),
      secretField("http_proxy_auth", "HTTP 代理认证"),
      field(
        "show_typing",
        "显示正在输入",
        "boolean",
        z.boolean().nullable().default(null),
        null,
      ),
      booleanField("streaming_enabled", "流式回复", false),
    ],
  },
  mattermost: {
    label: "Mattermost",
    description: "连接 Mattermost Bot",
    runtime: "central",
    capabilities: ["attachments", "groups", "typing"],
    platformFields: [
      urlField("url", "服务器 URL"),
      secretField("bot_token", "Bot Token", false, true),
      nullableStringField("media_dir", "媒体目录"),
      field(
        "show_typing",
        "显示正在输入",
        "boolean",
        z.boolean().nullable().default(null),
        null,
      ),
      booleanField("thread_follow_without_mention", "无需 @ 跟进线程", false),
    ],
  },
  mqtt: {
    label: "MQTT",
    description: "通过 MQTT 主题收发消息",
    runtime: "central",
    capabilities: [],
    platformFields: [
      stringField("host", "主机"),
      numberField("port", "端口", null, 1, 65_535),
      selectField(
        "transport",
        "传输方式",
        ["", "tcp", "websockets"],
        "",
      ),
      booleanField("clean_session", "清理会话", true),
      numberField("qos", "QoS", 2, 0, 2),
      nullableStringField("username", "用户名"),
      secretField("password", "密码", true),
      stringField("subscribe_topic", "订阅主题"),
      stringField("publish_topic", "发布主题"),
      booleanField("tls_enabled", "启用 TLS", false),
      nullableStringField("tls_ca_certs", "TLS CA 证书路径"),
      nullableStringField("tls_certfile", "TLS 客户端证书路径"),
      secretField("tls_keyfile", "TLS 私钥文件", true),
    ],
  },
  matrix: {
    label: "Matrix",
    description: "连接 Matrix homeserver",
    runtime: "central",
    capabilities: ["attachments", "groups", "streaming", "typing"],
    platformFields: [
      urlField("homeserver", "Homeserver"),
      stringField("user_id", "User ID"),
      secretField("access_token", "Access Token"),
      listField("group_allow_from", "允许群组"),
      field("groups", "房间设置", "object", matrixGroupsSchema, {}),
      booleanField("encryption", "端到端加密", false),
      booleanField("vision_enabled", "视觉能力", true),
      numberField("history_limit", "历史消息数量", 50, 0, 1_000),
      secretField("password", "密码"),
      stringField("device_name", "设备名称", "qwenpaw-worker"),
      numberField("sync_timeout_ms", "同步超时（毫秒）", 30_000, 5_000, 300_000),
      booleanField("mention_pill_in_body", "正文包含提及标签", false),
      booleanField("outbound_structured_mentions", "发送结构化提及", true),
      booleanField("streaming_enabled", "流式回复", false),
    ],
    conditions: [
      {
        field: "access_token",
        when: { field: "auth_method", equals: "token" },
      },
      {
        field: "password",
        when: { field: "auth_method", equals: "password" },
      },
      {
        field: "encryption",
        when: { field: "auth_method", equals: "password" },
      },
    ],
  },
  slack: {
    label: "Slack",
    description: "连接 Slack Socket Mode 应用",
    runtime: "central",
    capabilities: ["attachments", "groups", "streaming"],
    platformFields: [
      secretField("bot_token", "Bot Token", false, true),
      secretField("app_token", "App Token", false, true),
      nullableUrlField("proxy", "代理 URL"),
      booleanField("streaming_enabled", "流式回复", false),
      nullableStringField("media_dir", "媒体目录"),
    ],
  },
  voice: {
    label: "Voice",
    description: "通过 Twilio 提供语音电话",
    runtime: "media",
    capabilities: [],
    prerequisites: ["Twilio 账号"],
    platformFields: [
      stringField("twilio_account_sid", "Twilio Account SID"),
      secretField("twilio_auth_token", "Twilio Auth Token", false, true),
      stringField("phone_number", "电话号码"),
      stringField("phone_number_sid", "电话号码 SID"),
      stringField("tts_provider", "TTS 服务", "google"),
      stringField("tts_voice", "TTS 音色", "en-US-Journey-D"),
      stringField("stt_provider", "STT 服务", "deepgram"),
      stringField("language", "语言", "en-US"),
      stringField(
        "welcome_greeting",
        "欢迎语",
        "Hi! This is DigitalMate. How can I help you?",
      ),
    ],
  },
  sip: {
    label: "SIP",
    description: "通过 SIP 或 LiveKit 提供语音电话",
    runtime: "node",
    capabilities: [],
    prerequisites: ["SIP 或 LiveKit 服务"],
    platformFields: [
      selectField("sip_mode", "SIP 模式", ["dev", "livekit"], "dev"),
      stringField("sip_host", "SIP 主机", "0.0.0.0"),
      numberField("sip_port", "SIP 端口", 5_061, 1, 65_535),
      stringField("sip_username", "SIP 用户名"),
      secretField("sip_password", "SIP 密码"),
      stringField("sip_server", "SIP 服务器"),
      selectField("sip_transport", "SIP 传输", ["UDP", "TCP", "TLS"], "UDP"),
      numberField("rtp_port_low", "RTP 起始端口", 10_000, 1, 65_535),
      numberField("rtp_port_high", "RTP 结束端口", 20_000, 1, 65_535),
      secretField("dashscope_api_key", "DashScope API Key"),
      stringField("tts_provider", "TTS 服务", "aliyun"),
      stringField("tts_voice", "TTS 音色"),
      stringField("stt_provider", "STT 服务", "aliyun"),
      stringField("language", "语言", "zh-CN"),
      stringField("welcome_greeting", "欢迎语", "你好，我是DigitalMate"),
      positiveNumberField("call_timeout", "呼叫超时（秒）", 120, 3_600),
      urlField("livekit_url", "LiveKit URL"),
      secretField("livekit_api_key", "LiveKit API Key"),
      secretField("livekit_api_secret", "LiveKit API Secret"),
      stringField("livekit_sip_trunk_id", "LiveKit SIP Trunk ID"),
      stringField("livekit_room_name", "LiveKit 房间名", "sip-inbound"),
      numberField("livekit_output_sample_rate", "LiveKit 输出采样率", 24_000, 8_000, 192_000),
      numberField("max_concurrent_calls", "最大并发通话", 5, 1, 100),
    ],
    conditions: [
      {
        fields: [
          "livekit_url",
          "livekit_api_key",
          "livekit_api_secret",
          "livekit_sip_trunk_id",
          "livekit_room_name",
        ],
        when: { field: "sip_mode", equals: "livekit" },
      },
    ],
  },
  wecom: {
    label: "企业微信",
    description: "连接企业微信智能机器人",
    runtime: "central",
    capabilities: ["attachments", "groups", "streaming"],
    platformFields: [
      stringField("bot_id", "Bot ID"),
      secretField("secret", "Secret", false, true),
      nullableStringField("media_dir", "媒体目录"),
      stringField("welcome_text", "欢迎语"),
      booleanField("share_session_in_group", "群聊共享会话", true),
      numberField("max_reconnect_attempts", "最大重连次数", -1, -1, 10_000),
      booleanField("streaming_enabled", "流式回复", false),
    ],
  },
  xiaoyi: {
    label: "小艺",
    description: "连接华为小艺智能体",
    runtime: "central",
    capabilities: [],
    platformFields: [
      stringField("ak", "Access Key"),
      secretField("sk", "Secret Key", false, true),
      stringField("agent_id", "Agent ID"),
      numberField("task_timeout_ms", "任务超时（毫秒）", 3_600_000, 1_000, 86_400_000),
    ],
  },
  yuanbao: {
    label: "腾讯元宝",
    description: "连接腾讯元宝智能体",
    runtime: "central",
    capabilities: ["attachments", "typing"],
    platformFields: [
      stringField("app_id", "App ID"),
      secretField("app_secret", "App Secret", false, true),
      stringField("api_domain", "API 域名", "bot.yuanbao.tencent.com"),
      nullableStringField("media_dir", "媒体目录"),
      booleanField("accept_bot_messages", "接收机器人消息", false),
    ],
  },
  wechat: {
    label: "微信",
    description: "连接微信机器人网关",
    runtime: "gateway",
    capabilities: ["attachments", "groups", "typing"],
    platformFields: [
      secretField("bot_token", "Bot Token"),
      secretField("bot_token_file", "Bot Token 文件"),
      urlField("base_url", "API Base URL"),
      nullableStringField("media_dir", "媒体目录"),
      booleanField("message_merge_enabled", "合并消息", false),
      numberField("message_merge_delay_ms", "消息合并延迟（毫秒）", 0, 0, 60_000),
    ],
    conditions: [
      {
        field: "message_merge_delay_ms",
        when: { field: "message_merge_enabled", equals: true },
      },
    ],
  },
  onebot: {
    label: "OneBot",
    description: "连接 OneBot WebSocket 网关",
    runtime: "gateway",
    capabilities: ["attachments", "groups"],
    platformFields: [
      stringField("ws_host", "WebSocket 主机", "0.0.0.0"),
      numberField("ws_port", "WebSocket 端口", 6_199, 1, 65_535),
      secretField("access_token", "Access Token"),
      booleanField("share_session_in_group", "群聊共享会话", false),
    ],
  },
};

const buildManifest = <TType extends ChannelType>(
  type: TType,
): ChannelManifest<TType> => {
  const definition = DEFINITIONS[type];
  const definitions = [
    ...BASE_FIELDS.map((baseField) => {
      if (type !== "slack") return baseField;
      if (baseField.name === "allow_from") {
        return nullableListField("allow_from", "允许来源");
      }
      if (baseField.name === "require_mention") {
        return booleanField("require_mention", "群聊需要 @", true);
      }
      return baseField;
    }),
    ...definition.platformFields,
  ];
  const shape = Object.fromEntries(
    definitions.map(({ name, schema }) => [name, schema]),
  );
  const schema = z
    .object(shape)
    .strict()
    .transform((config) => ({
      ...config,
      filter_tool_messages: true,
      filter_thinking: true,
    }));

  return {
    type,
    label: definition.label,
    description: definition.description,
    runtime: definition.runtime,
    capabilities: definition.capabilities,
    prerequisites: definition.prerequisites ?? [],
    fields: definitions.map(({ schema: internalSchema, ...configField }) => {
      void internalSchema;
      return configField;
    }),
    secretFields: definitions
      .filter(({ kind }) => kind === "secret")
      .map(({ name }) => name),
    conditions: definition.conditions ?? [],
    configSchema: schema,
  };
};

export const CHANNEL_MANIFESTS = Object.freeze(
  Object.fromEntries(
    CHANNEL_TYPES.map((type) => [type, buildManifest(type)]),
  ) as { [TType in ChannelType]: ChannelManifest<TType> },
);

export const isChannelType = (value: string): value is ChannelType =>
  (CHANNEL_TYPES as readonly string[]).includes(value);

export const getChannelManifest = <TType extends ChannelType>(
  type: TType,
): ChannelManifest<TType> => CHANNEL_MANIFESTS[type];

export type {
  ChannelConfigField,
  ChannelFormCondition,
  ChannelManifest,
} from "./types";
