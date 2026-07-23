import { createAgentRepository, type AgentRepository } from "@/server/agents/repository";
import type { AgentResourceType, AgentScope } from "@/server/agents/types";
import type { LlmRouteConfig } from "@/server/llm/router";
import type { LlmPurpose } from "@/server/llm/types";

export function createAgentService(repository: AgentRepository = createAgentRepository()) {
  async function listAuthorizedResourceIds(
    scope: AgentScope,
    resourceType: AgentResourceType,
    resourceIds: string[],
  ): Promise<string[]> {
    if (resourceIds.length === 0) return [];
    const [agent, grants] = await Promise.all([
      repository.getActive(scope),
      repository.listResourceGrants(scope.userId, scope.agentId, resourceType),
    ]);
    if (!agent) return [];

    const grantByResourceId = new Map(
      grants.map((grant) => [grant.resourceId, grant.enabled] as const),
    );
    return [...new Set(resourceIds)].filter((resourceId) =>
      grantByResourceId.get(resourceId) ?? agent.inheritsUserResources
    );
  }

  return {
    async getDefaultScope(userId: string): Promise<AgentScope> {
      const agent = await repository.ensureDefault(userId);
      if (agent.status !== "active") throw new Error("default_agent_not_found");
      return { userId, agentId: agent.id };
    },

    async listActiveScopes(userId?: string): Promise<AgentScope[]> {
      const agents = await repository.listActive(userId);
      return agents.map((agent) => ({ userId: agent.userId, agentId: agent.id }));
    },

    listAuthorizedResourceIds,

    async canUseUserResource(
      scope: AgentScope,
      resourceType: AgentResourceType,
      resourceId: string,
    ): Promise<boolean> {
      return (await listAuthorizedResourceIds(
        scope,
        resourceType,
        [resourceId],
      )).length === 1;
    },
  };
}

export type AgentService = ReturnType<typeof createAgentService>;

export async function assertAuthorizedModelRoutes(
  scope: AgentScope,
  purposes: LlmPurpose[],
  routeConfig: LlmRouteConfig,
  repository: AgentRepository = createAgentRepository(),
): Promise<void> {
  const resourceIds = [...new Set(
    purposes.map((purpose) => purpose === "main" ? routeConfig.main : routeConfig.light),
  )];
  const authorizedIds = await createAgentService(repository).listAuthorizedResourceIds(
    scope,
    "model",
    resourceIds,
  );
  if (authorizedIds.length !== resourceIds.length) {
    throw new Error("model_resource_unauthorized");
  }
}

export async function resolveDefaultAgentScope(
  userId: string,
  repository: AgentRepository = createAgentRepository(),
): Promise<AgentScope> {
  const agent = await repository.getDefault(userId);
  if (!agent || agent.status !== "active") throw new Error("default_agent_not_found");
  return { userId, agentId: agent.id };
}
