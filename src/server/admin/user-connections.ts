export type UserConnectionDisconnector = {
  /**
   * Prevents new user connections and waits for registered in-flight
   * connections to finish. The returned release function reopens admission
   * after personal-data clearing has completed or failed.
   */
  disconnectUser(userId: string): Promise<() => void>;
  registerUserConnection(userId: string): () => void;
};

type UserConnectionState = {
  connections: Set<symbol>;
  draining: boolean;
  drainedWaiters: Array<() => void>;
};

export function createUserConnectionCoordinator(): UserConnectionDisconnector {
  const states = new Map<string, UserConnectionState>();

  const getState = (userId: string) => {
    const existing = states.get(userId);
    if (existing) return existing;
    const created: UserConnectionState = {
      connections: new Set(),
      draining: false,
      drainedWaiters: [],
    };
    states.set(userId, created);
    return created;
  };

  return {
    registerUserConnection(userId: string): () => void {
      const state = getState(userId);
      if (state.draining) throw new Error("user_connections_draining");
      const connectionId = Symbol(userId);
      state.connections.add(connectionId);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        state.connections.delete(connectionId);
        if (state.connections.size === 0) {
          const waiters = state.drainedWaiters.splice(0);
          waiters.forEach((resolve) => resolve());
          if (!state.draining) states.delete(userId);
        }
      };
    },

    async disconnectUser(userId: string): Promise<() => void> {
      const state = getState(userId);
      if (state.draining) throw new Error("user_connections_already_draining");
      state.draining = true;
      if (state.connections.size > 0) {
        await new Promise<void>((resolve) => {
          state.drainedWaiters.push(resolve);
        });
      }

      let released = false;
      return () => {
        if (released) return;
        released = true;
        state.draining = false;
        if (state.connections.size === 0) states.delete(userId);
      };
    },
  };
}

export const userConnectionDisconnector = createUserConnectionCoordinator();
