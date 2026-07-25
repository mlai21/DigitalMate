import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/admin/data/clear/route";
import { readAttachment, saveAttachment } from "@/server/attachments/storage";
import type { UserDataLease } from "@/server/db/repositories";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const OWNED_KEY = "10000000-0000-4000-8000-000000000001";
const OTHER_KEY = "20000000-0000-4000-8000-000000000002";
const MATRIX_CONNECTION_ID =
  "30000000-0000-4000-8000-000000000003";

const mocks = vi.hoisted(() => ({
  callOrder: [] as string[],
  attachmentStorageDir: "",
  requireCurrentUser: vi.fn(async () => ({ id: USER_ID })),
  disconnectUser: vi.fn(async () => mocks.releaseConnectionDrain),
  releaseConnectionDrain: vi.fn(),
  hasEnabledChannelConnections: vi.fn(async () => false),
  listAttachmentStorageKeys: vi.fn(async () => [OWNED_KEY]),
  listMatrixConnectionIds: vi.fn(async () => [
    MATRIX_CONNECTION_ID,
  ]),
  deleteMatrixCryptoStoreDirectory: vi.fn(async () => undefined),
  clear: vi.fn(async () => undefined),
  acquireUserMutationLock: vi.fn<(userId: string) => Promise<UserDataLease>>(),
  releaseUserMutationLock: vi.fn(async () => undefined),
  deleteArtifactTree: vi.fn(async () => undefined),
  createRepositories: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({
  requireCurrentUser: mocks.requireCurrentUser,
}));

vi.mock("@/server/admin/user-connections", () => ({
  userConnectionDisconnector: {
    disconnectUser: mocks.disconnectUser,
  },
}));

vi.mock("@/server/attachments/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/attachments/storage")>();
  return {
    ...actual,
    deleteAttachment: vi.fn(async (rootDirectory: string, storageKey: string) => {
      mocks.callOrder.push("attachment");
      return actual.deleteAttachment(rootDirectory, storageKey);
    }),
  };
});

vi.mock("@/server/config/env", () => ({
  readEnv: vi.fn(() => ({ attachmentStorageDir: mocks.attachmentStorageDir })),
}));

vi.mock(
  "@/server/channels/adapters/matrix/crypto-store",
  () => ({
    defaultMatrixCryptoStorageRoot: vi.fn(
      () => "/private/matrix/connections",
    ),
    deleteMatrixCryptoStoreDirectory:
      mocks.deleteMatrixCryptoStoreDirectory,
  }),
);

vi.mock("@/server/db/repositories", () => ({
  createRepositories: mocks.createRepositories,
}));

vi.mock("@/server/tasks/artifacts", () => ({
  defaultArtifactRoot: vi.fn(() => "/private/artifacts"),
  deleteArtifactTree: mocks.deleteArtifactTree,
}));

const roots: string[] = [];

describe("admin personal data clear route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.callOrder.length = 0;
    mocks.listAttachmentStorageKeys.mockResolvedValue([OWNED_KEY]);
    mocks.listAttachmentStorageKeys.mockImplementation(async () => {
      mocks.callOrder.push("enumerate");
      return [OWNED_KEY];
    });
    mocks.listMatrixConnectionIds.mockImplementation(async () => {
      mocks.callOrder.push("enumerate-matrix");
      return [MATRIX_CONNECTION_ID];
    });
    mocks.deleteMatrixCryptoStoreDirectory.mockImplementation(
      async () => {
        mocks.callOrder.push("matrix-store");
      },
    );
    mocks.hasEnabledChannelConnections.mockImplementation(async () => {
      mocks.callOrder.push("channel-shutdown");
      return false;
    });
    mocks.clear.mockImplementation(async () => {
      mocks.callOrder.push("database");
    });
    mocks.acquireUserMutationLock.mockImplementation(async () => {
      mocks.callOrder.push("lease");
      return {
        userId: USER_ID,
        epoch: "1",
        mode: "exclusive",
        release: mocks.releaseUserMutationLock,
      };
    });
    mocks.releaseUserMutationLock.mockImplementation(async () => {
      mocks.callOrder.push("release-lease");
    });
    mocks.deleteArtifactTree.mockImplementation(async () => {
      mocks.callOrder.push("artifacts");
    });
    mocks.requireCurrentUser.mockResolvedValue({ id: USER_ID });
    mocks.disconnectUser.mockImplementation(async () => {
      mocks.callOrder.push("disconnect");
      return mocks.releaseConnectionDrain;
    });
    mocks.releaseConnectionDrain.mockReset();
    mocks.releaseConnectionDrain.mockImplementation(() => {
      mocks.callOrder.push("release-drain");
    });
    mocks.createRepositories.mockReturnValue({
      userDataMutations: {
        acquireExclusiveClearLease: mocks.acquireUserMutationLock,
      },
      personalData: {
        hasEnabledChannelConnections: mocks.hasEnabledChannelConnections,
        listAttachmentStorageKeys: mocks.listAttachmentStorageKeys,
        listMatrixConnectionIds: mocks.listMatrixConnectionIds,
        clear: mocks.clear,
      },
    });
  });

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("deletes only the authenticated user's listed attachment files before database clear", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "digitalmate-clear-"));
    roots.push(root);
    mocks.attachmentStorageDir = root;
    await saveAttachment(root, OWNED_KEY, Buffer.from("owned"));
    await saveAttachment(root, OTHER_KEY, Buffer.from("other-user"));

    const response = await POST(new Request("http://localhost/api/admin/data/clear", { method: "POST" }));

    expect(response.status).toBe(303);
    expect(mocks.listAttachmentStorageKeys).toHaveBeenCalledWith(USER_ID);
    expect(mocks.listMatrixConnectionIds).toHaveBeenCalledWith(
      USER_ID,
    );
    expect(
      mocks.deleteMatrixCryptoStoreDirectory,
    ).toHaveBeenCalledWith(
      "/private/matrix/connections",
      MATRIX_CONNECTION_ID,
    );
    expect(mocks.clear).toHaveBeenCalledWith(USER_ID);
    expect(mocks.acquireUserMutationLock).toHaveBeenCalledWith(USER_ID);
    expect(mocks.disconnectUser).toHaveBeenCalledWith(USER_ID);
    expect(mocks.releaseUserMutationLock).toHaveBeenCalledTimes(1);
    expect(mocks.releaseConnectionDrain).toHaveBeenCalledTimes(1);
    expect(mocks.callOrder).toEqual([
      "lease",
      "channel-shutdown",
      "disconnect",
      "enumerate",
      "attachment",
      "enumerate-matrix",
      "matrix-store",
      "artifacts",
      "database",
      "release-drain",
      "release-lease",
    ]);
    await expect(readAttachment(root, OWNED_KEY)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readAttachment(root, OTHER_KEY)).resolves.toEqual(Buffer.from("other-user"));
  });

  it("refuses to clear while any channel connection remains enabled", async () => {
    mocks.hasEnabledChannelConnections.mockImplementationOnce(async () => {
      mocks.callOrder.push("channel-shutdown");
      return true;
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST(new Request("http://localhost/api/admin/data/clear", { method: "POST" }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "personal_data_clear_failed" });
    expect(mocks.disconnectUser).not.toHaveBeenCalled();
    expect(mocks.listAttachmentStorageKeys).not.toHaveBeenCalled();
    expect(mocks.deleteArtifactTree).not.toHaveBeenCalled();
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(mocks.releaseUserMutationLock).toHaveBeenCalledTimes(1);
    expect(mocks.callOrder).toEqual([
      "lease",
      "channel-shutdown",
      "release-lease",
    ]);
    consoleError.mockRestore();
  });

  it("keeps all locator rows when channel shutdown confirmation fails", async () => {
    mocks.hasEnabledChannelConnections.mockImplementationOnce(async () => {
      mocks.callOrder.push("channel-shutdown");
      throw new Error("channel_shutdown_failed");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST(new Request("http://localhost/api/admin/data/clear", { method: "POST" }));

    expect(response.status).toBe(500);
    expect(mocks.disconnectUser).not.toHaveBeenCalled();
    expect(mocks.listAttachmentStorageKeys).not.toHaveBeenCalled();
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(mocks.releaseUserMutationLock).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it("returns a stable failure instead of claiming success when physical deletion fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "digitalmate-clear-"));
    roots.push(root);
    mocks.attachmentStorageDir = root;
    mocks.listAttachmentStorageKeys.mockResolvedValueOnce(["not-a-valid-storage-key"]);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST(new Request("http://localhost/api/admin/data/clear", { method: "POST" }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "personal_data_clear_failed" });
    expect(response.headers.get("location")).toBeNull();
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(mocks.releaseConnectionDrain).toHaveBeenCalledTimes(1);
    expect(mocks.releaseUserMutationLock).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it("keeps all data and releases the mutation lock when disconnect fails before a successful retry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "digitalmate-clear-"));
    roots.push(root);
    mocks.attachmentStorageDir = root;
    await saveAttachment(root, OWNED_KEY, Buffer.from("owned"));
    let mutationLockHeld = false;
    let successfulAcquisitions = 0;
    mocks.acquireUserMutationLock.mockImplementation(async () => {
      if (mutationLockHeld) throw new Error("mutation_lock_still_held");
      mutationLockHeld = true;
      successfulAcquisitions += 1;
      return {
        userId: USER_ID,
        epoch: String(successfulAcquisitions),
        mode: "exclusive",
        release: vi.fn(async () => {
          mutationLockHeld = false;
          await mocks.releaseUserMutationLock();
        }),
      };
    });
    mocks.disconnectUser
      .mockImplementationOnce(async () => {
        mocks.callOrder.push("disconnect");
        throw new Error("disconnect_failed");
      })
      .mockImplementationOnce(async () => {
        mocks.callOrder.push("disconnect");
        return mocks.releaseConnectionDrain;
      });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const failedResponse = await POST(new Request("http://localhost/api/admin/data/clear", { method: "POST" }));

    expect(failedResponse.status).toBe(500);
    await expect(failedResponse.json()).resolves.toEqual({ error: "personal_data_clear_failed" });
    expect(mocks.listAttachmentStorageKeys).not.toHaveBeenCalled();
    expect(mocks.deleteArtifactTree).not.toHaveBeenCalled();
    expect(mocks.clear).not.toHaveBeenCalled();
    await expect(readAttachment(root, OWNED_KEY)).resolves.toEqual(Buffer.from("owned"));
    expect(mutationLockHeld).toBe(false);
    expect(successfulAcquisitions).toBe(1);
    expect(mocks.releaseUserMutationLock).toHaveBeenCalledTimes(1);

    const retryResponse = await POST(new Request("http://localhost/api/admin/data/clear", { method: "POST" }));

    expect(retryResponse.status).toBe(303);
    expect(successfulAcquisitions).toBe(2);
    expect(mocks.releaseUserMutationLock).toHaveBeenCalledTimes(2);
    expect(mocks.listAttachmentStorageKeys).toHaveBeenCalledTimes(1);
    expect(mocks.deleteArtifactTree).toHaveBeenCalledTimes(1);
    expect(mocks.clear).toHaveBeenCalledTimes(1);
    await expect(readAttachment(root, OWNED_KEY)).rejects.toMatchObject({ code: "ENOENT" });
    consoleError.mockRestore();
  });

  it("does not clear database rows when artifact deletion fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "digitalmate-clear-"));
    roots.push(root);
    mocks.attachmentStorageDir = root;
    await saveAttachment(root, OWNED_KEY, Buffer.from("owned"));
    mocks.deleteArtifactTree.mockRejectedValueOnce(new Error("artifact deletion unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST(new Request("http://localhost/api/admin/data/clear", { method: "POST" }));

    expect(response.status).toBe(500);
    await expect(readAttachment(root, OWNED_KEY)).rejects.toMatchObject({ code: "ENOENT" });
    expect(mocks.deleteArtifactTree).toHaveBeenCalledWith("/private/artifacts", USER_ID);
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(mocks.releaseConnectionDrain).toHaveBeenCalledTimes(1);
    expect(mocks.releaseUserMutationLock).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it("treats a missing attachment as an idempotent retry and continues clearing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "digitalmate-clear-"));
    roots.push(root);
    mocks.attachmentStorageDir = root;

    const response = await POST(new Request("http://localhost/api/admin/data/clear", { method: "POST" }));

    expect(response.status).toBe(303);
    expect(mocks.deleteArtifactTree).toHaveBeenCalledTimes(1);
    expect(mocks.clear).toHaveBeenCalledTimes(1);
    expect(mocks.releaseConnectionDrain).toHaveBeenCalledTimes(1);
    expect(mocks.releaseUserMutationLock).toHaveBeenCalledTimes(1);
  });

  it("can retry after a database rollback even when physical files were already removed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "digitalmate-clear-"));
    roots.push(root);
    mocks.attachmentStorageDir = root;
    await saveAttachment(root, OWNED_KEY, Buffer.from("owned"));
    mocks.clear
      .mockImplementationOnce(async () => {
        mocks.callOrder.push("database");
        throw new Error("database_failed");
      })
      .mockImplementationOnce(async () => {
        mocks.callOrder.push("database");
      });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const failed = await POST(new Request("http://localhost/api/admin/data/clear", { method: "POST" }));
    const retried = await POST(new Request("http://localhost/api/admin/data/clear", { method: "POST" }));

    expect(failed.status).toBe(500);
    expect(retried.status).toBe(303);
    expect(mocks.clear).toHaveBeenCalledTimes(2);
    expect(mocks.releaseConnectionDrain).toHaveBeenCalledTimes(2);
    expect(mocks.releaseUserMutationLock).toHaveBeenCalledTimes(2);
    await expect(readAttachment(root, OWNED_KEY)).rejects.toMatchObject({ code: "ENOENT" });
    consoleError.mockRestore();
  });

  it("keeps the successful response and releases the lease when drain release throws", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "digitalmate-clear-"));
    roots.push(root);
    mocks.attachmentStorageDir = root;
    mocks.releaseConnectionDrain.mockImplementationOnce(() => {
      mocks.callOrder.push("release-drain");
      throw new Error("SENTINEL_DRAIN_RELEASE_SECRET");
    });
    const consoleError = vi.spyOn(console, "error")
      .mockImplementation(() => undefined);
    let response: Response | undefined;
    let caught: unknown;

    try {
      response = await POST(
        new Request(
          "http://localhost/api/admin/data/clear",
          { method: "POST" },
        ),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeUndefined();
    expect(response?.status).toBe(303);
    expect(mocks.releaseConnectionDrain).toHaveBeenCalledTimes(1);
    expect(mocks.releaseUserMutationLock).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      "user_connection_drain_release_failed",
      { code: "user_connection_drain_release_failed" },
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
      "SENTINEL_DRAIN_RELEASE_SECRET",
    );
    consoleError.mockRestore();
  });

  it("keeps the original failure response and releases the lease when drain release throws", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "digitalmate-clear-"));
    roots.push(root);
    mocks.attachmentStorageDir = root;
    mocks.deleteArtifactTree.mockRejectedValueOnce(
      new Error("SENTINEL_PRIMARY_FAILURE_SECRET"),
    );
    mocks.releaseConnectionDrain.mockImplementationOnce(() => {
      mocks.callOrder.push("release-drain");
      throw new Error("SENTINEL_DRAIN_RELEASE_SECRET");
    });
    const consoleError = vi.spyOn(console, "error")
      .mockImplementation(() => undefined);
    let response: Response | undefined;
    let caught: unknown;

    try {
      response = await POST(
        new Request(
          "http://localhost/api/admin/data/clear",
          { method: "POST" },
        ),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeUndefined();
    expect(response?.status).toBe(500);
    await expect(response?.json()).resolves.toEqual({
      error: "personal_data_clear_failed",
    });
    expect(mocks.releaseConnectionDrain).toHaveBeenCalledTimes(1);
    expect(mocks.releaseUserMutationLock).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      "user_connection_drain_release_failed",
      { code: "user_connection_drain_release_failed" },
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toMatch(
      /SENTINEL_PRIMARY_FAILURE_SECRET|SENTINEL_DRAIN_RELEASE_SECRET/,
    );
    consoleError.mockRestore();
  });

  it("does not let either release failure escape or suppress the other release", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "digitalmate-clear-"));
    roots.push(root);
    mocks.attachmentStorageDir = root;
    mocks.releaseConnectionDrain.mockImplementationOnce(() => {
      mocks.callOrder.push("release-drain");
      throw new Error("SENTINEL_DRAIN_RELEASE_SECRET");
    });
    mocks.releaseUserMutationLock.mockImplementationOnce(async () => {
      mocks.callOrder.push("release-lease");
      throw new Error("SENTINEL_LEASE_RELEASE_SECRET");
    });
    const consoleError = vi.spyOn(console, "error")
      .mockImplementation(() => undefined);
    let response: Response | undefined;
    let caught: unknown;

    try {
      response = await POST(
        new Request(
          "http://localhost/api/admin/data/clear",
          { method: "POST" },
        ),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeUndefined();
    expect(response?.status).toBe(303);
    expect(mocks.releaseConnectionDrain).toHaveBeenCalledTimes(1);
    expect(mocks.releaseUserMutationLock).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      "user_connection_drain_release_failed",
      { code: "user_connection_drain_release_failed" },
    );
    expect(consoleError).toHaveBeenCalledWith(
      "user_data_clear_lease_release_failed",
      { code: "user_data_clear_lease_release_failed" },
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toMatch(
      /SENTINEL_DRAIN_RELEASE_SECRET|SENTINEL_LEASE_RELEASE_SECRET/,
    );
    consoleError.mockRestore();
  });
});
