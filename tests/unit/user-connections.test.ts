import { describe, expect, it } from "vitest";
import { createUserConnectionCoordinator } from "@/server/admin/user-connections";

describe("user connection coordinator", () => {
  it("rejects new connections while a clear drain is active and reopens after release", async () => {
    const coordinator = createUserConnectionCoordinator();
    const releaseDrain = await coordinator.disconnectUser("user-1");

    expect(() => coordinator.registerUserConnection("user-1"))
      .toThrow("user_connections_draining");

    releaseDrain();
    const releaseConnection = coordinator.registerUserConnection("user-1");
    releaseConnection();
  });

  it("waits for registered in-flight connections to release before clear may continue", async () => {
    const coordinator = createUserConnectionCoordinator();
    const releaseConnection = coordinator.registerUserConnection("user-1");
    let drained = false;
    const draining = coordinator.disconnectUser("user-1").then((releaseDrain) => {
      drained = true;
      return releaseDrain;
    });

    await Promise.resolve();
    expect(drained).toBe(false);
    expect(() => coordinator.registerUserConnection("user-1"))
      .toThrow("user_connections_draining");

    releaseConnection();
    const releaseDrain = await draining;
    expect(drained).toBe(true);
    releaseDrain();
  });
});
