import { z } from "zod";

import { readAdminCompatJson } from "@/server/admin/compat/json";
import {
  AdminCompatError,
  type AdminCompatHandler,
} from "@/server/admin/compat/types";
import {
  AdminAgentResourcesError,
  type AdminAgentResourcesService,
} from "@/server/admin/views/agent-resources";

export type { AdminAgentResourcesService } from "@/server/admin/views/agent-resources";

const canonicalUuidSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
);
const skillMutationSchema = z
  .object({
    revision: z.number().int().positive(),
    operation_id: canonicalUuidSchema,
    confirmed: z.boolean(),
  })
  .strict();
const createSkillSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    content: z.string().trim().min(1).max(64 * 1_024),
    config: z.record(z.string(), z.unknown()).optional(),
    enable: z.boolean().optional().default(false),
    operation_id: canonicalUuidSchema,
    confirmed: z.boolean().optional().default(false),
  })
  .strict();
const saveSkillSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    content: z.string().trim().min(1).max(64 * 1_024),
    source_name: z.string().trim().min(1).max(200).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    overwrite: z.boolean().optional(),
    revision: z.number().int().positive(),
    operation_id: canonicalUuidSchema,
    confirmed: z.boolean(),
  })
  .strict();

export function createCreateSkillHandler(
  service: AdminAgentResourcesService,
): AdminCompatHandler {
  return async (context) => {
    try {
      const body = createSkillSchema.parse(
        await readAdminCompatJson(context.request),
      );
      if (body.enable && !body.confirmed) {
        throw new AdminCompatError(
          409,
          "confirmation_required",
          "confirmation_required",
        );
      }
      return await service.createSkill(
        context.scope,
        {
          name: body.name,
          content: body.content,
          enabled: body.enable,
        },
        {
          operationId: body.operation_id,
          confirmed: body.confirmed,
        },
        context.signal,
      );
    } catch (error) {
      throw mapResourceError(error);
    }
  };
}

export function createSaveSkillHandler(
  service: AdminAgentResourcesService,
): AdminCompatHandler {
  return async (context) => {
    try {
      const body = saveSkillSchema.parse(
        await readAdminCompatJson(context.request),
      );
      const sourceName = body.source_name ?? body.name;
      if (sourceName !== body.name) {
        throw new AdminCompatError(
          400,
          "invalid_request",
          "skill_rename_not_supported",
        );
      }
      return await service.proposeSkillRevision(
        context.scope,
        sourceName,
        {
          content: body.content,
          expectedRevision: body.revision,
          operationId: body.operation_id,
          confirmed: body.confirmed,
        },
        context.signal,
      );
    } catch (error) {
      throw mapResourceError(error);
    }
  };
}

export function createListSkillsHandler(
  service: AdminAgentResourcesService,
): AdminCompatHandler {
  return async (context) =>
    service.listSkills(context.scope, context.signal);
}

export function createListSkillWorkspacesHandler(
  service: AdminAgentResourcesService,
): AdminCompatHandler {
  return async (context) =>
    service.listSkillWorkspaces(
      context.scope,
      context.signal,
    );
}

export function createListSkillPoolHandler(
  service: AdminAgentResourcesService,
): AdminCompatHandler {
  return async (context) =>
    service.listSkillPool(context.scope, context.signal);
}

export function createRefreshSkillsHandler(
  service: AdminAgentResourcesService,
  pool = false,
): AdminCompatHandler {
  return async (context) =>
    pool
      ? service.listSkillPool(
          context.scope,
          context.signal,
        )
      : service.listSkills(
          context.scope,
          context.signal,
        );
}

export function createSetSkillEnabledHandler(
  service: AdminAgentResourcesService,
  enabled: boolean,
): AdminCompatHandler {
  return async (context) => {
    try {
      const skillName = readName(
        context.params.skillName,
        "skill",
      );
      const body = skillMutationSchema.parse(
        await readAdminCompatJson(context.request),
      );
      if (enabled && !body.confirmed) {
        throw new AdminCompatError(
          409,
          "confirmation_required",
          "confirmation_required",
        );
      }
      return await service.setSkillEnabled(
        context.scope,
        skillName,
        enabled,
        {
          expectedRevision: body.revision,
          operationId: body.operation_id,
          confirmed: body.confirmed,
        },
        context.signal,
      );
    } catch (error) {
      throw mapResourceError(error);
    }
  };
}

export function createListToolsHandler(
  service: AdminAgentResourcesService,
): AdminCompatHandler {
  return async (context) =>
    service.listTools(context.scope, context.signal);
}

export function createGetToolConfigHandler(
  service: AdminAgentResourcesService,
): AdminCompatHandler {
  return async (context) => {
    const result = await service.getToolConfig(
      context.scope,
      readName(context.params.toolName, "tool"),
      context.signal,
    );
    if (!result) throw resourceNotFound("tool_not_found");
    return result;
  };
}

export function createListMcpClientsHandler(
  service: AdminAgentResourcesService,
): AdminCompatHandler {
  return async (context) =>
    service.listMcpClients(context.scope, context.signal);
}

export function createGetMcpClientHandler(
  service: AdminAgentResourcesService,
): AdminCompatHandler {
  return async (context) => {
    const result = await service.getMcpClient(
      context.scope,
      readClientKey(context.params.clientKey),
      context.signal,
    );
    if (!result) throw resourceNotFound("mcp_client_not_found");
    return result;
  };
}

export function createListMcpToolsHandler(
  service: AdminAgentResourcesService,
): AdminCompatHandler {
  return async (context) => {
    const result = await service.listMcpTools(
      context.scope,
      readClientKey(context.params.clientKey),
      context.signal,
    );
    if (!result) throw resourceNotFound("mcp_client_not_found");
    return result;
  };
}

export function createListMcpAccessPrincipalsHandler(
  service: AdminAgentResourcesService,
): AdminCompatHandler {
  return async (context) =>
    service.listMcpAccessPrincipals(
      context.scope,
      context.signal,
    );
}

export function createGetMcpPolicyHandler(
  service: AdminAgentResourcesService,
): AdminCompatHandler {
  return async (context) => {
    const result = await service.getMcpPolicy(
      context.scope,
      readClientKey(context.params.clientKey),
      context.signal,
    );
    if (!result) throw resourceNotFound("mcp_client_not_found");
    return result;
  };
}

function readName(
  value: string | undefined,
  resource: string,
): string {
  const parsed = z.string().trim().min(1).max(200).safeParse(value);
  if (!parsed.success || /[/\\\u0000]/u.test(parsed.data)) {
    throw new AdminCompatError(
      400,
      "invalid_request",
      `invalid_${resource}_name`,
    );
  }
  return parsed.data;
}

function readClientKey(value: string | undefined): string {
  const parsed = canonicalUuidSchema.safeParse(value);
  if (!parsed.success) {
    throw new AdminCompatError(
      400,
      "invalid_request",
      "invalid_mcp_client_key",
    );
  }
  return parsed.data;
}

function resourceNotFound(message: string): AdminCompatError {
  return new AdminCompatError(404, "not_found", message);
}

function mapResourceError(error: unknown): unknown {
  if (error instanceof AdminCompatError) return error;
  if (error instanceof AdminAgentResourcesError) {
    return new AdminCompatError(
      error.status,
      error.status === 404 ? "not_found" : error.code,
      error.code,
    );
  }
  return error;
}
