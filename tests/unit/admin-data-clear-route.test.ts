import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/admin/data/clear/route";
import { readAttachment, saveAttachment } from "@/server/attachments/storage";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const OWNED_KEY = "10000000-0000-4000-8000-000000000001";
const OTHER_KEY = "20000000-0000-4000-8000-000000000002";

const mocks = vi.hoisted(() => ({
  attachmentStorageDir: "",
  requireCurrentUser: vi.fn(async () => ({ id: USER_ID })),
  listAttachmentStorageKeys: vi.fn(async () => [OWNED_KEY]),
  clear: vi.fn(async () => undefined),
  acquireUserMutationLock: vi.fn(async () => vi.fn(async () => undefined)),
  releaseUserMutationLock: vi.fn(async () => undefined),
  deleteArtifactTree: vi.fn(async () => undefined),
  createRepositories: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({
  requireCurrentUser: mocks.requireCurrentUser,
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
    mocks.listAttachmentStorageKeys.mockResolvedValue([OWNED_KEY]);
    mocks.clear.mockResolvedValue(undefined);
    mocks.acquireUserMutationLock.mockImplementation(async () => mocks.releaseUserMutationLock);
    mocks.releaseUserMutationLock.mockResolvedValue(undefined);
    mocks.deleteArtifactTree.mockResolvedValue(undefined);
    mocks.requireCurrentUser.mockResolvedValue({ id: USER_ID });
    mocks.createRepositories.mockReturnValue({
      personalData: {
        listAttachmentStorageKeys: mocks.listAttachmentStorageKeys,
        clear: mocks.clear,
      },
      messageAttachments: {
        acquireUserMutationLock: mocks.acquireUserMutationLock,
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
    expect(mocks.releaseUserMutationLock).toHaveBeenCalledTimes(1);
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

  it("deletes attachment files first so a database failure remains safely retryable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "digitalmate-clear-"));
    roots.push(root);
    mocks.attachmentStorageDir = root;
    await saveAttachment(root, OWNED_KEY, Buffer.from("owned"));
    mocks.clear.mockRejectedValueOnce(new Error("database unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST(new Request("http://localhost/api/admin/data/clear", { method: "POST" }));

    expect(response.status).toBe(500);
    await expect(readAttachment(root, OWNED_KEY)).rejects.toMatchObject({ code: "ENOENT" });
    expect(mocks.deleteArtifactTree).not.toHaveBeenCalled();
    expect(mocks.releaseUserMutationLock).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});
