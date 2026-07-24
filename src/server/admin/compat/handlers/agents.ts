import { z } from "zod";
import { assertMultiAgentMutationAllowed } from "@/server/agents/features";
import type { AdminCompatHandler } from "@/server/admin/compat/types";
import { AdminCompatError } from "@/server/admin/compat/types";
import { readAdminCompatJson } from "@/server/admin/compat/json";
import { STABLE_CAPABILITY_CODES } from "@/server/capabilities";
import {
  createAdminAgentProfileService,
  type AdminAgentProfileSnapshot,
  type AdminAgentProfileUpdate,
  type AdminAgentProfileUpdateResult,
} from "@/server/admin/agent-profile";
import { getPool } from "@/server/db/client";

const DEFAULT_AGENT_DESCRIPTION =
  "DigitalMate 默认数字分身，全渠道共享同一身份与记忆。";
const toggleBodySchema = z.object({ enabled: z.boolean() }).strict();
const pinBodySchema = z.object({ pinned: z.boolean() }).strict();
const reorderBodySchema = z
  .object({
    agent_ids: z.array(z.string()).min(1),
  })
  .strict();
const canonicalUuidSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);
const clockSchema = z.string().regex(
  /^(?:[01]\d|2[0-3]):[0-5]\d$/,
);
const personaSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    style: z.string().trim().min(1).max(4_000),
    emojiHabit: z.string().trim().max(500),
  })
  .strict();
const profileUpdateBodySchema = z
  .object({
    id: canonicalUuidSchema.optional(),
    operation_id: canonicalUuidSchema,
    name: z.string().trim().min(1).max(80),
    persona: personaSchema,
    settings: z
      .object({
        proactivity: z
          .object({
            quietStart: clockSchema,
            quietEnd: clockSchema,
            minIntervalMinutes: z.number().int().min(1).max(1_440),
            maxPerHour: z.number().int().min(1).max(10),
            maxPerDay: z.number().int().min(1).max(20),
          })
          .strict(),
        cadence: z
          .object({
            responseDelayMs: z.number().int().min(0).max(2_000),
            segmentDelayMs: z.number().int().min(0).max(2_000),
            maxSegments: z.number().int().min(1).max(20),
          })
          .strict(),
        search: z
          .object({
            aggressiveness: z.enum([
              "conservative",
              "standard",
              "off",
            ]),
          })
          .strict(),
      })
      .strict(),
    revision: z.number().int().positive(),
  })
  .strict();

export type AdminAgentProfileUpdater = (
  input: AdminAgentProfileUpdate,
  signal?: AbortSignal,
) => Promise<AdminAgentProfileUpdateResult>;

export type AdminAgentProfileReader = (
  scope: AdminAgentProfileUpdate["scope"],
  signal?: AbortSignal,
) => Promise<AdminAgentProfileSnapshot>;

export function createListAgentsHandler(
  readProfile: AdminAgentProfileReader = (scope, signal) =>
    createAdminAgentProfileService(getPool()).read(scope, signal),
): AdminCompatHandler {
  return async (context) => {
    const profile = await readProfile(context.scope, context.signal);
    return { agents: [toAgentSummary(profile)] };
  };
}

export function createGetAgentHandler(
  readProfile: AdminAgentProfileReader = (scope, signal) =>
    createAdminAgentProfileService(getPool()).read(scope, signal),
): AdminCompatHandler {
  return async (context) => {
    assertDefaultAgentPath(
      context.params.agentId,
      context.scope.agentId,
    );
    const profile = await readProfile(context.scope, context.signal);
    return toAgentProfile(profile);
  };
}

export function createUpdateAgentHandler(
  updateProfile: AdminAgentProfileUpdater = (input, signal) =>
    createAdminAgentProfileService(getPool()).update(input, signal),
): AdminCompatHandler {
  return async (context) => {
    assertDefaultAgentPath(
      context.params.agentId,
      context.scope.agentId,
    );
    const input = profileUpdateBodySchema.parse(
      await readAdminCompatJson(context.request),
    );
    if (input.id && input.id !== context.scope.agentId) {
      throwAgentNotFound();
    }
    const updated = await updateProfile(
      {
        scope: context.scope,
        operationId: input.operation_id,
        expectedRevision: input.revision,
        displayName: input.name,
        persona: input.persona,
        settings: input.settings,
      },
      context.signal,
    );
    return {
      id: context.scope.agentId,
      name: input.name,
      display_name: input.name,
      description: DEFAULT_AGENT_DESCRIPTION,
      workspace_dir: "",
      enabled: true,
      pinned: true,
      startup_status: "running",
      active_model: null,
      is_default: true,
      persona: input.persona,
      settings: input.settings,
      revision: updated.revision,
      capabilities: {
        multi_agent: false,
        create: false,
        import: false,
        clone: false,
        delete: false,
      },
    };
  };
}

export const createAgent: AdminCompatHandler = async () => {
  assertMultiAgentMutationAllowed("create");
};

export const importAgent: AdminCompatHandler = async () => {
  assertMultiAgentMutationAllowed("import");
};

export const cloneAgent: AdminCompatHandler = async (context) => {
  assertDefaultAgentPath(context.params.agentId, context.scope.agentId);
  assertMultiAgentMutationAllowed("clone");
};

export const deleteAgent: AdminCompatHandler = async (context) => {
  assertDefaultAgentPath(context.params.agentId, context.scope.agentId);
  assertMultiAgentMutationAllowed("delete");
};

export const toggleAgent: AdminCompatHandler = async (context) => {
  assertDefaultAgentPath(context.params.agentId, context.scope.agentId);
  const input = toggleBodySchema.parse(
    await readAdminCompatJson(context.request),
  );
  if (!input.enabled) throwMultiAgentCapabilityDisabled();
  return {
    success: true,
    agent_id: context.scope.agentId,
    enabled: true,
  };
};

export const pinAgent: AdminCompatHandler = async (context) => {
  assertDefaultAgentPath(context.params.agentId, context.scope.agentId);
  const input = pinBodySchema.parse(
    await readAdminCompatJson(context.request),
  );
  if (!input.pinned) throwMultiAgentCapabilityDisabled();
  return {
    success: true,
    agent_id: context.scope.agentId,
    pinned: true,
  };
};

export const reorderAgents: AdminCompatHandler = async (context) => {
  const input = reorderBodySchema.parse(
    await readAdminCompatJson(context.request),
  );
  if (
    input.agent_ids.length !== 1 ||
    input.agent_ids[0] !== context.scope.agentId
  ) {
    throwMultiAgentCapabilityDisabled();
  }
  return {
    success: true,
    agent_ids: [context.scope.agentId],
  };
};

function toAgentSummary(
  profile: AdminAgentProfileSnapshot,
) {
  return {
    id: profile.id,
    name: profile.displayName,
    display_name: profile.displayName,
    description: DEFAULT_AGENT_DESCRIPTION,
    workspace_dir: "",
    enabled: true,
    pinned: true,
    startup_status: "running",
    active_model: null,
    is_default: true,
    revision: profile.revision,
  };
}

function toAgentProfile(
  profile: AdminAgentProfileSnapshot,
) {
  return {
    ...toAgentSummary(profile),
    persona: profile.persona,
    settings: {
      proactivity: profile.proactivity,
      cadence: profile.cadence,
      search: profile.search,
    },
    capabilities: {
      multi_agent: false,
      create: false,
      import: false,
      clone: false,
      delete: false,
    },
  };
}

function assertDefaultAgentPath(
  requestedAgentId: string | undefined,
  defaultAgentId: string,
): void {
  if (requestedAgentId !== defaultAgentId) {
    throwAgentNotFound();
  }
}

function throwAgentNotFound(): never {
  throw new AdminCompatError(
    404,
    "not_found",
    "agent_not_found",
  );
}

function throwMultiAgentCapabilityDisabled(): never {
  throw new AdminCompatError(
    501,
    "capability_disabled",
    "capability_disabled",
    { capability: STABLE_CAPABILITY_CODES.multiAgent },
  );
}
