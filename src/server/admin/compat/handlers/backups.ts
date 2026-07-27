import { z } from "zod";

import type { AgentScope } from "@/server/agents/types";
import {
  AdminCompatError,
  type AdminCompatHandler,
} from "@/server/admin/compat/types";

const uuidSchema = z.string().uuid();
const restoreSchema = z.object({
  include_agents: z.boolean(),
  agent_ids: z.array(uuidSchema).max(1),
  include_global_config: z.boolean(),
  include_secrets: z.boolean(),
  include_skill_pool: z.boolean(),
  mode: z.enum(["full", "custom"]).optional(),
  preserve_local_protected_config: z.boolean().nullable().optional(),
  trust_mode: z.enum(["legacy", "foreign"]).nullable().optional(),
}).strict();
const deleteSchema = z.object({
  ids: z.array(uuidSchema).min(1).max(100),
}).strict();

export type AdminBackupMeta = Readonly<{
  id: string;
  name: string;
  description: string;
  created_at: string;
  scope: Readonly<{
    include_agents: boolean;
    include_global_config: boolean;
    include_secrets: boolean;
    include_skill_pool: boolean;
  }>;
  agent_count: number;
  signature?: string | null;
  accepted_via_trust?: boolean | null;
}>;

export type AdminBackupDetail =
  AdminBackupMeta & Readonly<{
    workspace_stats: Readonly<
      Record<
        string,
        Readonly<{
          files: number;
          size: number;
          name?: string;
        }>
      >
    >;
  }>;

export type AdminBackupsService = Readonly<{
  list(
    scope: AgentScope,
    signal?: AbortSignal,
  ): Promise<readonly AdminBackupMeta[]>;
  get(
    scope: AgentScope,
    backupId: string,
    signal?: AbortSignal,
  ): Promise<AdminBackupDetail>;
  create?(
    scope: AgentScope,
    input: Readonly<{
      name: string;
      description: string;
    }>,
    signal?: AbortSignal,
  ): Promise<AdminBackupMeta>;
  restore(
    scope: AgentScope,
    backupId: string,
    input: Readonly<{
      agentIds: readonly string[];
      includeGlobalConfig: boolean;
      includeSecrets: boolean;
      includeSkillPool: boolean;
      confirmed: true;
    }>,
    signal?: AbortSignal,
  ): Promise<Readonly<{
    ok: boolean;
    preserved_local_keys: readonly string[];
  }>>;
  delete(
    scope: AgentScope,
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<Readonly<{
    deleted: readonly string[];
    failed: readonly Readonly<{
      id: string;
      reason: string;
    }>[];
  }>>;
  export(
    scope: AgentScope,
    backupId: string,
    signal?: AbortSignal,
  ): Promise<Readonly<{
    bytes: Buffer;
    fileName: string;
  }>>;
  import?(
    scope: AgentScope,
    file: File,
    signal?: AbortSignal,
  ): Promise<AdminBackupMeta>;
}>;

export function createListBackupsHandler(
  service: AdminBackupsService,
): AdminCompatHandler {
  return async (context) =>
    service.list(context.scope, context.signal);
}

export function createGetBackupHandler(
  service: AdminBackupsService,
): AdminCompatHandler {
  return async (context) =>
    service.get(
      context.scope,
      readBackupId(context.params),
      context.signal,
    );
}

export function createCreateBackupStreamHandler(
  service: AdminBackupsService,
): AdminCompatHandler {
  return async (context) => {
    if (!service.create) {
      throw new AdminCompatError(
        503,
        "backup_encryption_key_missing",
        "backup_encryption_key_missing",
      );
    }
    const body = await readJson(context.request);
    const parsed = z.object({
      name: z.string().trim().min(1).max(120),
      description: z.string().trim().max(500).optional(),
      scope: z.object({
        include_agents: z.literal(true),
        include_global_config: z.boolean(),
        include_secrets: z.boolean(),
        include_skill_pool: z.boolean(),
      }).strict(),
      agents: z.array(uuidSchema).min(1).max(1),
    }).strict().safeParse(body);
    if (
      !parsed.success
      || parsed.data.agents[0] !== context.scope.agentId
      || !parsed.data.scope.include_agents
      || !parsed.data.scope.include_global_config
      || !parsed.data.scope.include_secrets
      || !parsed.data.scope.include_skill_pool
    ) {
      throw new AdminCompatError(
        400,
        "backup_scope_invalid",
        "backup_scope_invalid",
      );
    }
    const meta = await service.create(
      context.scope,
      {
        name: parsed.data.name,
        description: parsed.data.description ?? "",
      },
      context.signal,
    );
    const events = [
      {
        type: "start",
        total_agents: 1,
        percent: 0,
      },
      {
        type: "agent",
        agent_id: context.scope.agentId,
        index: 1,
        total: 1,
        percent: 70,
      },
      { type: "saving", percent: 90 },
      { type: "done", meta, percent: 100 },
    ];
    return new Response(
      events.map((event) =>
        `data: ${JSON.stringify(event)}\n\n`
      ).join(""),
      {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
        },
      },
    );
  };
}

export function createRestoreBackupHandler(
  service: AdminBackupsService,
): AdminCompatHandler {
  return async (context) => {
    const parsed = restoreSchema.safeParse(
      await readJson(context.request),
    );
    if (!parsed.success) {
      throw new AdminCompatError(
        400,
        "backup_restore_invalid",
        "backup_restore_invalid",
      );
    }
    if (
      !parsed.data.include_agents
      || parsed.data.agent_ids.length !== 1
      || parsed.data.agent_ids[0] !== context.scope.agentId
    ) {
      throw new AdminCompatError(
        409,
        "backup_agent_mismatch",
        "backup_agent_mismatch",
      );
    }
    if (
      !parsed.data.include_global_config
      || !parsed.data.include_secrets
      || !parsed.data.include_skill_pool
      || parsed.data.mode === "custom"
    ) {
      throw new AdminCompatError(
        400,
        "backup_scope_invalid",
        "backup_scope_invalid",
      );
    }
    return service.restore(
      context.scope,
      readBackupId(context.params),
      {
        agentIds: parsed.data.agent_ids,
        includeGlobalConfig:
          parsed.data.include_global_config,
        includeSecrets: parsed.data.include_secrets,
        includeSkillPool: parsed.data.include_skill_pool,
        confirmed: true,
      },
      context.signal,
    );
  };
}

export function createDeleteBackupsHandler(
  service: AdminBackupsService,
): AdminCompatHandler {
  return async (context) => {
    const parsed = deleteSchema.safeParse(
      await readJson(context.request),
    );
    if (!parsed.success) {
      throw new AdminCompatError(
        400,
        "backup_delete_invalid",
        "backup_delete_invalid",
      );
    }
    return service.delete(
      context.scope,
      parsed.data.ids,
      context.signal,
    );
  };
}

export function createExportBackupHandler(
  service: AdminBackupsService,
): AdminCompatHandler {
  return async (context) => {
    const exported = await service.export(
      context.scope,
      readBackupId(context.params),
      context.signal,
    );
    return new Response(new Uint8Array(exported.bytes), {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition":
          `attachment; filename="${sanitizeFileName(
            exported.fileName,
          )}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  };
}

export function createImportBackupHandler(
  service: AdminBackupsService,
): AdminCompatHandler {
  return async (context) => {
    if (!service.import) {
      throw new AdminCompatError(
        501,
        "backup_import_disabled",
        "backup_import_disabled",
      );
    }
    const form = await context.request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new AdminCompatError(
        400,
        "backup_import_invalid",
        "backup_import_invalid",
      );
    }
    return service.import(
      context.scope,
      file,
      context.signal,
    );
  };
}

function readBackupId(
  params: Readonly<Record<string, string>>,
): string {
  const parsed = uuidSchema.safeParse(params.backupId);
  if (!parsed.success) {
    throw new AdminCompatError(
      400,
      "backup_id_invalid",
      "backup_id_invalid",
    );
  }
  return parsed.data;
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new AdminCompatError(
      400,
      "invalid_json",
      "invalid_json",
    );
  }
}

function sanitizeFileName(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/gu, "_");
  return safe.length > 0 ? safe.slice(0, 180) : "backup.dmbackup";
}
