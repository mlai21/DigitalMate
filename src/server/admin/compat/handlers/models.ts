import { createHash } from "node:crypto";

import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import type { AgentScope } from "@/server/agents/types";
import { readAdminCompatJson } from "@/server/admin/compat/json";
import {
  AdminCompatError,
  type AdminCompatHandler,
} from "@/server/admin/compat/types";
import {
  MODEL_CATALOG,
  type ModelCatalogEntry,
} from "@/server/llm/catalog";
import {
  defaultSettings,
  type ModelRoutingSettings,
} from "@/server/settings/defaults";

type ModelScope = "global" | "agent" | "effective";
type WritableModelScope = Exclude<ModelScope, "effective">;
type ModelPurpose = keyof ModelRoutingSettings;

export type AdminActiveModels = Readonly<{
  scope: ModelScope;
  routes: ModelRoutingSettings;
  revision: number;
  active_llm: Readonly<{
    provider_id: string;
    model: string;
  }>;
  effective_max_input_length: null;
}>;

export type AdminModelsService = Readonly<{
  listProviders(
    scope: AgentScope,
    signal?: AbortSignal,
  ): Promise<unknown[]>;
  getActiveModels(
    scope: AgentScope,
    input: Readonly<{
      scope: ModelScope;
      agentId?: string;
    }>,
    signal?: AbortSignal,
  ): Promise<AdminActiveModels>;
  updateActiveModel(
    scope: AgentScope,
    input: Readonly<{
      providerId: string;
      model: string;
      purpose: ModelPurpose;
      scope: WritableModelScope;
      agentId?: string;
      expectedRevision: number;
      operationId: string;
    }>,
    signal?: AbortSignal,
  ): Promise<AdminActiveModels>;
}>;

type ModelStateRow = Readonly<{
  user_model_routing: unknown;
  user_revision: number;
  model_routing_override: unknown;
  agent_revision: number;
}>;

export class AdminModelsError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "AdminModelsError";
    this.status = status;
    this.code = code;
  }
}

const canonicalUuidSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
);
const providerIdSchema = z.enum([
  "anthropic",
  "google",
  "openai",
]);
const modelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[\p{L}\p{N}._:/-]+$/u);
const updateActiveModelSchema = z
  .object({
    provider_id: providerIdSchema,
    model: modelIdSchema,
    purpose: z.enum(["main", "light"]).default("main"),
    scope: z.enum(["global", "agent"]),
    agent_id: canonicalUuidSchema.optional(),
    revision: z.number().int().positive(),
    operation_id: canonicalUuidSchema,
  })
  .strict();

export function projectModelProviders(
  catalog: readonly ModelCatalogEntry[],
  credentialsConfigured: boolean,
): unknown[] {
  const groups = new Map<
    string,
    {
      provider: ModelCatalogEntry["provider"];
      models: ModelCatalogEntry[];
    }
  >();
  for (const entry of catalog) {
    const id = providerId(entry.provider);
    const current = groups.get(id) ?? {
      provider: entry.provider,
      models: [],
    };
    current.models.push(entry);
    groups.set(id, current);
  }
  return [...groups.entries()].map(
    ([id, group]) => ({
      id,
      name: group.provider,
      chat_model:
        id === "anthropic"
          ? "AnthropicChatModel"
          : "OpenAIChatModel",
      models: group.models.map(projectCatalogModel),
      extra_models: [],
      is_custom: false,
      is_local: false,
      support_model_discovery: false,
      support_connection_check: false,
      freeze_url: true,
      require_api_key: true,
      generate_kwargs: {},
      auth_mode: "api_key",
      supports_oauth: false,
      oauth_connected: false,
      credential_status: credentialsConfigured
        ? "configured"
        : "missing",
      writable: false,
    }),
  );
}

export function createPostgresAdminModelsService(
  pool: Pool,
  options: Readonly<{
    credentialsConfigured?: boolean;
  }> = {},
): AdminModelsService {
  return {
    async listProviders(scope, signal) {
      signal?.throwIfAborted();
      await requireActiveAgent(pool, scope);
      signal?.throwIfAborted();
      return projectModelProviders(
        MODEL_CATALOG,
        options.credentialsConfigured === true,
      );
    },

    async getActiveModels(scope, input, signal) {
      signal?.throwIfAborted();
      validateSelectedAgent(scope, input.agentId);
      const row = await readModelState(pool, scope);
      signal?.throwIfAborted();
      return projectActiveModels(row, input.scope);
    },

    async updateActiveModel(scope, input, signal) {
      signal?.throwIfAborted();
      validateSelectedAgent(scope, input.agentId);
      assertModelProvider(input.providerId, input.model);
      const fingerprint = modelMutationFingerprint(input);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const row = await lockModelState(client, scope);
        if (!row) {
          throw new AdminModelsError(
            404,
            "agent_not_found",
          );
        }
        const current = projectActiveModels(
          row,
          input.scope,
        );
        const resourceId =
          input.scope === "global"
            ? scope.userId
            : scope.agentId;
        const replay = await readModelReplay(
          client,
          scope,
          resourceId,
          input.operationId,
        );
        if (replay) {
          if (
            replay.inputFingerprint !== fingerprint ||
            replay.revision !== input.expectedRevision + 1 ||
            current.revision !== replay.revision ||
            current.routes[input.purpose] !== input.model
          ) {
            throw new AdminModelsError(
              409,
              "revision_conflict",
            );
          }
          await client.query("COMMIT");
          return current;
        }
        if (current.revision !== input.expectedRevision) {
          throw new AdminModelsError(
            409,
            "revision_conflict",
          );
        }
        const routes: ModelRoutingSettings = {
          ...current.routes,
          [input.purpose]: input.model,
        };
        let revision: number;
        if (input.scope === "global") {
          const updated = await client.query<{
            revision: number;
          }>(
            `UPDATE settings
             SET model_routing = $2::jsonb,
                 revision = revision + 1,
                 updated_at = now()
             WHERE user_id = $1
               AND revision = $3
             RETURNING revision`,
            [
              scope.userId,
              JSON.stringify(routes),
              input.expectedRevision,
            ],
          );
          revision = Number(updated.rows[0]?.revision);
        } else {
          const userRoutes = asModelRouting(
            row.user_model_routing,
          );
          const override = asModelRoutingOverride(
            row.model_routing_override,
          );
          const nextOverride = {
            ...override,
            [input.purpose]: input.model,
          };
          const updated = await client.query<{
            revision: number;
          }>(
            `UPDATE agent_settings
             SET model_routing_override = $3::jsonb,
                 revision = revision + 1,
                 updated_at = now()
             WHERE user_id = $1
               AND agent_id = $2
               AND revision = $4
             RETURNING revision`,
            [
              scope.userId,
              scope.agentId,
              JSON.stringify(nextOverride),
              input.expectedRevision,
            ],
          );
          revision = Number(updated.rows[0]?.revision);
          routes.main =
            nextOverride.main ?? userRoutes.main;
          routes.light =
            nextOverride.light ?? userRoutes.light;
        }
        if (!Number.isSafeInteger(revision)) {
          throw new AdminModelsError(
            409,
            "revision_conflict",
          );
        }
        await client.query(
          `INSERT INTO admin_audit_logs (
             user_id, agent_id, action, resource_type,
             resource_id, before_summary, after_summary,
             confirmation_source, status, error_code
           )
           VALUES (
             $1, $2, 'model_route.update',
             'model_routing', $3,
             $4::jsonb, $5::jsonb, $6::jsonb,
             'success', NULL
           )`,
          [
            scope.userId,
            scope.agentId,
            resourceId,
            JSON.stringify({
              scope: input.scope,
              purpose: input.purpose,
              model: current.routes[input.purpose],
              revision: current.revision,
            }),
            JSON.stringify({
              scope: input.scope,
              purpose: input.purpose,
              provider_id: input.providerId,
              model: input.model,
              revision,
            }),
            JSON.stringify({
              type: "console",
              requestId: input.operationId,
              inputFingerprint: fingerprint,
            }),
          ],
        );
        signal?.throwIfAborted();
        await client.query("COMMIT");
        return activeModelsFromRoutes(
          routes,
          revision,
          input.scope,
        );
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export function createListModelsHandler(
  service: AdminModelsService,
): AdminCompatHandler {
  return async (context) =>
    service.listProviders(context.scope, context.signal);
}

export function createGetActiveModelsHandler(
  service: AdminModelsService,
): AdminCompatHandler {
  return async (context) => {
    try {
      const url = new URL(context.request.url);
      const selectedScope = z
        .enum(["global", "agent", "effective"])
        .default("effective")
        .parse(url.searchParams.get("scope") ?? undefined);
      const agentId =
        url.searchParams.get("agent_id") ?? undefined;
      if (
        agentId !== undefined &&
        !canonicalUuidSchema.safeParse(agentId).success
      ) {
        throw new AdminCompatError(
          400,
          "invalid_request",
          "invalid_agent_id",
        );
      }
      return await service.getActiveModels(
        context.scope,
        {
          scope: selectedScope,
          agentId,
        },
        context.signal,
      );
    } catch (error) {
      throw mapModelsError(error);
    }
  };
}

export function createUpdateActiveModelsHandler(
  service: AdminModelsService,
): AdminCompatHandler {
  return async (context) => {
    try {
      const body = updateActiveModelSchema.parse(
        await readAdminCompatJson(context.request),
      );
      validateSelectedAgent(context.scope, body.agent_id);
      assertModelProvider(body.provider_id, body.model);
      return await service.updateActiveModel(
        context.scope,
        {
          providerId: body.provider_id,
          model: body.model,
          purpose: body.purpose,
          scope: body.scope,
          agentId: body.agent_id,
          expectedRevision: body.revision,
          operationId: body.operation_id,
        },
        context.signal,
      );
    } catch (error) {
      throw mapModelsError(error);
    }
  };
}

function projectCatalogModel(entry: ModelCatalogEntry) {
  return {
    id: entry.id,
    name: entry.label,
    supports_multimodal: entry.supportsImageInput,
    supports_image: entry.supportsImageInput,
    supports_video: false,
    probe_source: "digitalmate_catalog",
    max_tokens: 0,
    max_input_length: 0,
    generate_kwargs: {},
    relay_reasoning: false,
    thinking_enabled: null,
    thinking_budget: null,
    reasoning_effort: null,
    recommended_for: [...entry.recommendedFor],
    description: entry.description,
  };
}

function providerId(
  provider: ModelCatalogEntry["provider"],
): string {
  return provider.toLocaleLowerCase();
}

function assertModelProvider(
  provider: string,
  model: string,
): void {
  const catalogEntry = MODEL_CATALOG.find(
    (entry) => entry.id === model,
  );
  if (
    catalogEntry &&
    providerId(catalogEntry.provider) !== provider
  ) {
    throw new AdminModelsError(
      400,
      "invalid_model_provider",
    );
  }
  if (!providerIdSchema.safeParse(provider).success) {
    throw new AdminModelsError(
      400,
      "invalid_model_provider",
    );
  }
  if (!modelIdSchema.safeParse(model).success) {
    throw new AdminModelsError(400, "invalid_model_id");
  }
}

function validateSelectedAgent(
  scope: AgentScope,
  agentId: string | undefined,
): void {
  if (agentId !== undefined && agentId !== scope.agentId) {
    throw new AdminModelsError(
      409,
      "agent_scope_mismatch",
    );
  }
}

async function requireActiveAgent(
  pool: Pool,
  scope: AgentScope,
): Promise<void> {
  const result = await pool.query(
    `SELECT 1
     FROM digital_agents
     WHERE user_id = $1 AND id = $2
       AND status = 'active'`,
    [scope.userId, scope.agentId],
  );
  if (!result.rows[0]) {
    throw new AdminModelsError(404, "agent_not_found");
  }
}

async function readModelState(
  pool: Pool,
  scope: AgentScope,
): Promise<ModelStateRow> {
  const result = await pool.query<ModelStateRow>(
    modelStateQuery(false),
    [scope.userId, scope.agentId],
  );
  if (!result.rows[0]) {
    throw new AdminModelsError(404, "agent_not_found");
  }
  return result.rows[0];
}

async function lockModelState(
  client: PoolClient,
  scope: AgentScope,
): Promise<ModelStateRow | null> {
  const result = await client.query<ModelStateRow>(
    modelStateQuery(true),
    [scope.userId, scope.agentId],
  );
  return result.rows[0] ?? null;
}

function modelStateQuery(lock: boolean): string {
  return `SELECT settings.model_routing
                  AS user_model_routing,
                 settings.revision AS user_revision,
                 agent_settings.model_routing_override,
                 agent_settings.revision AS agent_revision
          FROM settings
          JOIN agent_settings
            ON agent_settings.user_id = settings.user_id
          JOIN digital_agents
            ON digital_agents.user_id = agent_settings.user_id
           AND digital_agents.id = agent_settings.agent_id
           AND digital_agents.status = 'active'
          WHERE settings.user_id = $1
            AND agent_settings.agent_id = $2
          ${lock
            ? "FOR UPDATE OF settings, agent_settings"
            : ""}`;
}

function projectActiveModels(
  row: ModelStateRow,
  scope: ModelScope,
): AdminActiveModels {
  const userRoutes = asModelRouting(
    row.user_model_routing,
  );
  if (scope === "global") {
    return activeModelsFromRoutes(
      userRoutes,
      Number(row.user_revision),
      scope,
    );
  }
  const effectiveRoutes = {
    ...userRoutes,
    ...asModelRoutingOverride(
      row.model_routing_override,
    ),
  };
  return activeModelsFromRoutes(
    effectiveRoutes,
    Number(row.agent_revision),
    scope,
  );
}

function activeModelsFromRoutes(
  routes: ModelRoutingSettings,
  revision: number,
  scope: ModelScope,
): AdminActiveModels {
  return {
    scope,
    routes,
    revision,
    active_llm: {
      provider_id: providerForModel(routes.main),
      model: routes.main,
    },
    effective_max_input_length: null,
  };
}

function providerForModel(model: string): string {
  const catalog = MODEL_CATALOG.find(
    (entry) => entry.id === model,
  );
  if (catalog) return providerId(catalog.provider);
  if (/claude/iu.test(model)) return "anthropic";
  if (/gemini/iu.test(model)) return "google";
  return "openai";
}

function asModelRouting(
  value: unknown,
): ModelRoutingSettings {
  const partial = asModelRoutingOverride(value);
  return {
    main:
      partial.main ?? defaultSettings.modelRouting.main,
    light:
      partial.light ?? defaultSettings.modelRouting.light,
  };
}

function asModelRoutingOverride(
  value: unknown,
): Partial<ModelRoutingSettings> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return {};
  }
  const row = value as Record<string, unknown>;
  return {
    ...(typeof row.main === "string" &&
    modelIdSchema.safeParse(row.main).success
      ? { main: row.main }
      : {}),
    ...(typeof row.light === "string" &&
    modelIdSchema.safeParse(row.light).success
      ? { light: row.light }
      : {}),
  };
}

async function readModelReplay(
  client: PoolClient,
  scope: AgentScope,
  resourceId: string,
  operationId: string,
): Promise<Readonly<{
  inputFingerprint: string | null;
  revision: number;
}> | null> {
  const result = await client.query<{
    input_fingerprint: string | null;
    revision: string;
  }>(
    `SELECT
       confirmation_source->>'inputFingerprint'
         AS input_fingerprint,
       after_summary->>'revision' AS revision
     FROM admin_audit_logs
     WHERE user_id = $1
       AND agent_id = $2
       AND action = 'model_route.update'
       AND resource_type = 'model_routing'
       AND resource_id = $3
       AND confirmation_source->>'requestId' = $4
       AND status = 'success'
     ORDER BY created_at DESC
     LIMIT 1`,
    [
      scope.userId,
      scope.agentId,
      resourceId,
      operationId,
    ],
  );
  const row = result.rows[0];
  return row
    ? {
        inputFingerprint: row.input_fingerprint,
        revision: Number(row.revision),
      }
    : null;
}

function modelMutationFingerprint(
  input: Readonly<{
    providerId: string;
    model: string;
    purpose: ModelPurpose;
    scope: WritableModelScope;
    agentId?: string;
    expectedRevision: number;
  }>,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        providerId: input.providerId,
        model: input.model,
        purpose: input.purpose,
        scope: input.scope,
        agentId: input.agentId ?? null,
        expectedRevision: input.expectedRevision,
      }),
      "utf8",
    )
    .digest("hex");
}

function mapModelsError(error: unknown): unknown {
  if (error instanceof AdminCompatError) return error;
  if (error instanceof AdminModelsError) {
    return new AdminCompatError(
      error.status,
      error.code,
      error.code,
    );
  }
  return error;
}
