import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readEnv } from "@/server/config/env";
import {
  createAttachmentStorageKey,
  deleteAttachment,
  readAttachment,
  saveAttachment,
} from "@/server/attachments/storage";

const temporaryRoots: string[] = [];

async function createTemporaryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "digitalmate-attachments-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("private attachment storage", () => {
  it("saves, reads, and deletes a UUID-keyed attachment atomically", async () => {
    const root = await createTemporaryRoot();
    const storageKey = createAttachmentStorageKey();
    const bytes = Buffer.from("private attachment");

    await saveAttachment(root, storageKey, bytes);

    await expect(readAttachment(root, storageKey)).resolves.toEqual(bytes);
    expect(await readdir(root)).toEqual([storageKey]);

    await deleteAttachment(root, storageKey);
    await expect(readAttachment(root, storageKey)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(deleteAttachment(root, storageKey)).resolves.toBeUndefined();
  });

  it.each(["../../secret", "not-a-uuid", "00000000-0000-0000-0000-000000000000"])(
    "rejects a non-generated storage key: %s",
    async (storageKey) => {
      const root = await createTemporaryRoot();

      await expect(saveAttachment(root, storageKey, Buffer.from("x"))).rejects.toThrow(
        "attachment_invalid_storage_key",
      );
      await expect(readAttachment(root, storageKey)).rejects.toThrow(
        "attachment_invalid_storage_key",
      );
      await expect(deleteAttachment(root, storageKey)).rejects.toThrow(
        "attachment_invalid_storage_key",
      );
    },
  );

  it("uses a private local attachment directory by default and accepts an override", () => {
    expect(readEnv({}).attachmentStorageDir).toBe(
      path.join(process.cwd(), "data", "attachments"),
    );
    expect(readEnv({ ATTACHMENT_STORAGE_DIR: "/srv/private-attachments" }).attachmentStorageDir).toBe(
      "/srv/private-attachments",
    );
  });
});
