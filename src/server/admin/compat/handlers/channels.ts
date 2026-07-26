import { z } from "zod";

import type { AgentScope } from "@/server/agents/types";
import { readAdminCompatJson } from "@/server/admin/compat/json";
import type { AdminCompatHandler } from "@/server/admin/compat/types";
import { AdminCompatError } from "@/server/admin/compat/types";
import {
  CHANNEL_MANIFESTS,
  CHANNEL_TYPES,
  getChannelManifest,
  isChannelType,
  type ChannelType,
} from "@/server/channels/manifests/catalog";
import type {
  WechatQrAuthService,
} from "@/server/admin/wechat-qrcode";

const operationIdSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);
const envelopeSchema = z
  .object({
    operation_id: operationIdSchema,
    revision: z.number().int().min(0),
    clear_secret: z.array(z.string()).max(64).optional().default([]),
  })
  .passthrough();
const DANGEROUS_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export type AdminChannelSecretStatus = Readonly<{
  configured: boolean;
  lastRotatedAt: string | null;
}>;

export type AdminChannelHealth = Readonly<{
  status:
    | "blocked"
    | "disabled"
    | "starting"
    | "connected"
      | "degraded"
      | "disconnected";
  reason?: string;
  detail: Readonly<Record<string, unknown>>;
  lastConnectedAt?: string;
  lastDisconnectedAt?: string;
  lastEventAt?: string;
}>;

export type AdminChannelConfigSnapshot = Readonly<{
  type: ChannelType;
  enabled: boolean;
  revision: number;
  config: Readonly<Record<string, unknown>>;
  secrets: Readonly<Record<string, AdminChannelSecretStatus>>;
  health: AdminChannelHealth;
}>;

export type AdminChannelConfigCollection = Readonly<
  Record<ChannelType, AdminChannelConfigSnapshot>
>;

export type AdminChannelSecretChange =
  | Readonly<{
      fieldName: string;
      operation: "set";
      value: string;
    }>
  | Readonly<{
      fieldName: string;
      operation: "delete";
    }>;

export type AdminChannelConfigWrite = Readonly<{
  scope: AgentScope;
  type: ChannelType;
  operationId: string;
  expectedRevision: number;
  enabled: boolean;
  config: Readonly<Record<string, unknown>>;
  secretChanges: readonly AdminChannelSecretChange[];
  confirmationSource?: "console" | "legacy_env_import";
}>;

export type AdminChannelConfigReader = (
  scope: AgentScope,
  signal?: AbortSignal,
) => Promise<AdminChannelConfigCollection>;

export type AdminChannelConfigWriter = (
  input: AdminChannelConfigWrite,
  signal?: AbortSignal,
) => Promise<AdminChannelConfigSnapshot>;

export type AdminChannelConfigBatchWriter = (
  inputs: readonly AdminChannelConfigWrite[],
  signal?: AbortSignal,
) => Promise<AdminChannelConfigCollection>;

export type AdminChannelHealthResolver = (
  scope: AgentScope,
  type: ChannelType,
  snapshot: AdminChannelConfigSnapshot,
  signal?: AbortSignal,
) => Promise<AdminChannelHealth>;

export const listChannelTypes: AdminCompatHandler = async () =>
  CHANNEL_TYPES;

export const listChannelSchemas: AdminCompatHandler = async () =>
  Object.fromEntries(
    CHANNEL_TYPES.map((type) => {
      const manifest = CHANNEL_MANIFESTS[type];
      return [
        type,
        {
          label: manifest.label,
          description: manifest.description,
          plugin_id: null,
          icon: type,
          runtime: manifest.runtime,
          capabilities: manifest.capabilities,
          prerequisites: manifest.prerequisites,
          conditions: manifest.conditions,
          config_fields: manifest.fields.map((configField) => ({
            name: configField.name,
            label: configField.label,
            type: toUpstreamFieldType(configField.kind),
            required: configField.required ?? false,
            readonly: configField.readonly ?? false,
            default: configField.default,
            ...(configField.options
              ? {
                  options: configField.options.map((option) => option.value),
                }
              : {}),
          })),
        },
      ];
    }),
  );

export function createListChannelsHandler(
  readChannels: AdminChannelConfigReader,
  resolveHealth?: AdminChannelHealthResolver,
): AdminCompatHandler {
  return async (context) => {
    const channels = await readChannels(context.scope, context.signal);
    const resolved = await Promise.all(
      CHANNEL_TYPES.map(async (type) => [
        type,
        await withResolvedHealth(
          context.scope,
          channels[type],
          resolveHealth,
          context.signal,
        ),
      ] as const),
    );
    return Object.fromEntries(
      resolved.map(([type, snapshot]) => [
        type,
        toChannelResponse(snapshot),
      ]),
    );
  };
}

export function createGetChannelHandler(
  readChannels: AdminChannelConfigReader,
  resolveHealth?: AdminChannelHealthResolver,
): AdminCompatHandler {
  return async (context) => {
    const type = parseChannelType(context.params.channelType);
    const channels = await readChannels(context.scope, context.signal);
    return toChannelResponse(
      await withResolvedHealth(
        context.scope,
        channels[type],
        resolveHealth,
        context.signal,
      ),
    );
  };
}

export function createUpdateChannelHandler(
  updateChannel: AdminChannelConfigWriter,
  resolveHealth?: AdminChannelHealthResolver,
): AdminCompatHandler {
  return async (context) => {
    const type = parseChannelType(context.params.channelType);
    const raw = await readAdminCompatJson(context.request);
    const input = parseChannelWrite(context.scope, type, raw);
    const updated = await updateChannel(
      input,
      context.signal,
    );
    return toChannelResponse(
      await withResolvedHealth(
        context.scope,
        updated,
        resolveHealth,
        context.signal,
      ),
    );
  };
}

export function createUpdateChannelsHandler(
  updateChannels: AdminChannelConfigBatchWriter,
  resolveHealth?: AdminChannelHealthResolver,
): AdminCompatHandler {
  return async (context) => {
    const raw = await readAdminCompatJson(context.request);
    assertSafeObject(raw);
    const keys = Object.keys(raw);
    if (
      keys.length !== CHANNEL_TYPES.length ||
      CHANNEL_TYPES.some((type) => !Object.hasOwn(raw, type))
    ) {
      throw new AdminCompatError(
        400,
        "invalid_request",
        "invalid_channel_batch",
      );
    }
    const writes = CHANNEL_TYPES.map((type) =>
      parseChannelWrite(context.scope, type, raw[type])
    );
    const updated = await updateChannels(writes, context.signal);
    const resolved = await Promise.all(
      CHANNEL_TYPES.map(async (type) => [
        type,
        await withResolvedHealth(
          context.scope,
          updated[type],
          resolveHealth,
          context.signal,
        ),
      ] as const),
    );
    return Object.fromEntries(
      resolved.map(([type, snapshot]) => [
        type,
        toChannelResponse(snapshot),
      ]),
    );
  };
}

export function createGetChannelHealthHandler(
  readChannels: AdminChannelConfigReader,
  resolveHealth?: AdminChannelHealthResolver,
): AdminCompatHandler {
  return async (context) => {
    const type = parseChannelType(context.params.channelType);
    const channels = await readChannels(context.scope, context.signal);
    return (
      await withResolvedHealth(
        context.scope,
        channels[type],
        resolveHealth,
        context.signal,
      )
    ).health;
  };
}

export function createWechatQrCodeHandler(
  service: WechatQrAuthService,
): AdminCompatHandler {
  return async (context) => {
    try {
      return await service.create(
        context.scope,
        context.signal,
      );
    } catch (error) {
      throw mapWechatQrError(error);
    }
  };
}

export function createWechatQrCodeStatusHandler(
  service: WechatQrAuthService,
): AdminCompatHandler {
  return async (context) => {
    const pollToken = new URL(
      context.request.url,
    ).searchParams.get("token") ?? "";
    try {
      return await service.poll(
        context.scope,
        pollToken,
        context.signal,
      );
    } catch (error) {
      throw mapWechatQrError(error);
    }
  };
}

function mapWechatQrError(error: unknown): unknown {
  if (
    error
    && typeof error === "object"
    && "code" in error
    && (
      error.code === "permission_denied"
      || error.code === "credential_invalid"
    )
  ) {
    return new AdminCompatError(
      409,
      "channel_blocked",
      "wechat_ilink_eligibility_required",
    );
  }
  return error;
}

function parseChannelWrite(
  scope: AgentScope,
  type: ChannelType,
  raw: unknown,
): AdminChannelConfigWrite {
  assertSafeObject(raw);
  const envelope = envelopeSchema.parse(raw);
  const manifest = getChannelManifest(type);
  const secretFields = new Set(manifest.secretFields);
  const clearFields = new Set(envelope.clear_secret);
  if (
    clearFields.size !== envelope.clear_secret.length ||
    envelope.clear_secret.some((name) => !secretFields.has(name))
  ) {
    const invalidField =
      envelope.clear_secret.find(
        (name, index) =>
          envelope.clear_secret.indexOf(name) !== index ||
          !secretFields.has(name),
      ) ?? "unknown";
    throw invalidSecretChange(
      secretFields.has(invalidField)
        ? ["clear_secret", invalidField]
        : ["clear_secret"],
      "invalid_value",
    );
  }

  const configInput = { ...raw };
  delete configInput.operation_id;
  delete configInput.revision;
  delete configInput.clear_secret;
  const secretChanges: AdminChannelSecretChange[] = [];
  for (const fieldName of manifest.secretFields) {
    const candidate = configInput[fieldName];
    delete configInput[fieldName];
    if (candidate === undefined || candidate === "") {
      continue;
    }
    if (typeof candidate !== "string") {
      throw invalidSecretChange([fieldName], "invalid_type");
    }
    if (clearFields.has(fieldName)) {
      throw invalidSecretChange(
        ["clear_secret", fieldName],
        "invalid_value",
      );
    }
    secretChanges.push({
      fieldName,
      operation: "set",
      value: candidate,
    });
  }
  for (const fieldName of clearFields) {
    if (Object.hasOwn(raw, fieldName)) {
      throw invalidSecretChange(
        ["clear_secret", fieldName],
        "invalid_value",
      );
    }
    secretChanges.push({ fieldName, operation: "delete" });
  }

  const parsed = manifest.configSchema.parse(configInput);
  const enabled = parsed.enabled === true;
  const publicConfig = { ...parsed };
  delete publicConfig.enabled;
  for (const fieldName of manifest.secretFields) {
    delete publicConfig[fieldName];
  }
  return {
    scope,
    type,
    operationId: envelope.operation_id,
    expectedRevision: envelope.revision,
    enabled,
    config: publicConfig,
    secretChanges,
  };
}

function parseChannelType(value: string | undefined): ChannelType {
  if (value === undefined || !isChannelType(value)) {
    throw new AdminCompatError(404, "not_found", "channel_not_found");
  }
  return value;
}

function toChannelResponse(
  snapshot: AdminChannelConfigSnapshot,
): Readonly<Record<string, unknown>> {
  const manifest = getChannelManifest(snapshot.type);
  return {
    enabled: snapshot.enabled,
    ...snapshot.config,
    ...Object.fromEntries(
      manifest.secretFields.map((fieldName) => [
        fieldName,
        snapshot.secrets[fieldName] ?? {
          configured: false,
          lastRotatedAt: null,
        },
      ]),
    ),
    revision: snapshot.revision,
    isBuiltin: true,
    health: snapshot.health,
  };
}

async function withResolvedHealth(
  scope: AgentScope,
  snapshot: AdminChannelConfigSnapshot,
  resolveHealth: AdminChannelHealthResolver | undefined,
  signal?: AbortSignal,
): Promise<AdminChannelConfigSnapshot> {
  if (!resolveHealth) return snapshot;
  signal?.throwIfAborted();
  const health = await resolveHealth(
    scope,
    snapshot.type,
    snapshot,
    signal,
  );
  signal?.throwIfAborted();
  return { ...snapshot, health };
}

function assertSafeObject(value: unknown): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new AdminCompatError(
      400,
      "invalid_request",
      "validation_failed",
    );
  }
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (
      typeof candidate !== "object" ||
      candidate === null
    ) {
      continue;
    }
    for (const [key, nested] of Object.entries(candidate)) {
      if (DANGEROUS_KEYS.has(key)) {
        throw new AdminCompatError(
          400,
          "invalid_request",
          "validation_failed",
        );
      }
      if (typeof nested === "object" && nested !== null) {
        pending.push(nested);
      }
    }
  }
}

function invalidSecretChange(
  path: readonly string[],
  code: "invalid_type" | "invalid_value",
): AdminCompatError {
  return new AdminCompatError(
    400,
    "invalid_request",
    "invalid_secret_change",
    {
      issues: [{ code, path }],
    },
  );
}

function toUpstreamFieldType(
  kind: (typeof CHANNEL_MANIFESTS)[ChannelType]["fields"][number]["kind"],
): "number" | "password" | "select" | "switch" | "text" {
  if (kind === "secret") return "password";
  if (kind === "number") return "number";
  if (kind === "boolean") return "switch";
  if (kind === "select") return "select";
  return "text";
}
