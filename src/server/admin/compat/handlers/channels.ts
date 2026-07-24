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
  status: "blocked" | "disabled";
  detail: Readonly<Record<string, unknown>>;
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
): AdminCompatHandler {
  return async (context) => {
    const channels = await readChannels(context.scope, context.signal);
    return Object.fromEntries(
      CHANNEL_TYPES.map((type) => [
        type,
        toChannelResponse(channels[type]),
      ]),
    );
  };
}

export function createGetChannelHandler(
  readChannels: AdminChannelConfigReader,
): AdminCompatHandler {
  return async (context) => {
    const type = parseChannelType(context.params.channelType);
    const channels = await readChannels(context.scope, context.signal);
    return toChannelResponse(channels[type]);
  };
}

export function createUpdateChannelHandler(
  updateChannel: AdminChannelConfigWriter,
): AdminCompatHandler {
  return async (context) => {
    const type = parseChannelType(context.params.channelType);
    const raw = await readAdminCompatJson(context.request);
    const input = parseChannelWrite(context.scope, type, raw);
    const updated = await updateChannel(
      input,
      context.signal,
    );
    return toChannelResponse(updated);
  };
}

export function createUpdateChannelsHandler(
  updateChannels: AdminChannelConfigBatchWriter,
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
    return Object.fromEntries(
      CHANNEL_TYPES.map((type) => [
        type,
        toChannelResponse(updated[type]),
      ]),
    );
  };
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
