import { createAgentRepository, type AgentRepository } from "@/server/agents/repository";
import type { AgentResourceType, AgentScope } from "@/server/agents/types";

export function createAgentService(repository: AgentRepository = createAgentRepository()) {
  return {
    async getDefaultScope(userId: string): Promise<AgentScope> {
      const agent = await repository.ensureDefault(userId);
      return { userId, agentId: agent.id };
    },

    async listActiveScopes(userId?: string): Promise<AgentScope[]> {
      const agents = await repository.listActive(userId);
      return agents.map((agent) => ({ userId: agent.userId, agentId: agent.id }));
    },

    async canUseUserResource(
      scope: AgentScope,
      resourceType: AgentResourceType,
      resourceId: string,
    ): Promise<boolean> {
      const agents = await repository.listActive(scope.userId);
      const agent = agents.find((candidate) => candidate.id === scope.agentId);
      if (!agent) return false;
      const grant = (await repository.listResourceGrants(
        scope.userId,
        scope.agentId,
        resourceType,
      )).find((candidate) => candidate.resourceId === resourceId);
      if (grant) return grant.enabled;
      return agent.isDefault && agent.inheritsUserResources;
    },
  };
}

export type AgentService = ReturnType<typeof createAgentService>;

export async function resolveDefaultAgentScope(
  userId: string,
  repository: AgentRepository = createAgentRepository(),
): Promise<AgentScope> {
  const agent = await repository.getDefault(userId);
  if (!agent || agent.status !== "active") throw new Error("default_agent_not_found");
  return { userId, agentId: agent.id };
}
