import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readEnv } from "@/server/config/env";
import {
  cleanupAttachmentTemporaryFile,
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

  it("creates or tightens the private directory to 0700 and files to 0600", async () => {
    const parent = await createTemporaryRoot();
    const root = path.join(parent, "not-created-yet");
    const firstKey = createAttachmentStorageKey();

    await saveAttachment(root, firstKey, Buffer.from("first"));

    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(root, firstKey))).mode & 0o777).toBe(0o600);

    await chmod(root, 0o755);
    const secondKey = createAttachmentStorageKey();
    await saveAttachment(root, secondKey, Buffer.from("second"));

    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(root, secondKey))).mode & 0o777).toBe(0o600);
  });

  it("never overwrites when concurrent saves use the same storage key", async () => {
    const root = await createTemporaryRoot();
    const storageKey = createAttachmentStorageKey();

    const results = await Promise.allSettled([
      saveAttachment(root, storageKey, Buffer.from("first")),
      saveAttachment(root, storageKey, Buffer.from("second")),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection).toMatchObject({ status: "rejected", reason: { code: "EEXIST" } });
    expect(["first", "second"]).toContain((await readAttachment(root, storageKey)).toString());
  });

  it("publishes the final path atomically so readers never observe an empty placeholder", async () => {
    const root = await createTemporaryRoot();
    const storageKey = createAttachmentStorageKey();
    const bytes = Buffer.alloc(10 * 1024 * 1024, 0x61);
    let finished = false;
    const observedSizes: number[] = [];

    const save = saveAttachment(root, storageKey, bytes).finally(() => {
      finished = true;
    });
    while (!finished) {
      try {
        observedSizes.push((await stat(path.join(root, storageKey))).size);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await save;

    observedSizes.push((await stat(path.join(root, storageKey))).size);
    expect(observedSizes).not.toContain(0);
    expect(new Set(observedSizes)).toEqual(new Set([bytes.length]));
  });

  it("does not delete or alter a pre-existing target when publication returns EEXIST", async () => {
    const root = await createTemporaryRoot();
    const storageKey = createAttachmentStorageKey();
    await saveAttachment(root, storageKey, Buffer.from("original"));

    await expect(saveAttachment(root, storageKey, Buffer.from("replacement"))).rejects.toMatchObject({
      code: "EEXIST",
    });
    await expect(readAttachment(root, storageKey)).resolves.toEqual(Buffer.from("original"));
  });

  it("does not let temporary cleanup failure replace the primary publication error", async () => {
    const primaryError = Object.assign(new Error("target exists"), { code: "EEXIST" });

    await expect(
      cleanupAttachmentTemporaryFile("/private/temp", primaryError, async () => {
        throw new Error("sensitive cleanup failure");
      }),
    ).resolves.toBeUndefined();
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
    const defaultDirectory = path.join(process.cwd(), "data", "attachments");

    expect(readEnv({}).attachmentStorageDir).toBe(defaultDirectory);
    expect(readEnv({ ATTACHMENT_STORAGE_DIR: "" }).attachmentStorageDir).toBe(defaultDirectory);
    expect(readEnv({ ATTACHMENT_STORAGE_DIR: "   " }).attachmentStorageDir).toBe(defaultDirectory);
    expect(readEnv({ ATTACHMENT_STORAGE_DIR: "/srv/private-attachments" }).attachmentStorageDir).toBe(
      "/srv/private-attachments",
    );
  });
});
