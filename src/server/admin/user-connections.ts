export type UserConnectionDisconnector = {
  /**
   * Settles before any physical or database deletion starts. Rejecting aborts
   * the clear operation, leaves persisted locators intact, and must be safe
   * for the caller to retry after releasing its user mutation lock.
   */
  disconnectUser(userId: string): Promise<void>;
};

// M2 has no live connection registry yet. Keeping this boundary explicit and
// injectable prevents personal-data clear from silently skipping disconnects
// once channel sessions become stateful.
export const userConnectionDisconnector: UserConnectionDisconnector = {
  async disconnectUser(userId: string): Promise<void> {
    void userId;
    // Intentionally empty until a connection registry is introduced.
  },
};
