export type AgentScope = Readonly<{
  userId: string;
  agentId: string;
}>;

export type DigitalAgentStatus = "active" | "disabled" | "archived";

export type DigitalAgent = Readonly<{
  id: string;
  userId: string;
  slug: string;
  displayName: string;
  persona: Record<string, unknown>;
  status: DigitalAgentStatus;
  isDefault: boolean;
  inheritsUserResources: boolean;
  createdAt: Date;
  updatedAt: Date;
}>;

export type AgentResourceType = "model" | "skill" | "tool";

export type AgentResourceGrant = Readonly<{
  userId: string;
  agentId: string;
  resourceType: AgentResourceType;
  resourceId: string;
  enabled: boolean;
}>;
