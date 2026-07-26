import path from "node:path";
import { z } from "zod";
import { createChannelSecretsKey } from "@/server/security/encrypted-secret";

const LOCAL_APP_SECRET = "digitalmate-local-secret-change-me";
const PUBLIC_APP_SECRET_PLACEHOLDERS = new Set([
  "digitalmate-local-secret",
  LOCAL_APP_SECRET,
  "change-me-use-at-least-32-random-bytes",
]);

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z.string().default("postgres://digitalmate:digitalmate@localhost:5432/digitalmate"),
  APP_PASSWORD: z.string().optional(),
  APP_SECRET: z
    .string()
    .min(16)
    .default(LOCAL_APP_SECRET),
  CHANNEL_SECRETS_KEY: z.string().optional(),
  TRUST_PROXY_HEADERS: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  KIE_AI_API_KEY: z.string().optional(),
  KIE_AI_BASE_URL: z.string().default("https://api.kie.ai"),
  GEMINI_3_5_FLASH_ENDPOINT: z.string().default("/gemini-3-5-flash-openai/v1/chat/completions"),
  CLAUDE_MESSAGES_ENDPOINT: z.string().default("/claude/v1/messages"),
  ANTHROPIC_API_VERSION: z.string().default("2023-06-01"),
  LLM_MODEL_MAIN: z.string().default("claude-opus-4-8"),
  LLM_MODEL_LIGHT: z.string().default("gemini-3-5-flash-openai"),
  EMBEDDING_BASE_URL: z.string().optional(),
  EMBEDDING_API_KEY: z.string().optional(),
  EMBEDDING_MODEL: z.string().optional(),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1536),
  SEARCH_PROVIDER: z.string().default("duckduckgo"),
  GITHUB_TOKEN: z.string().optional(),
  ALIYUN_IQS_API_KEY: z.string().optional(),
  ALIYUN_IQS_BASE_URL: z.string().default("https://cloud-iqs.aliyuncs.com"),
  PROACTIVE_QUIET_START: z.string().default("23:00"),
  PROACTIVE_QUIET_END: z.string().default("08:00"),
  PROACTIVE_MAX_PER_DAY: z.coerce.number().int().positive().default(3),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),
  FEISHU_APP_ID: z.string().optional(),
  FEISHU_APP_SECRET: z.string().optional(),
  FEISHU_VERIFICATION_TOKEN: z.string().optional(),
  DINGTALK_ROBOT_CODE: z.string().optional(),
  CHANNEL_IMPORT_LEGACY_ENABLED: z
    .enum(["0", "1"])
    .default("0")
    .transform((value) => value === "1"),
  CHANNEL_GATEWAY_PORT: z.coerce
    .number()
    .int()
    .min(0)
    .max(65_535)
    .default(3_101),
  CHANNEL_NODE_PORT: z.coerce
    .number()
    .int()
    .min(0)
    .max(65_535)
    .default(9_443),
  CHANNEL_NODE_TLS_CERT_PATH: z.string().optional(),
  CHANNEL_NODE_TLS_KEY_PATH: z.string().optional(),
  CHANNEL_NODE_CA_PATH: z.string().optional(),
  CHANNEL_NODE_SERVER_CA_PATH: z.string().optional(),
  CHANNEL_NODE_ENROLLMENT_CA_PATH: z.string().optional(),
  CHANNEL_NODE_ENROLLMENT_CA_KEY_PATH: z.string().optional(),
  PUBLIC_BASE_URL: z.string().optional(),
  ATTACHMENT_STORAGE_DIR: z.string().optional(),
});

export type AppEnv = ReturnType<typeof readEnv>;

export function readEnv(source: Record<string, string | undefined> = process.env) {
  const parsed = envSchema.parse(source);
  assertProductionAppSecret(parsed.NODE_ENV, source.APP_SECRET, parsed.APP_SECRET);
  assertProductionListenerPorts(
    parsed.NODE_ENV,
    parsed.CHANNEL_GATEWAY_PORT,
    parsed.CHANNEL_NODE_PORT,
  );
  const attachmentStorageDir = parsed.ATTACHMENT_STORAGE_DIR?.trim();
  const publicBaseUrl = parsePublicBaseUrl(
    parsed.PUBLIC_BASE_URL,
    parsed.NODE_ENV,
  );
  const channelNodeTls = parseChannelNodeTls(parsed);
  const channelNodeEnrollmentCa =
    parseChannelNodeEnrollmentCa(parsed);
  const channelNodeServerCaPath =
    parseOptionalPath(parsed.CHANNEL_NODE_SERVER_CA_PATH);
  if (
    channelNodeEnrollmentCa.status === "ready"
    && !channelNodeServerCaPath
  ) {
    throw new Error(
      "启用渠道节点 enrollment 时必须配置独立的网关服务端 CA。",
    );
  }
  if (
    channelNodeEnrollmentCa.status === "ready"
    && channelNodeServerCaPath
      === channelNodeEnrollmentCa.certificateAuthorityPath
  ) {
    throw new Error(
      "网关服务端 CA 不能与节点 enrollment CA 复用。",
    );
  }

  return {
    databaseUrl: parsed.DATABASE_URL,
    appPassword: parsed.APP_PASSWORD,
    appSecret: parsed.APP_SECRET,
    channelSecretsKey: createChannelSecretsKey(
      parsed.CHANNEL_SECRETS_KEY,
    ),
    trustProxyHeaders: parsed.TRUST_PROXY_HEADERS,
    kieAiApiKey: parsed.KIE_AI_API_KEY,
    kieAiBaseUrl: parsed.KIE_AI_BASE_URL,
    geminiEndpoint: parsed.GEMINI_3_5_FLASH_ENDPOINT,
    claudeEndpoint: parsed.CLAUDE_MESSAGES_ENDPOINT,
    anthropicVersion: parsed.ANTHROPIC_API_VERSION,
    llmModelMain: parsed.LLM_MODEL_MAIN,
    llmModelLight: parsed.LLM_MODEL_LIGHT,
    embeddingBaseUrl: parsed.EMBEDDING_BASE_URL,
    embeddingApiKey: parsed.EMBEDDING_API_KEY,
    embeddingModel: parsed.EMBEDDING_MODEL,
    embeddingDimensions: parsed.EMBEDDING_DIMENSIONS,
    searchProvider: parsed.SEARCH_PROVIDER,
    githubToken: parsed.GITHUB_TOKEN,
    aliyunIqsApiKey: parsed.ALIYUN_IQS_API_KEY,
    aliyunIqsBaseUrl: parsed.ALIYUN_IQS_BASE_URL,
    proactiveQuietStart: parsed.PROACTIVE_QUIET_START,
    proactiveQuietEnd: parsed.PROACTIVE_QUIET_END,
    proactiveMaxPerDay: parsed.PROACTIVE_MAX_PER_DAY,
    telegramBotToken: parsed.TELEGRAM_BOT_TOKEN,
    telegramWebhookSecret: parsed.TELEGRAM_WEBHOOK_SECRET,
    slackBotToken: parsed.SLACK_BOT_TOKEN,
    slackSigningSecret: parsed.SLACK_SIGNING_SECRET,
    feishuAppId: parsed.FEISHU_APP_ID,
    feishuAppSecret: parsed.FEISHU_APP_SECRET,
    feishuVerificationToken: parsed.FEISHU_VERIFICATION_TOKEN,
    dingTalkRobotCode: parsed.DINGTALK_ROBOT_CODE,
    channelImportLegacyEnabled:
      parsed.CHANNEL_IMPORT_LEGACY_ENABLED,
    channelGatewayPort: parsed.CHANNEL_GATEWAY_PORT,
    channelNodePort: parsed.CHANNEL_NODE_PORT,
    channelNodeTls,
    channelNodeEnrollmentCa,
    channelNodeServerCaPath,
    publicBaseUrl,
    attachmentStorageDir:
      attachmentStorageDir || path.join(process.cwd(), "data", "attachments"),
  };
}

function parseOptionalPath(
  value: string | undefined,
): string | null {
  const trimmed = value?.trim();
  return trimmed ? path.resolve(trimmed) : null;
}

function parseChannelNodeTls(parsed: Readonly<{
  CHANNEL_NODE_TLS_CERT_PATH?: string;
  CHANNEL_NODE_TLS_KEY_PATH?: string;
  CHANNEL_NODE_CA_PATH?: string;
}>):
  | Readonly<{ status: "disabled" }>
  | Readonly<{
      status: "ready";
      certificatePath: string;
      privateKeyPath: string;
      certificateAuthorityPath: string;
    }> {
  const values = [
    parsed.CHANNEL_NODE_TLS_CERT_PATH?.trim(),
    parsed.CHANNEL_NODE_TLS_KEY_PATH?.trim(),
    parsed.CHANNEL_NODE_CA_PATH?.trim(),
  ];
  if (values.every((value) => !value)) {
    return { status: "disabled" };
  }
  if (values.some((value) => !value)) {
    throw new Error("渠道节点 mTLS 必须同时配置服务端证书、私钥和客户端 CA。");
  }
  return {
    status: "ready",
    certificatePath: path.resolve(values[0]!),
    privateKeyPath: path.resolve(values[1]!),
    certificateAuthorityPath: path.resolve(values[2]!),
  };
}

function parseChannelNodeEnrollmentCa(parsed: Readonly<{
  CHANNEL_NODE_ENROLLMENT_CA_PATH?: string;
  CHANNEL_NODE_ENROLLMENT_CA_KEY_PATH?: string;
}>):
  | Readonly<{ status: "disabled" }>
  | Readonly<{
      status: "ready";
      certificateAuthorityPath: string;
      certificateAuthorityPrivateKeyPath: string;
    }> {
  const certificate =
    parsed.CHANNEL_NODE_ENROLLMENT_CA_PATH?.trim();
  const privateKey =
    parsed.CHANNEL_NODE_ENROLLMENT_CA_KEY_PATH?.trim();
  if (!certificate && !privateKey) {
    return { status: "disabled" };
  }
  if (!certificate || !privateKey) {
    throw new Error(
      "渠道节点 enrollment CA 必须同时配置证书与私钥。",
    );
  }
  return {
    status: "ready",
    certificateAuthorityPath: path.resolve(certificate),
    certificateAuthorityPrivateKeyPath:
      path.resolve(privateKey),
  };
}

function parsePublicBaseUrl(
  value: string | undefined,
  nodeEnv: "development" | "test" | "production",
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    if (nodeEnv === "production") {
      throw new Error(
        "生产环境必须配置使用 HTTPS 的 PUBLIC_BASE_URL。",
      );
    }
    return null;
  }
  const url = new URL(trimmed);
  if (
    url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== "/"
  ) {
    throw new Error(
      "PUBLIC_BASE_URL 必须是无用户名、密码、查询、片段和路径的 HTTP(S) 根地址。",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("PUBLIC_BASE_URL 必须使用 HTTP(S)。");
  }
  if (
    nodeEnv === "production"
    && url.protocol !== "https:"
  ) {
    throw new Error(
      "生产环境 PUBLIC_BASE_URL 必须使用 HTTPS。",
    );
  }
  return url.origin;
}

function assertProductionListenerPorts(
  nodeEnv: "development" | "test" | "production",
  gatewayPort: number,
  nodePort: number,
): void {
  if (nodeEnv !== "production") return;
  if (gatewayPort === 0) {
    throw new Error(
      "生产环境 CHANNEL_GATEWAY_PORT 不能为 0。",
    );
  }
  if (nodePort === 0) {
    throw new Error(
      "生产环境 CHANNEL_NODE_PORT 不能为 0。",
    );
  }
}

function assertProductionAppSecret(
  nodeEnv: "development" | "test" | "production",
  configuredSecret: string | undefined,
  parsedSecret: string,
): void {
  if (nodeEnv !== "production") return;

  const secret = configuredSecret?.trim();
  const isPublicPlaceholder =
    !secret ||
    PUBLIC_APP_SECRET_PLACEHOLDERS.has(secret) ||
    /(?:change[-_ ]?me|replace[-_ ]?me|placeholder)/i.test(secret);
  if (
    isPublicPlaceholder ||
    Buffer.byteLength(parsedSecret, "utf8") < 32
  ) {
    throw new Error(
      "生产环境 APP_SECRET 必须显式设置为至少 32 字节的独立高熵随机值，不能使用公开默认值或占位符；APP_PASSWORD 不能替代该密钥。",
    );
  }
}
