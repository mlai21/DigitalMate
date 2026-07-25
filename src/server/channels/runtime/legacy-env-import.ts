import { createHash } from "node:crypto";

import type { Pool } from "pg";

import {
  createAdminChannelConfigService,
} from "@/server/admin/channel-config";
import type { AgentScope } from "@/server/agents/types";
import type {
  AdminChannelConfigSnapshot,
  AdminChannelConfigWrite,
} from "@/server/admin/compat/handlers/channels";
import type {
  ChannelType,
} from "@/server/channels/manifests/catalog";
import type {
  ChannelSecretsKey,
} from "@/server/security/encrypted-secret";

const LEGACY_CHANNEL_TYPES = [
  "telegram",
  "slack",
  "feishu",
  "dingtalk",
] as const;
type LegacyChannelType = (typeof LEGACY_CHANNEL_TYPES)[number];

type LegacyEnvironment = Readonly<{
  channelImportLegacyEnabled?: boolean;
  telegramBotToken?: string;
  telegramWebhookSecret?: string;
  slackBotToken?: string;
  slackSigningSecret?: string;
  feishuAppId?: string;
  feishuAppSecret?: string;
  feishuVerificationToken?: string;
  dingTalkRobotCode?: string;
}>;

type LegacyImportService = Readonly<{
  read(
    scope: AgentScope,
  ): Promise<Partial<Record<
    ChannelType,
    Pick<AdminChannelConfigSnapshot, "revision">
  >>>;
  update(
    input: AdminChannelConfigWrite,
  ): Promise<unknown>;
}>;

export async function importLegacyChannelEnvironment(
  input: Readonly<{
    scope: AgentScope;
    env: LegacyEnvironment;
    pool?: Pool;
    secretKey?: ChannelSecretsKey;
    service?: LegacyImportService;
  }>,
): Promise<Readonly<{
  imported: Array<Readonly<{
    type: LegacyChannelType;
    enabled: boolean;
    fieldsPresent: Readonly<Record<string, true>>;
  }>>;
  skippedExisting: LegacyChannelType[];
}>> {
  const service = resolveService(input);
  const current = await service.read(input.scope);
  const imported: Array<{
    type: LegacyChannelType;
    enabled: boolean;
    fieldsPresent: Record<string, true>;
  }> = [];
  const skippedExisting: LegacyChannelType[] = [];

  for (const type of LEGACY_CHANNEL_TYPES) {
    const prepared = legacyWrite(
      input.scope,
      type,
      input.env,
    );
    if (!prepared) continue;
    if ((current[type]?.revision ?? 0) > 0) {
      skippedExisting.push(type);
      continue;
    }
    await service.update(prepared.write);
    imported.push({
      type,
      enabled: prepared.write.enabled,
      fieldsPresent: prepared.fieldsPresent,
    });
  }

  return { imported, skippedExisting };
}

function resolveService(
  input: Readonly<{
    pool?: Pool;
    secretKey?: ChannelSecretsKey;
    service?: LegacyImportService;
  }>,
): LegacyImportService {
  if (input.service) return input.service;
  if (!input.pool || !input.secretKey) {
    throw new Error("legacy_channel_import_storage_unavailable");
  }
  return createAdminChannelConfigService(
    input.pool,
    input.secretKey,
  );
}

function legacyWrite(
  scope: AgentScope,
  type: LegacyChannelType,
  env: LegacyEnvironment,
): {
  write: AdminChannelConfigWrite;
  fieldsPresent: Record<string, true>;
} | null {
  const fields = legacyFields(type, env);
  const publicConfig = Object.fromEntries(
    fields
      .filter((field) => field.kind === "public")
      .map((field) => [field.name, field.value]),
  );
  const secretChanges = fields
    .filter((field) => field.kind === "secret")
    .map((field) => ({
      fieldName: field.name,
      operation: "set" as const,
      value: field.value,
    }));
  if (
    Object.keys(publicConfig).length === 0
    && secretChanges.length === 0
  ) {
    return null;
  }
  return {
    write: {
      scope,
      type,
      operationId: importOperationId(scope, type),
      expectedRevision: 0,
      enabled: env.channelImportLegacyEnabled === true,
      config: publicConfig,
      secretChanges,
      confirmationSource: "legacy_env_import",
    },
    fieldsPresent: Object.fromEntries(
      fields.map((field) => [field.name, true as const]),
    ),
  };
}

type LegacyField = Readonly<{
  kind: "public" | "secret";
  name: string;
  value: string;
}>;

function legacyFields(
  type: LegacyChannelType,
  env: LegacyEnvironment,
): LegacyField[] {
  const definitions: Record<
    LegacyChannelType,
    Array<readonly [
      LegacyField["kind"],
      string,
      string | undefined,
    ]>
  > = {
    telegram: [
      ["secret", "bot_token", env.telegramBotToken],
      [
        "secret",
        "webhook_secret",
        env.telegramWebhookSecret,
      ],
    ],
    slack: [
      ["secret", "bot_token", env.slackBotToken],
      ["secret", "signing_secret", env.slackSigningSecret],
    ],
    feishu: [
      ["public", "app_id", env.feishuAppId],
      ["secret", "app_secret", env.feishuAppSecret],
      [
        "secret",
        "verification_token",
        env.feishuVerificationToken,
      ],
    ],
    dingtalk: [
      ["public", "robot_code", env.dingTalkRobotCode],
    ],
  };
  return definitions[type].flatMap(([kind, name, value]) => {
    const normalized = value?.trim();
    return normalized
      ? [{ kind, name, value: normalized }]
      : [];
  });
}

function importOperationId(
  scope: AgentScope,
  type: LegacyChannelType,
): string {
  const bytes = createHash("sha256")
    .update(
      `digitalmate:legacy-channel-import:${scope.userId}:${scope.agentId}:${type}`,
    )
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
