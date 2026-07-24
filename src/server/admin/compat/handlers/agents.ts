import { z } from "zod";
import { assertMultiAgentMutationAllowed } from "@/server/agents/features";
import type { DigitalAgent } from "@/server/agents/types";
import type { EffectiveAgentSettings } from "@/server/settings/agent-settings";
import type { AdminCompatHandler } from "@/server/admin/compat/types";
import { AdminCompatError } from "@/server/admin/compat/types";
import { readAdminCompatJson } from "@/server/admin/compat/json";
import { STABLE_CAPABILITY_CODES } from "@/server/capabilities";
import {
  createAdminAgentProfileService,
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

export const listAgents: AdminCompatHandler = async (context) => {
  const profile = await readDefaultAgentProfile(context);
  return { agents: [toAgentSummary(profile.agent, profile.settings)] };
};

export const getAgent: AdminCompatHandler = async (context) => {
  assertDefaultAgentPath(context.params.agentId, context.scope.agentId);
  const profile = await readDefaultAgentProfile(context);
  return toAgentProfile(profile.agent, profile.settings);
};

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

export const createAgent: AdminCompatHandler = async ({ request }) => {
  await readAdminCompatJson(request);
  assertMultiAgentMutationAllowed("create");
};

export const importAgent: AdminCompatHandler = async ({ request }) => {
  await readAdminCompatJson(request);
  assertMultiAgentMutationAllowed("import");
};

export const cloneAgent: AdminCompatHandler = async (context) => {
  assertDefaultAgentPath(context.params.agentId, context.scope.agentId);
  await readAdminCompatJson(context.request);
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

async function readDefaultAgentProfile(
  context: Parameters<AdminCompatHandler>[0],
): Promise<{
  agent: DigitalAgent;
  settings: EffectiveAgentSettings;
}> {
  const [agent, settings] = await Promise.all([
    context.resources.agents.getActive(context.scope),
    context.resources.settings.get(context.scope),
  ]);
  if (!agent || !agent.isDefault) {
    throw new Error("default_agent_not_found");
  }
  return { agent, settings };
}

function toAgentSummary(
  agent: DigitalAgent,
  settings: EffectiveAgentSettings,
) {
  return {
    id: agent.id,
    name: agent.displayName,
    display_name: agent.displayName,
    description: DEFAULT_AGENT_DESCRIPTION,
    workspace_dir: "",
    enabled: agent.status === "active",
    pinned: true,
    startup_status: "running",
    active_model: null,
    is_default: true,
    revision: settings.revision,
  };
}

function toAgentProfile(
  agent: DigitalAgent,
  settings: EffectiveAgentSettings,
) {
  return {
    ...toAgentSummary(agent, settings),
    persona: settings.persona,
    settings: {
      proactivity: settings.proactivity,
      cadence: settings.cadence,
      search: settings.search,
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
