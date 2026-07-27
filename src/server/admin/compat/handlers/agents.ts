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
const ALVIN_AGENT_DESCRIPTION = "独立的 MaaS 售前解决方案架构师。";
const AGENT_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  digitalmate: DEFAULT_AGENT_DESCRIPTION,
  alvin: ALVIN_AGENT_DESCRIPTION,
});
// "create" reports whether the console may create arbitrary agents. The fixed
// Alvin instance is provisioned by an idempotent ops script, not by the UI.
const AGENT_CAPABILITIES = Object.freeze({
  multi_agent: true,
  create: false,
  import: false,
  clone: false,
  delete: false,
  toggle: false,
  pin: false,
  reorder: false,
});
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
const createAgentBodySchema = z
  .object({
    operation_id: canonicalUuidSchema,
  })
  .strict();
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
    const agents = await context.resources.agents.listActive(
      context.scope.userId,
    );
    return {
      agents: await Promise.all(
        agents.map(async (agent) =>
          toAgentSummary(
            await readProfile(
              {
                userId: context.scope.userId,
                agentId: agent.id,
              },
              context.signal,
            ),
            agent,
          )
        ),
      ),
      capabilities: AGENT_CAPABILITIES,
    };
  };
}

export function createGetAgentHandler(
  readProfile: AdminAgentProfileReader = (scope, signal) =>
    createAdminAgentProfileService(getPool()).read(scope, signal),
): AdminCompatHandler {
  return async (context) => {
    assertSelectedAgentPath(
      context.params.agentId,
      context.scope.agentId,
    );
    const agent = await context.resources.agents.getActive(
      context.scope,
    );
    if (!agent) throwAgentNotFound();
    const profile = await readProfile(context.scope, context.signal);
    return toAgentProfile(profile, agent);
  };
}

export function createUpdateAgentHandler(
  updateProfile: AdminAgentProfileUpdater = (input, signal) =>
    createAdminAgentProfileService(getPool()).update(input, signal),
): AdminCompatHandler {
  return async (context) => {
    assertSelectedAgentPath(
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
    const agent = await context.resources.agents.getActive(
      context.scope,
    );
    if (!agent) throwAgentNotFound();
    return {
      id: context.scope.agentId,
      name: input.name,
      display_name: input.name,
      description: describeAgent(agent.slug, input.name),
      workspace_dir: "",
      enabled: true,
      pinned: true,
      startup_status: "running",
      active_model: null,
      is_default: agent.isDefault,
      persona: input.persona,
      settings: input.settings,
      revision: updated.revision,
      capabilities: AGENT_CAPABILITIES,
    };
  };
}

export const createAgent: AdminCompatHandler = async (context) => {
  assertMultiAgentMutationAllowed("create");
  createAgentBodySchema.parse(
    await readAdminCompatJson(context.request),
  );
  const agent = await context.resources.agents.createAlvin(
    context.scope.userId,
  );
  return {
    id: agent.id,
    name: agent.displayName,
    display_name: agent.displayName,
    description: describeAgent(agent.slug, agent.displayName),
    workspace_dir: "",
    enabled: true,
    pinned: true,
    startup_status: "running",
    active_model: null,
    is_default: false,
    capabilities: AGENT_CAPABILITIES,
  };
};

export const importAgent: AdminCompatHandler = async () => {
  assertMultiAgentMutationAllowed("import");
};

export const cloneAgent: AdminCompatHandler = async (context) => {
  assertSelectedAgentPath(context.params.agentId, context.scope.agentId);
  assertMultiAgentMutationAllowed("clone");
};

export const deleteAgent: AdminCompatHandler = async (context) => {
  assertSelectedAgentPath(context.params.agentId, context.scope.agentId);
  assertMultiAgentMutationAllowed("delete");
};

export const toggleAgent: AdminCompatHandler = async (context) => {
  assertSelectedAgentPath(context.params.agentId, context.scope.agentId);
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
  assertSelectedAgentPath(context.params.agentId, context.scope.agentId);
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

function describeAgent(slug: string, displayName: string): string {
  return AGENT_DESCRIPTIONS[slug] ?? displayName;
}

function toAgentSummary(
  profile: AdminAgentProfileSnapshot,
  agent: { slug: string; isDefault: boolean },
) {
  return {
    id: profile.id,
    name: profile.displayName,
    display_name: profile.displayName,
    description: describeAgent(agent.slug, profile.displayName),
    workspace_dir: "",
    enabled: true,
    pinned: true,
    startup_status: "running",
    active_model: null,
    is_default: agent.isDefault,
    revision: profile.revision,
  };
}

function toAgentProfile(
  profile: AdminAgentProfileSnapshot,
  agent: { slug: string; isDefault: boolean },
) {
  return {
    ...toAgentSummary(profile, agent),
    persona: profile.persona,
    settings: {
      proactivity: profile.proactivity,
      cadence: profile.cadence,
      search: profile.search,
    },
    capabilities: AGENT_CAPABILITIES,
  };
}

function assertSelectedAgentPath(
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
