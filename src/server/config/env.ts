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
  ATTACHMENT_STORAGE_DIR: z.string().optional(),
});

export type AppEnv = ReturnType<typeof readEnv>;

export function readEnv(source: Record<string, string | undefined> = process.env) {
  const parsed = envSchema.parse(source);
  assertProductionAppSecret(parsed.NODE_ENV, source.APP_SECRET, parsed.APP_SECRET);
  const attachmentStorageDir = parsed.ATTACHMENT_STORAGE_DIR?.trim();

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
    attachmentStorageDir:
      attachmentStorageDir || path.join(process.cwd(), "data", "attachments"),
  };
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
