import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

const sipRunnerConfigSchema = z
  .object({
    connection_id: z.string().uuid(),
    sip_mode: z.enum(["dev", "livekit"]).default("dev"),
    sip_host: z.string().min(1).max(255).default("127.0.0.1"),
    sip_port: z.number().int().min(1).max(65_535).default(5_060),
    sip_username: z.string().max(255).default(""),
    sip_password: z.string().max(4_096).default(""),
    sip_server: z.string().max(2_048).default(""),
    sip_transport: z
      .enum(["UDP", "TCP", "TLS"])
      .default("UDP"),
    rtp_port_low: z
      .number()
      .int()
      .min(1_024)
      .max(65_534)
      .default(10_000),
    rtp_port_high: z
      .number()
      .int()
      .min(1_025)
      .max(65_535)
      .default(20_000),
    dashscope_api_key: z.string().min(1).max(4_096),
    stt_provider: z
      .enum(["aliyun", "dashscope"])
      .default("aliyun"),
    tts_provider: z
      .enum(["aliyun", "dashscope"])
      .default("aliyun"),
    tts_voice: z
      .string()
      .max(255)
      .default(""),
    language: z.string().min(1).max(32).default("zh-CN"),
    welcome_greeting: z.string().max(4_096).default(""),
    call_timeout: z
      .number()
      .int()
      .min(10)
      .max(3_600)
      .default(120),
    livekit_url: z.string().max(2_048).default(""),
    livekit_api_key: z.string().max(4_096).default(""),
    livekit_api_secret: z.string().max(4_096).default(""),
    livekit_sip_trunk_id: z.string().max(1_024).default(""),
    livekit_room_name: z
      .string()
      .min(1)
      .max(255)
      .default("sip-inbound"),
    livekit_output_sample_rate: z
      .number()
      .int()
      .refine((value) => value === 24_000, {
        message: "sip_livekit_sample_rate_invalid",
      })
      .default(24_000),
    max_concurrent_calls: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(5),
  })
  .strict();

export type SipRunnerConfig = Readonly<{
  connectionId: string;
  mode: "dev" | "livekit";
  bindHost: string;
  sipPort: number;
  username: string;
  password: string;
  sipServer: string | null;
  transport: "udp" | "tcp" | "tls";
  rtpPortLow: number;
  rtpPortHigh: number;
  dashScopeApiKey: string;
  sttProvider: "dashscope";
  ttsProvider: "dashscope";
  voice: string;
  language: string;
  greeting: string;
  callTimeoutMilliseconds: number;
  liveKit: Readonly<{
    url: string;
    apiKey: string;
    apiSecret: string;
    sipTrunkId: string;
    roomName: string;
    sampleRate: 24_000;
  }> | null;
  maxCalls: number;
}>;

export function resolveSipRunnerConfig(
  value: unknown,
): SipRunnerConfig {
  const parsed = sipRunnerConfigSchema.parse(value);
  if (parsed.rtp_port_low > parsed.rtp_port_high) {
    throw new Error("sip_rtp_port_range_invalid");
  }
  const evenPorts =
    Math.floor(parsed.rtp_port_high / 2)
    - Math.ceil(parsed.rtp_port_low / 2)
    + 1;
  if (
    parsed.sip_mode === "dev"
    && evenPorts < parsed.max_concurrent_calls
  ) {
    throw new Error("sip_rtp_port_range_too_small");
  }
  const sipServer = parsed.sip_server.trim() || null;
  if (
    parsed.sip_mode === "dev"
    && !sipServer
    && !isLoopback(parsed.sip_host)
  ) {
    throw new Error(
      "sip_embedded_registrar_loopback_required",
    );
  }
  if (
    parsed.sip_mode === "dev"
    && parsed.sip_transport !== "UDP"
  ) {
    throw new Error("sip_dev_udp_transport_required");
  }
  let liveKit: SipRunnerConfig["liveKit"] = null;
  if (parsed.sip_mode === "livekit") {
    if (
      !/^wss:\/\//u.test(parsed.livekit_url)
      || !parsed.livekit_api_key
      || !parsed.livekit_api_secret
      || !parsed.livekit_sip_trunk_id
    ) {
      throw new Error("sip_livekit_config_required");
    }
    liveKit = {
      url: parsed.livekit_url,
      apiKey: parsed.livekit_api_key,
      apiSecret: parsed.livekit_api_secret,
      sipTrunkId: parsed.livekit_sip_trunk_id,
      roomName: parsed.livekit_room_name,
      sampleRate: parsed.livekit_output_sample_rate,
    };
  }
  return {
    connectionId: parsed.connection_id,
    mode: parsed.sip_mode,
    bindHost: parsed.sip_host,
    sipPort: parsed.sip_port,
    username: parsed.sip_username,
    password: parsed.sip_password,
    sipServer,
    transport: parsed.sip_transport.toLowerCase() as
      "udp" | "tcp" | "tls",
    rtpPortLow: parsed.rtp_port_low,
    rtpPortHigh: parsed.rtp_port_high,
    dashScopeApiKey: parsed.dashscope_api_key,
    sttProvider: "dashscope",
    ttsProvider: "dashscope",
    voice: parsed.tts_voice || "longxiaochun_v2",
    language: parsed.language,
    greeting: parsed.welcome_greeting,
    callTimeoutMilliseconds: parsed.call_timeout * 1_000,
    liveKit,
    maxCalls: parsed.max_concurrent_calls,
  };
}

export async function loadSipRunnerConfigs(
  input: Readonly<{
    nodeConfigPath: string;
    connectionIds: readonly string[];
  }>,
): Promise<SipRunnerConfig[]> {
  if (!path.isAbsolute(input.nodeConfigPath)) {
    throw new Error("channel_node_config_path_required");
  }
  const nodeDirectory = path.dirname(input.nodeConfigPath);
  const configs: SipRunnerConfig[] = [];
  for (const connectionId of input.connectionIds) {
    if (!z.string().uuid().safeParse(connectionId).success) {
      throw new Error("sip_connection_id_invalid");
    }
    const configPath = path.join(
      nodeDirectory,
      "channels",
      "sip",
      `${connectionId}.json`,
    );
    const value = await readOptionalPrivateConfig(configPath);
    if (value === null) continue;
    const config = resolveSipRunnerConfig(value);
    if (config.connectionId !== connectionId) {
      throw new Error("sip_config_connection_mismatch");
    }
    configs.push(config);
  }
  return configs;
}

async function readOptionalPrivateConfig(
  filePath: string,
): Promise<unknown | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      filePath,
      constants.O_RDONLY
        | constants.O_NOFOLLOW
        | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile()
      || (metadata.mode & 0o777) !== 0o600
    ) {
      throw new Error(
        "sip_config_private_file_mode_invalid",
      );
    }
    if (metadata.size > 64 * 1024) {
      throw new Error("sip_config_file_too_large");
    }
    try {
      return JSON.parse(
        (await handle.readFile()).toString("utf8"),
      );
    } catch {
      throw new Error("sip_config_invalid");
    }
  } finally {
    await handle.close();
  }
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1"
    || host === "::1"
    || host === "localhost";
}
