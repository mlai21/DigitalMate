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

const mocks = vi.hoisted(() => ({
  callOrder: [] as string[],
  attachmentStorageDir: "",
  requireCurrentUser: vi.fn(async () => ({ id: USER_ID })),
  disconnectUser: vi.fn(async () => mocks.releaseConnectionDrain),
  releaseConnectionDrain: vi.fn(),
  listAttachmentStorageKeys: vi.fn(async () => [OWNED_KEY]),
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

vi.mock("@/server/config/env", () => ({
  readEnv: vi.fn(() => ({ attachmentStorageDir: mocks.attachmentStorageDir })),
}));

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
    mocks.clear.mockImplementation(async () => {
      mocks.callOrder.push("database");
    });
    mocks.acquireUserMutationLock.mockImplementation(async () => ({
      userId: USER_ID,
      epoch: "1",
      mode: "exclusive",
      release: mocks.releaseUserMutationLock,
    }));
    mocks.releaseUserMutationLock.mockResolvedValue(undefined);
    mocks.deleteArtifactTree.mockImplementation(async () => {
      mocks.callOrder.push("artifacts");
    });
    mocks.requireCurrentUser.mockResolvedValue({ id: USER_ID });
    mocks.disconnectUser.mockImplementation(async () => {
      mocks.callOrder.push("disconnect");
      return mocks.releaseConnectionDrain;
    });
    mocks.releaseConnectionDrain.mockReset();
    mocks.createRepositories.mockReturnValue({
      userDataMutations: {
        acquireExclusiveClearLease: mocks.acquireUserMutationLock,
      },
      personalData: {
        listAttachmentStorageKeys: mocks.listAttachmentStorageKeys,
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
    expect(mocks.clear).toHaveBeenCalledWith(USER_ID);
    expect(mocks.acquireUserMutationLock).toHaveBeenCalledWith(USER_ID);
    expect(mocks.disconnectUser).toHaveBeenCalledWith(USER_ID);
    expect(mocks.releaseUserMutationLock).toHaveBeenCalledTimes(1);
    expect(mocks.releaseConnectionDrain).toHaveBeenCalledTimes(1);
    expect(mocks.callOrder).toEqual(["disconnect", "artifacts", "database"]);
    await expect(readAttachment(root, OWNED_KEY)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readAttachment(root, OTHER_KEY)).resolves.toEqual(Buffer.from("other-user"));
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
    expect(mocks.releaseUserMutationLock).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});
