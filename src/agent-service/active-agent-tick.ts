import type { AgentScope, DigitalAgent } from "@/server/agents/types";

export type ActiveAgentTickOptions = {
  listActiveAgents(): Promise<Array<Pick<DigitalAgent, "id" | "userId" | "status">>>;
  execute(scope: AgentScope): Promise<void>;
  onError?(error: unknown, scope: AgentScope): void | Promise<void>;
  throttleMs?: number;
  now?: () => number;
};

export function createActiveAgentTickRunner(
  options: ActiveAgentTickOptions,
): () => Promise<void> {
  const running = new Set<string>();
  const lastStartedAt = new Map<string, number>();
  const throttleMs = Math.max(0, options.throttleMs ?? 0);
  const now = options.now ?? Date.now;

  return async () => {
    const agents = await options.listActiveAgents();
    for (const agent of agents) {
      if (agent.status !== "active") continue;
      const scope = { userId: agent.userId, agentId: agent.id } satisfies AgentScope;
      const key = `${scope.userId}:${scope.agentId}`;
      const startedAt = now();
      const previousStartedAt = lastStartedAt.get(key);
      if (
        running.has(key)
        || (throttleMs > 0
          && previousStartedAt !== undefined
          && startedAt - previousStartedAt < throttleMs)
      ) {
        continue;
      }

      running.add(key);
      lastStartedAt.set(key, startedAt);
      try {
        await options.execute(scope);
      } catch (error) {
        if (!options.onError) throw error;
        try {
          await options.onError(error, scope);
        } catch {
          // Reporting is best-effort and must not suppress later agent scopes.
        }
      } finally {
        running.delete(key);
      }
    }
  };
}
