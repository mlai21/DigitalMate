import { describe, expect, it } from "vitest";

import {
  CHANNEL_TYPES,
  getChannelManifest,
} from "@/server/channels/manifests/catalog";

const BASE_FIELDS = [
  "enabled",
  "bot_prefix",
  "filter_tool_messages",
  "filter_thinking",
  "dm_policy",
  "group_policy",
  "allow_from",
  "deny_message",
  "require_mention",
  "no_text_debounce",
  "access_control_dm",
  "access_control_group",
  "dm_disabled",
  "group_disabled",
] as const;

const PLATFORM_FIELDS = {
  imessage: [
    "db_path",
    "poll_sec",
    "media_dir",
    "max_decoded_size",
  ],
  discord: [
    "bot_token",
    "http_proxy",
    "http_proxy_auth",
    "accept_bot_messages",
    "streaming_enabled",
    "media_dir",
  ],
  dingtalk: [
    "client_id",
    "client_secret",
    "message_type",
    "cron_message_type",
    "card_template_id",
    "card_template_key",
    "robot_code",
    "media_dir",
    "card_auto_layout",
    "at_sender_on_reply",
    "streaming_enabled",
    "endpoint",
  ],
  feishu: [
    "app_id",
    "app_secret",
    "encrypt_key",
    "verification_token",
    "media_dir",
    "domain",
    "streaming_enabled",
    "share_session_in_group",
  ],
  qq: [
    "app_id",
    "client_secret",
    "markdown_enabled",
    "max_reconnect_attempts",
    "ack_message",
  ],
  telegram: [
    "bot_token",
    "base_url",
    "http_proxy",
    "http_proxy_auth",
    "show_typing",
    "streaming_enabled",
  ],
  mattermost: [
    "url",
    "bot_token",
    "media_dir",
    "show_typing",
    "thread_follow_without_mention",
  ],
  mqtt: [
    "host",
    "port",
    "transport",
    "clean_session",
    "qos",
    "username",
    "password",
    "subscribe_topic",
    "publish_topic",
    "tls_enabled",
    "tls_ca_certs",
    "tls_certfile",
    "tls_keyfile",
  ],
  matrix: [
    "homeserver",
    "user_id",
    "access_token",
    "group_allow_from",
    "groups",
    "encryption",
    "vision_enabled",
    "history_limit",
    "password",
    "device_name",
    "sync_timeout_ms",
    "mention_pill_in_body",
    "outbound_structured_mentions",
    "streaming_enabled",
  ],
  slack: [
    "bot_token",
    "app_token",
    "proxy",
    "streaming_enabled",
    "media_dir",
  ],
  voice: [
    "twilio_account_sid",
    "twilio_auth_token",
    "phone_number",
    "phone_number_sid",
    "tts_provider",
    "tts_voice",
    "stt_provider",
    "language",
    "welcome_greeting",
  ],
  sip: [
    "sip_mode",
    "sip_host",
    "sip_port",
    "sip_username",
    "sip_password",
    "sip_server",
    "sip_transport",
    "rtp_port_low",
    "rtp_port_high",
    "dashscope_api_key",
    "tts_provider",
    "tts_voice",
    "stt_provider",
    "language",
    "welcome_greeting",
    "call_timeout",
    "livekit_url",
    "livekit_api_key",
    "livekit_api_secret",
    "livekit_sip_trunk_id",
    "livekit_room_name",
    "livekit_output_sample_rate",
    "max_concurrent_calls",
  ],
  wecom: [
    "bot_id",
    "secret",
    "media_dir",
    "welcome_text",
    "share_session_in_group",
    "max_reconnect_attempts",
    "streaming_enabled",
  ],
  xiaoyi: ["ak", "sk", "agent_id", "task_timeout_ms"],
  yuanbao: [
    "app_id",
    "app_secret",
    "api_domain",
    "media_dir",
    "accept_bot_messages",
  ],
  wechat: [
    "bot_token",
    "bot_token_file",
    "base_url",
    "media_dir",
    "message_merge_enabled",
    "message_merge_delay_ms",
  ],
  onebot: [
    "ws_host",
    "ws_port",
    "access_token",
    "share_session_in_group",
  ],
} as const;

const SECRET_FIELDS = {
  imessage: [],
  discord: ["bot_token", "http_proxy_auth"],
  dingtalk: ["client_secret"],
  feishu: [
    "app_secret",
    "encrypt_key",
    "verification_token",
  ],
  qq: ["client_secret"],
  telegram: ["bot_token", "http_proxy_auth"],
  mattermost: ["bot_token"],
  mqtt: ["password", "tls_keyfile"],
  matrix: ["access_token", "password"],
  slack: ["bot_token", "app_token"],
  voice: ["twilio_auth_token"],
  sip: [
    "sip_password",
    "dashscope_api_key",
    "livekit_api_key",
    "livekit_api_secret",
  ],
  wecom: ["secret"],
  xiaoyi: ["sk"],
  yuanbao: ["app_secret"],
  wechat: ["bot_token", "bot_token_file"],
  onebot: ["access_token"],
} as const;

describe("QwenPaw channel manifest catalog", () => {
  it("keeps the approved external-channel order without console", () => {
    expect(CHANNEL_TYPES).toEqual([
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
    ]);
  });

  it.each(CHANNEL_TYPES)(
    "%s preserves the upstream config field order and secret inventory",
    (type) => {
      const manifest = getChannelManifest(type);

      expect(manifest.fields.map((field) => field.name)).toEqual([
        ...BASE_FIELDS,
        ...PLATFORM_FIELDS[type],
      ]);
      expect(manifest.secretFields).toEqual(SECRET_FIELDS[type]);
      expect(
        manifest.fields.find(
          (field) => field.name === "filter_thinking",
        ),
      ).toMatchObject({ default: true, readonly: true });
      expect(
        manifest.fields.find(
          (field) => field.name === "filter_tool_messages",
        ),
      ).toMatchObject({ default: true, readonly: true });
    },
  );

  it("models Matrix per-room groups as bounded strict values", () => {
    const schema = getChannelManifest("matrix").configSchema;
    expect(
      schema.parse({
        groups: {
          "*": { autoReply: true, requireMention: false },
          "!room:example.com": { requireMention: true },
        },
      }).groups,
    ).toEqual({
      "*": { autoReply: true, requireMention: false },
      "!room:example.com": { requireMention: true },
    });
    expect(() =>
      schema.parse({
        groups: {
          "*": { requireMention: true, nested: { token: "secret" } },
        },
      }),
    ).toThrow();
    expect(() =>
      schema.parse({
        groups: Object.fromEntries(
          Array.from({ length: 257 }, (_, index) => [
            `!room-${index}:example.com`,
            { requireMention: true },
          ]),
        ),
      }),
    ).toThrow();
  });

  it("preserves Slack allow_from as the upstream nullable default", () => {
    const manifest = getChannelManifest("slack");
    expect(
      manifest.fields.find((field) => field.name === "allow_from"),
    ).toMatchObject({ default: null });
    expect(manifest.configSchema.parse({}).allow_from).toBeNull();
    expect(
      manifest.configSchema.parse({ allow_from: ["U123"] }).allow_from,
    ).toEqual(["U123"]);
  });

  it("accepts only finite positive SIP call timeout decimals", () => {
    const schema = getChannelManifest("sip").configSchema;
    expect(schema.parse({ call_timeout: 12.5 }).call_timeout).toBe(12.5);
    for (const value of [
      0,
      -0.1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      3_600.1,
    ]) {
      expect(() => schema.parse({ call_timeout: value })).toThrow();
    }
  });

  it.each(CHANNEL_TYPES)(
    "%s rejects unknown keys and invalid Unicode while forcing filters",
    (type) => {
      const schema = getChannelManifest(type).configSchema;
      expect(() => schema.parse({ nested: { token: "secret" } })).toThrow();
      expect(() => schema.parse({ bot_prefix: "\ud800" })).toThrow();
      expect(schema.parse({})).toMatchObject({
        filter_thinking: true,
        filter_tool_messages: true,
      });
      expect(
        schema.parse({
          filter_thinking: false,
          filter_tool_messages: false,
        }),
      ).toMatchObject({
        filter_thinking: true,
        filter_tool_messages: true,
      });
    },
  );

  it("records the upstream conditional form fields", () => {
    expect(
      getChannelManifest("matrix").conditions,
    ).toEqual([
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
    ]);
    expect(getChannelManifest("dingtalk").conditions).toEqual([
      {
        fields: [
          "card_template_id",
          "card_template_key",
          "robot_code",
        ],
        whenAny: [
          { field: "message_type", equals: "card" },
          { field: "cron_message_type", equals: "card" },
        ],
      },
    ]);
    expect(getChannelManifest("sip").conditions).toEqual([
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
    ]);
    expect(getChannelManifest("wechat").conditions).toEqual([
      {
        field: "message_merge_delay_ms",
        when: { field: "message_merge_enabled", equals: true },
      },
    ]);
  });

  it("snapshots the approved labels and all upstream defaults", () => {
    const signature = CHANNEL_TYPES.map((type) => {
      const manifest = getChannelManifest(type);
      return `${type}|${manifest.label}|${manifest.fields
        .map((field) => `${field.name}=${JSON.stringify(field.default)}`)
        .join(",")}`;
    }).join("\n");

    expect(signature).toBe(
      [
        'imessage|iMessage|enabled=false,bot_prefix="",filter_tool_messages=true,filter_thinking=true,dm_policy="open",group_policy="open",allow_from=[],deny_message="",require_mention=false,no_text_debounce=true,access_control_dm=false,access_control_group=false,dm_disabled=false,group_disabled=false,db_path="~/Library/Messages/chat.db",poll_sec=1,media_dir=null,max_decoded_size=10485760',
        'discord|Discord|enabled=false,bot_prefix="",filter_tool_messages=true,filter_thinking=true,dm_policy="open",group_policy="open",allow_from=[],deny_message="",require_mention=false,no_text_debounce=true,access_control_dm=false,access_control_group=false,dm_disabled=false,group_disabled=false,bot_token="",http_proxy="",http_proxy_auth="",accept_bot_messages=false,streaming_enabled=false,media_dir=null',
        'dingtalk|钉钉|enabled=false,bot_prefix="",filter_tool_messages=true,filter_thinking=true,dm_policy="open",group_policy="open",allow_from=[],deny_message="",require_mention=false,no_text_debounce=true,access_control_dm=false,access_control_group=false,dm_disabled=false,group_disabled=false,client_id="",client_secret="",message_type="markdown",cron_message_type="markdown",card_template_id="",card_template_key="content",robot_code="",media_dir=null,card_auto_layout=false,at_sender_on_reply=false,streaming_enabled=false,endpoint=""',
        'feishu|飞书|enabled=false,bot_prefix="",filter_tool_messages=true,filter_thinking=true,dm_policy="open",group_policy="open",allow_from=[],deny_message="",require_mention=false,no_text_debounce=true,access_control_dm=false,access_control_group=false,dm_disabled=false,group_disabled=false,app_id="",app_secret="",encrypt_key="",verification_token="",media_dir=null,domain="feishu",streaming_enabled=false,share_session_in_group=false',
        'qq|QQ|enabled=false,bot_prefix="",filter_tool_messages=true,filter_thinking=true,dm_policy="open",group_policy="open",allow_from=[],deny_message="",require_mention=false,no_text_debounce=true,access_control_dm=false,access_control_group=false,dm_disabled=false,group_disabled=false,app_id="",client_secret="",markdown_enabled=true,max_reconnect_attempts=100,ack_message=""',
        'telegram|Telegram|enabled=false,bot_prefix="",filter_tool_messages=true,filter_thinking=true,dm_policy="open",group_policy="open",allow_from=[],deny_message="",require_mention=false,no_text_debounce=true,access_control_dm=false,access_control_group=false,dm_disabled=false,group_disabled=false,bot_token="",base_url="",http_proxy="",http_proxy_auth="",show_typing=null,streaming_enabled=false',
        'mattermost|Mattermost|enabled=false,bot_prefix="",filter_tool_messages=true,filter_thinking=true,dm_policy="open",group_policy="open",allow_from=[],deny_message="",require_mention=false,no_text_debounce=true,access_control_dm=false,access_control_group=false,dm_disabled=false,group_disabled=false,url="",bot_token="",media_dir=null,show_typing=null,thread_follow_without_mention=false',
        'mqtt|MQTT|enabled=false,bot_prefix="",filter_tool_messages=true,filter_thinking=true,dm_policy="open",group_policy="open",allow_from=[],deny_message="",require_mention=false,no_text_debounce=true,access_control_dm=false,access_control_group=false,dm_disabled=false,group_disabled=false,host="",port=null,transport="",clean_session=true,qos=2,username=null,password=null,subscribe_topic="",publish_topic="",tls_enabled=false,tls_ca_certs=null,tls_certfile=null,tls_keyfile=null',
        'matrix|Matrix|enabled=false,bot_prefix="",filter_tool_messages=true,filter_thinking=true,dm_policy="open",group_policy="open",allow_from=[],deny_message="",require_mention=false,no_text_debounce=true,access_control_dm=false,access_control_group=false,dm_disabled=false,group_disabled=false,homeserver="",user_id="",access_token="",group_allow_from=[],groups={},encryption=false,vision_enabled=true,history_limit=50,password="",device_name="qwenpaw-worker",sync_timeout_ms=30000,mention_pill_in_body=false,outbound_structured_mentions=true,streaming_enabled=false',
        'slack|Slack|enabled=false,bot_prefix="",filter_tool_messages=true,filter_thinking=true,dm_policy="open",group_policy="open",allow_from=null,deny_message="",require_mention=true,no_text_debounce=true,access_control_dm=false,access_control_group=false,dm_disabled=false,group_disabled=false,bot_token="",app_token="",proxy=null,streaming_enabled=false,media_dir=null',
        'voice|Voice|enabled=false,bot_prefix="",filter_tool_messages=true,filter_thinking=true,dm_policy="open",group_policy="open",allow_from=[],deny_message="",require_mention=false,no_text_debounce=true,access_control_dm=false,access_control_group=false,dm_disabled=false,group_disabled=false,twilio_account_sid="",twilio_auth_token="",phone_number="",phone_number_sid="",tts_provider="google",tts_voice="en-US-Journey-D",stt_provider="deepgram",language="en-US",welcome_greeting="Hi! This is DigitalMate. How can I help you?"',
        'sip|SIP|enabled=false,bot_prefix="",filter_tool_messages=true,filter_thinking=true,dm_policy="open",group_policy="open",allow_from=[],deny_message="",require_mention=false,no_text_debounce=true,access_control_dm=false,access_control_group=false,dm_disabled=false,group_disabled=false,sip_mode="dev",sip_host="0.0.0.0",sip_port=5061,sip_username="",sip_password="",sip_server="",sip_transport="UDP",rtp_port_low=10000,rtp_port_high=20000,dashscope_api_key="",tts_provider="aliyun",tts_voice="",stt_provider="aliyun",language="zh-CN",welcome_greeting="你好，我是DigitalMate",call_timeout=120,livekit_url="",livekit_api_key="",livekit_api_secret="",livekit_sip_trunk_id="",livekit_room_name="sip-inbound",livekit_output_sample_rate=24000,max_concurrent_calls=5',
        'wecom|企业微信|enabled=false,bot_prefix="",filter_tool_messages=true,filter_thinking=true,dm_policy="open",group_policy="open",allow_from=[],deny_message="",require_mention=false,no_text_debounce=true,access_control_dm=false,access_control_group=false,dm_disabled=false,group_disabled=false,bot_id="",secret="",media_dir=null,welcome_text="",share_session_in_group=true,max_reconnect_attempts=-1,streaming_enabled=false',
        'xiaoyi|小艺|enabled=false,bot_prefix="",filter_tool_messages=true,filter_thinking=true,dm_policy="open",group_policy="open",allow_from=[],deny_message="",require_mention=false,no_text_debounce=true,access_control_dm=false,access_control_group=false,dm_disabled=false,group_disabled=false,ak="",sk="",agent_id="",task_timeout_ms=3600000',
        'yuanbao|腾讯元宝|enabled=false,bot_prefix="",filter_tool_messages=true,filter_thinking=true,dm_policy="open",group_policy="open",allow_from=[],deny_message="",require_mention=false,no_text_debounce=true,access_control_dm=false,access_control_group=false,dm_disabled=false,group_disabled=false,app_id="",app_secret="",api_domain="bot.yuanbao.tencent.com",media_dir=null,accept_bot_messages=false',
        'wechat|微信|enabled=false,bot_prefix="",filter_tool_messages=true,filter_thinking=true,dm_policy="open",group_policy="open",allow_from=[],deny_message="",require_mention=false,no_text_debounce=true,access_control_dm=false,access_control_group=false,dm_disabled=false,group_disabled=false,bot_token="",bot_token_file="",base_url="",media_dir=null,message_merge_enabled=false,message_merge_delay_ms=0',
        'onebot|OneBot|enabled=false,bot_prefix="",filter_tool_messages=true,filter_thinking=true,dm_policy="open",group_policy="open",allow_from=[],deny_message="",require_mention=false,no_text_debounce=true,access_control_dm=false,access_control_group=false,dm_disabled=false,group_disabled=false,ws_host="0.0.0.0",ws_port=6199,access_token="",share_session_in_group=false',
      ].join("\n"),
    );
  });
});
